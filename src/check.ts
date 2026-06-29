import { type Bridge, buildBridgeDictionary, check as checkRule } from '@inixiative/json-rules';
import { isNil } from 'lodash-es';
import type { ActionRule, PermixLike, RebacSchema, ResolveRelation, Row, Subject } from './types';

type BridgeDictionary = ReturnType<typeof buildBridgeDictionary>;

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
const bridgeHop = (
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

export type RebacCheck<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  subject: Subject<R>,
  actionOrRule: ActionRule,
  visited?: Set<string>,
) => boolean;

/**
 * Build the rebac check, bound to an intra-map relation resolver.
 *
 * `resolveRelation(resource, segment)` maps a hydrated relation field to the resource it points at
 * (the ORM-specific seam the app injects). Cross-source `rel` hops are resolved by the engine from
 * `schema.bridges` — synthetically, via the join-key scalar on the record, looking the far row up in
 * a `BridgeDictionary` the engine builds from `subject.data` (only needed when a downstream action
 * reads the far record's fields). `string` delegates (rbac via permix or schema), `{ rule }` is an
 * ABAC predicate, `{ self }` matches the actor, `any`/`all` compose. Cycles throw rather than loop.
 */
export const createRebacCheck = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
): RebacCheck<R> => {
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
    if (isNil(actionOrRule)) return false;

    if (typeof actionOrRule === 'string') {
      // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
      if (permix.check(resource, actionOrRule, recordId(record))) return true;

      // Key by resource too: the same record object reached as a different resource (a self-join) is
      // a distinct node, not a cycle.
      const key = `${nodeId(record)}:${resource}:${actionOrRule}`;
      if (visited.has(key)) {
        throw new Error(`Cycle detected in permission graph: ${resource}.${actionOrRule}`);
      }
      visited.add(key);

      const schemaRule = schema.permissions[resource]?.actions[actionOrRule] ?? null;
      const rowRules = record.permissionRules as Record<string, ActionRule> | null | undefined;
      const rowRule = rowRules?.[actionOrRule];
      // Row-level override is additive (OR) with the schema rule — a per-record grant can only widen.
      const merged: ActionRule =
        rowRule !== undefined ? { any: [schemaRule, rowRule] } : schemaRule;
      return evaluate(permix, schema, getDict, resource, record, merged, visited);
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
          // grant; the dictionary supplies its fields only when a downstream action needs them.
          current = lookupFar(getDict(), hop, String(farId)) ?? { id: farId };
          currentResource = hop.farResource as R;
        } else {
          const related = current[segment] as Row | null | undefined;
          if (!related) return false;
          const next = resolveRelation(currentResource, segment);
          if (!next) return false;
          current = related;
          currentResource = next;
        }
      }
      return evaluate(permix, schema, getDict, currentResource, current, rule.action, visited);
    }

    if ('self' in rule) {
      const userId = permix.getUserId();
      return userId !== null && record[rule.self] === userId;
    }

    if ('rule' in rule) return checkRule(rule.rule, record) === true;
    // Fork `visited` per branch — parallel paths through any/all aren't cycles.
    if ('any' in rule) {
      return rule.any.some((r) =>
        evaluate(permix, schema, getDict, resource, record, r, new Set(visited)),
      );
    }
    if ('all' in rule) {
      // An empty `all` is NOT vacuously true — a security combinator must fail closed, and the
      // builder seeds a freshly-picked `all` as `[]` before children are added.
      return (
        rule.all.length > 0 &&
        rule.all.every((r) =>
          evaluate(permix, schema, getDict, resource, record, r, new Set(visited)),
        )
      );
    }

    return false;
  };

  return (permix, schema, subject, actionOrRule, visited = new Set()) => {
    // Built lazily on the first bridge hop: a check that never crosses a bridge must not pay for —
    // or be crashed by (buildBridgeDictionary throws on malformed `data`) — a dictionary it never reads.
    let built = false;
    let dict: BridgeDictionary | undefined;
    const getDict = (): BridgeDictionary | undefined => {
      if (!built) {
        built = true;
        dict = schema.bridges?.length
          ? buildBridgeDictionary({ maps: {}, bridges: schema.bridges }, subject.data ?? {})
          : undefined;
      }
      return dict;
    };
    return evaluate(
      permix,
      schema,
      getDict,
      subject.resource,
      subject.record,
      actionOrRule,
      visited,
    );
  };
};
