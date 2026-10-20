import {
  type Bridge,
  type BridgeDictionary,
  check as checkRule,
  indexBridges,
} from '@inixiative/json-rules';
import { isNil } from 'lodash-es';
import { defaultSelfId } from './actor';
import type {
  ActionRule,
  Actor,
  CollectionCheck,
  PermixExpression,
  PermixLike,
  RebacSchema,
  ResolveRelation,
  Row,
  Subject,
} from './types';

// Stable identity for cycle detection that does NOT depend on `record.id` — an id may be absent or
// collide across resources, both of which would make an id-based key falsely report a cycle. A
// WeakMap assigns each visited record object a process-unique number; entries are GC'd with records.
let nodeCounter = 0;
const nodeIds = new WeakMap<object, number>();
const nodeId = (record: object): number => {
  let id = nodeIds.get(record);
  if (id === undefined) {
    id = ++nodeCounter;
    nodeIds.set(record, id);
  }
  return id;
};

const splitResource = (resource: string): [string, string] => {
  const i = resource.indexOf(':');
  return i === -1 ? ['', resource] : [resource.slice(0, i), resource.slice(i + 1)];
};

// permix keys grants by string id; coerce so a numeric `record.id` matches (the bridge path
// already does `String(farId)` — keep the direct path consistent).
const recordId = (record: Row): string | undefined =>
  record.id == null ? undefined : String(record.id);

type BridgeHop = {
  farResource: string;
  localOn: string;
  farMap: string;
  farModel: string;
  farOn: string;
};

// A relation segment is a bridge when it names the OTHER endpoint's `map:model`. The local join key
// is this endpoint's `on` (a scalar already on the record); the far record joins on the other `on`.
export const bridgeHop = (
  bridges: Bridge[] | undefined,
  resource: string,
  segment: string,
): BridgeHop | null => {
  const [map, model] = splitResource(resource);
  for (const b of bridges ?? []) {
    const [a, c] = b.endpoints;
    const aKey = `${a.fieldMap}:${a.model}`;
    const cKey = `${c.fieldMap}:${c.model}`;
    // a → c. For `oneToMany`, c is the "many" side (endpoints[1]) — a single-record permission check
    // can't span a list, so this direction is NOT walkable; it would otherwise collapse to an
    // arbitrary `found[0]` (a non-deterministic wrong-allow). `oneToOne` is symmetric → walkable.
    if (a.fieldMap === map && a.model === model && cKey === segment) {
      if (b.cardinality === 'oneToMany') continue; // to-one walks only
      return {
        farResource: cKey,
        localOn: a.on,
        farMap: c.fieldMap,
        farModel: c.model,
        farOn: c.on,
      };
    }
    // c → a. The far endpoint a is the "one" side (oneToMany) or symmetric (oneToOne) — always to-one.
    if (c.fieldMap === map && c.model === model && aKey === segment) {
      return {
        farResource: aKey,
        localOn: c.on,
        farMap: a.fieldMap,
        farModel: a.model,
        farOn: a.on,
      };
    }
  }
  return null;
};

const lookupFar = (
  dict: BridgeDictionary | undefined,
  hop: BridgeHop,
  farId: string,
): Row | undefined => {
  const found = dict?.[hop.farMap]?.[hop.farModel]?.[hop.farOn]?.[farId];
  if (found === undefined) return undefined;
  return Array.isArray(found) ? found[0] : found; // many→one: the single far row
};

/** A permission graph that loops. From the schema it is a programmer error; from data it denies. */
export class PermissionCycleError extends Error {
  constructor(at: string) {
    super(`Cycle detected in permission graph: ${at}`);
    this.name = 'PermissionCycleError';
  }
}

/** Evaluate a rule that came from data (a row's `permissionRules`, a rule-valued grant): a cycle denies. */
export const denyOnDataCycle = (evaluateArm: () => boolean): boolean => {
  try {
    return evaluateArm();
  } catch (error) {
    if (error instanceof PermissionCycleError) return false;
    throw error;
  }
};

export type RebacCheck<R extends string = string> = (
  permix: PermixExpression,
  schema: RebacSchema<R>,
  subject: Subject<R>,
  actionOrRule: ActionRule | CollectionCheck,
  visited?: Set<string>,
) => boolean;

export const isPermixLeaf = <P extends PermixLike>(
  expression: PermixExpression<P>,
): expression is P => typeof (expression as PermixLike).check === 'function';

export const isCollectionCheck = (value: ActionRule | CollectionCheck): value is CollectionCheck =>
  typeof value === 'object' && value !== null && 'collection' in value;

/** A collection's rule, or `null` (deny) when the resource declares none. */
export const collectionRule = <R extends string>(
  schema: RebacSchema<R>,
  resource: R,
  name: string,
): ActionRule => schema.permissions[resource]?.collections?.[name] ?? null;

/**
 * Build the rebac check, bound to an intra-map relation resolver.
 *
 * `resolveRelation(resource, segment)` maps a hydrated relation field to the resource it points at
 * (the ORM-specific seam the app injects). Cross-source `rel` hops are resolved by the engine from
 * `schema.bridges`. A `string` delegates (a held permix action, a rule-valued grant, the row's
 * `permissionRules` or the schema rule, OR'd), `{ rule }` is an ABAC predicate over the record,
 * `{ actor }` one over the actor, `{ self }` matches the person behind the actor (and, with an
 * `action`, checks it on the actor's own entry), `any`/`all` compose. Cycles throw rather than loop.
 *
 * The returned check takes a permix expression: one permix, or `any` / `all` of several passes over
 * the same subject (one bridge dictionary shared). Its last argument may be `{ collection }` to
 * evaluate a collection rule instead of a row action.
 */
export type RebacCheckOptions<R extends string = string> = {
  /** The resource holding the actor's own entry; a `{ self, action }` arm checks `action` there. */
  selfResource?: R;
  /** The id a `{ self }` arm compares against. Defaults to the person behind the actor. */
  selfId?: (actor: Actor | null) => string | null;
};

export const createRebacCheck = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
  options: RebacCheckOptions<R> = {},
): RebacCheck<R> => {
  const selfIdOf = options.selfId ?? defaultSelfId;
  const evaluate = (
    permix: PermixLike,
    schema: RebacSchema<R>,
    getDict: () => BridgeDictionary | undefined,
    resource: R,
    record: Row,
    actionOrRule: ActionRule,
    visited: Set<string>,
  ): boolean => {
    if (permix.isSuperadmin?.()) return true;
    if (isNil(actionOrRule)) return false; // null = terminal deny
    if (typeof actionOrRule === 'boolean') return actionOrRule; // true = allow, false = deny

    if (typeof actionOrRule === 'string') {
      // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
      if (permix.check(resource, actionOrRule, recordId(record))) return true;

      // Key by resource too: the same record object reached as a different resource (a self-join) is
      // a distinct node, not a cycle.
      const key = `${nodeId(record)}:${resource}:${actionOrRule}`;
      if (visited.has(key)) {
        throw new PermissionCycleError(`${resource}.${actionOrRule}`);
      }
      visited.add(key);

      const schemaRule = schema.permissions[resource]?.actions[actionOrRule] ?? null;
      const rowRules = record.permissionRules as Record<string, ActionRule> | null | undefined;
      const rowRule = rowRules?.[actionOrRule];
      const id = recordId(record);
      // A rule-valued grant on the whole resource, or on this row, is a grant like a held action.
      const grantRules = (permix.rules?.(resource, actionOrRule) ?? [])
        .filter((entry) => entry.id === undefined || entry.id === id)
        .map((entry) => entry.rule);
      // Row-level overrides and rule-valued grants are additive (OR) with the schema rule: they only widen.
      if (evaluate(permix, schema, getDict, resource, record, schemaRule, new Set(visited)))
        return true;
      const dataArms = [...(rowRule !== undefined ? [rowRule] : []), ...grantRules];
      return dataArms.some((arm) =>
        denyOnDataCycle(() =>
          evaluate(permix, schema, getDict, resource, record, arm, new Set(visited)),
        ),
      );
    }

    const rule = actionOrRule;
    if ('rel' in rule && 'action' in rule) {
      const segments = rule.rel.split('.');
      let currentResource = resource;
      let current: Row = record;
      for (const segment of segments) {
        const hop = bridgeHop(schema.bridges, currentResource, segment);
        if (hop) {
          const farId = current[hop.localOn];
          if (isNil(farId)) return false;
          // Synthetic hop: the far record isn't hydrated. The join-key scalar is enough for an rbac
          // grant; the dictionary supplies its fields only when a downstream action needs them. The
          // scalar is the far record's `farOn` value — key it there, NOT unconditionally under `id`:
          // when the far join key is a non-id field, an id-keyed grant on an unrelated record whose
          // id merely equals the join value must not match (recordId() then finds no id to probe).
          current = lookupFar(getDict(), hop, String(farId)) ?? { [hop.farOn]: farId };
          currentResource = hop.farResource as R;
        } else {
          const related = current[segment] as Row | null | undefined;
          if (!related || Array.isArray(related)) return false;
          const next = resolveRelation(currentResource, segment);
          if (!next) return false;
          current = related;
          currentResource = next;
        }
      }
      return evaluate(permix, schema, getDict, currentResource, current, rule.action, visited);
    }

    if ('self' in rule) {
      const selfId = selfIdOf(permix.getActor());
      if (selfId === null || record[rule.self] !== selfId) return false;
      if (rule.action === undefined) return true; // identity only
      if (!options.selfResource)
        throw new Error(
          'A self arm with an action needs createRebacCheck(resolveRelation, { selfResource })',
        );
      const selfKey = `self:${options.selfResource}:${selfId}:${rule.action}`;
      if (visited.has(selfKey)) {
        throw new PermissionCycleError(`${options.selfResource}.${rule.action}`);
      }
      visited.add(selfKey);
      return evaluate(
        permix,
        schema,
        getDict,
        options.selfResource,
        { id: selfId },
        rule.action,
        visited,
      );
    }

    if ('actor' in rule) {
      const actor = permix.getActor();
      return actor !== null && checkRule(rule.actor, actor as Row) === true;
    }

    if ('rule' in rule) return checkRule(rule.rule, record) === true;
    // Fork `visited` per branch — parallel paths through any/all aren't cycles.
    if ('any' in rule) {
      return rule.any.some((r) =>
        evaluate(permix, schema, getDict, resource, record, r, new Set(visited)),
      );
    }
    if ('all' in rule) {
      return rule.all.every((r) =>
        evaluate(permix, schema, getDict, resource, record, r, new Set(visited)),
      );
    }

    return false;
  };

  return (expression, schema, subject, actionOrRule, visited = new Set()) => {
    // Built lazily on the first bridge hop and shared by every pass: a check that never crosses a
    // bridge must not pay for (or be crashed by) a dictionary it never reads.
    let built = false;
    let dict: BridgeDictionary | undefined;
    const getDict = (): BridgeDictionary | undefined => {
      if (!built) {
        built = true;
        dict = schema.bridges?.length
          ? indexBridges({ maps: {}, bridges: schema.bridges }, subject.data ?? {})
          : undefined;
      }
      return dict;
    };
    const rule = isCollectionCheck(actionOrRule)
      ? collectionRule(schema, subject.resource, actionOrRule.collection)
      : actionOrRule;
    const run = (node: PermixExpression): boolean => {
      if (isPermixLeaf(node))
        return evaluate(
          node,
          schema,
          getDict,
          subject.resource,
          subject.record,
          rule,
          new Set(visited),
        );
      if ('any' in node) return node.any.some(run);
      return node.all.every(run);
    };
    return run(expression);
  };
};
