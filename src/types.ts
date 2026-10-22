import type { Bridge, Condition, Row } from '@inixiative/json-rules';

export type { Row };

export type RelationCheck = { rel: string; action: string }; // walk a relation, then check `action`
export type RuleCheck = { rule: Condition }; // ABAC predicate (json-rules) over the record
/**
 * `record[self]` is the actor's id AND the actor holds `action` on its own entry (the check's
 * `selfResource`, e.g. `db:user:<id>`). `action` is any action of that resource, custom ones included.
 */
export type SelfCheck = { self: string; action: string };
/** An ABAC predicate (json-rules) over the actor itself: `{ actor: { field: 'kind', … } }`. */
export type ActorCheck = { actor: Condition };

/**
 * Who is acting: an id plus whatever the app knows about them — plain data, like a record (what
 * kind of principal it is, the integration it is bound to, …). `{ self }` reads its `id`;
 * `{ actor }` evaluates a condition over it; `{ rule }` reads its fields as `actor.<field>` binds.
 * Give every actor the same fields (type them through `createPermissions<Action, YourActor>()`):
 * a rule that binds a field an actor lacks throws, and an `{ actor }` condition reads it as null.
 */
export type Actor = { id: string } & { [field: string]: ActorValue };

/** One flat actor field: a scalar or a list of ids. Flat, so `{ actor }` and `actor.<field>` binds read it alike. */
export type ActorValue = string | number | boolean | Date | null | readonly (string | number)[];

/** The serializable permission algebra: rebac (`rel`) + abac (`rule`) + rbac (`string` delegation). */
export type ActionRule =
  | string // delegate to another action on the same resource
  | RelationCheck
  | RuleCheck
  | SelfCheck
  | ActorCheck
  | { any: ActionRule[] } // OR
  | { all: ActionRule[] } // AND
  | boolean // terminal allow (`true`) / deny (`false`)
  | null; // terminal deny (equivalent to `false`)

/** One resource's permission entry: `actions: { name → ActionRule }`. */
export type ResourcePermission = { actions: Record<string, ActionRule> };

/**
 * The permission schema. `permissions` maps a (map-qualified) resource — e.g. `db:User` — to its
 * actions; `bridges` are the cross-source edges (json-rules `Bridge`s) a `rel` walk may traverse.
 * Generic over the resource key: defaults to `string`, or pass a narrow union (e.g. a map-qualified
 * AccessorName) and the schema, `subject.resource`, and resolver all enforce it.
 */
export type RebacSchema<R extends string = string> = {
  bridges?: Bridge[];
  permissions: Partial<Record<R, ResourcePermission>>;
};

/**
 * What the check evaluates against: the `record`, its (map-qualified) `resource`, and `data` —
 * supplemental hydrated rows per `map:model`, the same shape json-rules' `indexBridges`
 * takes. The check builds the bridge dictionary from `data` itself; `data` is only consulted when a
 * `rel` walk crosses a bridge and a downstream action reads the far record's fields.
 */
export type Subject<R extends string = string> = {
  resource: R;
  record: Row;
  data?: Record<string, Row[]>;
};

/**
 * Resolve an INTRA-map relation field to the resource it points at — the ORM-specific seam the app
 * injects (e.g. from a Prisma model map). Cross-source bridges are resolved by the engine from the
 * schema's `bridges`, not here. Returns `null` to abort the walk when the relation is unknown.
 */
export type ResolveRelation<R extends string = string> = (
  resource: R,
  relationSegment: string,
) => R | null;

/**
 * A holder's entitlements, keyed by grant key: `resource` is every row of it, `resource:<id>` is
 * that row. Each key maps an action to `true` or an {@link ActionRule} over the row. Turn them into
 * permix entries with `entitlementEntries`; where they take effect is the app's call (a holder's
 * keys land only where its owner reaches them).
 */
export type Entitlements = Record<string, Record<string, true | ActionRule>> | null;

/** A rule-valued entry: on the whole resource (no `id`) or on one row. */
export type RuleEntry = { id?: string; rule: ActionRule };

/** The slice of the permix wrapper the rebac check engine consumes. */
export type PermixLike = {
  check: (resource: string, action: string, id?: string, data?: unknown) => boolean;
  isSuperadmin?: () => boolean;
  getActor: () => Actor | null;
  /** Rule-valued entries on `resource` for `action`, OR'd with the schema rule at the merge point. */
  rules?: (resource: string, action: string) => RuleEntry[];
};
