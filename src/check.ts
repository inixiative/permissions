import {
  type Bridge,
  type BridgeDictionary,
  type Condition,
  check as checkRule,
  indexBridges,
  listBindings,
  type RuleValue,
} from '@inixiative/json-rules';
import { isNil } from 'lodash-es';
import type {
  ActionRule,
  Actor,
  PermixLike,
  Position,
  RebacSchema,
  ResolveRelation,
  Row,
  Subject,
} from './types';

// Stable identity for cycle detection that does NOT depend on `record.id` — an id may be absent or
// collide across resources, both of which would make an id-based key falsely report a cycle. A
// WeakMap assigns each visited object a process-unique number; entries are GC'd with the objects.
const identity = (): ((value: object) => number) => {
  let counter = 0;
  const ids = new WeakMap<object, number>();
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = ++counter;
      ids.set(value, id);
    }
    return id;
  };
};
const nodeId = identity();
const tableId = identity();

// An entitlement's owner walk runs on a slice of the owner's table (its grants, the request's
// actor). The slice is a fresh object per walk, so for cycle detection it resolves back to the
// table it was cut from: the same table re-entering the same node and action is a loop.
const origin = new WeakMap<PermixLike, PermixLike>();
const permixId = (permix: PermixLike): number => tableId(origin.get(permix) ?? permix);

const asOwner = (owner: PermixLike, actor: Actor | null): PermixLike => {
  const slice: PermixLike = {
    check: (resource, action, id, data) => owner.check(resource, action, id, data),
    isSuperadmin: () => owner.isSuperadmin?.() ?? false,
    entitlements: (resource, action) => owner.entitlements?.(resource, action) ?? [],
    getActor: () => actor,
  };
  origin.set(slice, origin.get(owner) ?? owner);
  return slice;
};

// A `where` is literals and record paths only — whatever referred to the holder was written in
// when the entitlement was granted — so it needs no bindings and nothing about the actor. An
// absent path reads as NULL: write `where` positively, a negation passes on what is not loaded.
const holds = (where: Condition | null, record: Row): boolean =>
  where !== null && checkRule(where, record) === true;

// The relations a resource's own rules walk: the first segment of every `rel` arm, any depth.
const parentFieldsOf = new WeakMap<object, Set<string>>();
const parentFields = (schema: RebacSchema<string>, resource: string): Set<string> => {
  const actions = schema.permissions[resource]?.actions;
  if (!actions) return new Set();
  const cached = parentFieldsOf.get(actions);
  if (cached) return cached;
  const fields = new Set<string>();
  const visit = (rule: ActionRule): void => {
    if (!rule || typeof rule !== 'object') return;
    if ('rel' in rule) fields.add(rule.rel.split('.')[0]);
    else if ('any' in rule) rule.any.forEach(visit);
    else if ('all' in rule) rule.all.forEach(visit);
  };
  Object.values(actions).forEach(visit);
  parentFieldsOf.set(actions, fields);
  return fields;
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

// The actor's fields, as the `actor.<field>` binds a `{ rule }` may compare a record against.
const actorBindings = (actor: Actor | null): Record<string, RuleValue> =>
  actor
    ? Object.fromEntries(Object.entries(actor).map(([k, v]) => [`actor.${k}`, v as RuleValue]))
    : {};

// Optional binds included: with nobody acting, `ownerId notEquals actor.id` must not pass on null.
const readsActor = (condition: Parameters<typeof listBindings>[0]): boolean =>
  listBindings(condition).some((name) => name.startsWith('actor.'));

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
 * ABAC predicate over the record (the actor's fields bound as `actor.<field>`), `{ actor }` one over the actor, `{ self, action }` matches the actor and checks `action` on its own entry, `any`/`all` compose. Cycles throw rather than loop.
 */
export type RebacCheckOptions<R extends string = string> = {
  /** The resource holding the actor's own entry; a `{ self, action }` arm checks `action` there. */
  selfResource?: R;
};

export const createRebacCheck = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
  options: RebacCheckOptions<R> = {},
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
    if (isNil(actionOrRule)) return false; // null = terminal deny
    if (typeof actionOrRule === 'boolean') return actionOrRule; // true = allow, false = deny

    if (typeof actionOrRule === 'string') {
      // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
      if (permix.check(resource, actionOrRule, recordId(record))) return true;

      // Key by resource too: the same record object reached as a different resource (a self-join) is
      // a distinct node, not a cycle. Key by table too: an owner walk legitimately revisits the node.
      const key = `${permixId(permix)}:${nodeId(record)}:${resource}:${actionOrRule}`;
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
      if (evaluate(permix, schema, getDict, resource, record, merged, visited)) return true;
      return entitled(permix, schema, getDict, resource, record, actionOrRule, visited);
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
      if (typeof rule.action !== 'string')
        throw new Error(
          `A self arm must name an action: { self: '${rule.self}', action: '<action on the actor itself>' }`,
        );
      if (!options.selfResource)
        throw new Error('A self arm needs createRebacCheck(resolveRelation, { selfResource })');
      const userId = permix.getActor()?.id ?? null;
      if (userId === null || record[rule.self] !== userId) return false;
      const selfKey = `self:${permixId(permix)}:${options.selfResource}:${userId}:${rule.action}`;
      if (visited.has(selfKey)) {
        throw new Error(
          `Cycle detected in permission graph: ${options.selfResource}.${rule.action}`,
        );
      }
      visited.add(selfKey);
      return evaluate(
        permix,
        schema,
        getDict,
        options.selfResource,
        { id: userId },
        rule.action,
        visited,
      );
    }

    if ('actor' in rule) {
      const actor = permix.getActor();
      return actor !== null && checkRule(rule.actor, actor as Row) === true;
    }

    if ('rule' in rule) {
      const actor = permix.getActor();
      // No actor to compare against: a rule that reads one denies rather than throwing.
      if (actor === null && readsActor(rule.rule)) return false;
      return checkRule(rule.rule, record, { bindings: actorBindings(actor) }) === true;
    }
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

  // The position is the record itself or an ancestor on the resource's natural tree: the relations
  // the schema's own `rel` arms name for that resource, nothing else. A hydrated sideways foreign
  // key (`replacedBy`, `defaultIntegration`) is not a position. Off the tree, the entitlement is
  // not acting from where it says.
  const onPath = (
    schema: RebacSchema<R>,
    resource: R,
    record: Row,
    from: Position,
    seen: WeakSet<object> = new WeakSet(),
  ): boolean => {
    if (seen.has(record)) return false;
    seen.add(record);
    if (resource === from.resource && recordId(record) === from.id) return true;
    return [...parentFields(schema, resource)].some((field) => {
      const value = record[field];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
      const next = resolveRelation(resource, field);
      return next !== null && onPath(schema, next, value as Row, from, seen);
    });
  };

  // Entitlements are consulted after the table and the schema both miss, at the node the holder's
  // own walk reached, with the record in hand. One applies when its position is on the record's
  // path, its `where` holds, and whoever granted it can still do the action on this record: the
  // owner's own table, walked from here. A space moved to another org stops reaching its grantor.
  // An owner that is already on this walk for this node and action is a loop built from grant
  // data, not a schema bug: it denies instead of throwing, so it can never hide a sibling.
  const entitled = (
    permix: PermixLike,
    schema: RebacSchema<R>,
    getDict: () => BridgeDictionary | undefined,
    resource: R,
    record: Row,
    action: string,
    visited: Set<string>,
  ): boolean => {
    const actor = permix.getActor();
    return (permix.entitlements?.(resource, action) ?? []).some(
      ({ from, where, owner }) =>
        !visited.has(`${permixId(owner)}:${nodeId(record)}:${resource}:${action}`) &&
        onPath(schema, resource, record, from) &&
        (where === undefined || holds(where, record)) &&
        evaluate(
          asOwner(owner, actor),
          schema,
          getDict,
          resource,
          record,
          action,
          new Set(visited),
        ),
    );
  };

  return (permix, schema, subject, actionOrRule, visited = new Set()) => {
    // Built lazily on the first bridge hop: a check that never crosses a bridge must not pay for —
    // or be crashed by (indexBridges throws on malformed `data`) — a dictionary it never reads.
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
