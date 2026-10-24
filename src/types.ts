import type { Bridge, Condition, Row } from '@inixiative/json-rules';

export type { Row };

export type RelationCheck = { rel: string; action: string }; // walk a relation, then check `action`
export type RuleCheck = { rule: Condition }; // ABAC predicate (json-rules) over the record
/** An ABAC predicate (json-rules) over the actor itself: `{ actor: { field: 'kind', … } }`. */
export type ActorCheck = { actor: Condition };

/**
 * Who is acting: an id plus whatever the app knows about them — plain data, like a record (what
 * kind of principal it is, the integration it is bound to, …). `{ actor }` evaluates a condition
 * over it; `{ rule }` reads its fields as `actor.<field>` binds. Identity is never read from it:
 * acting on your own row is `{ rel: '<relation to yourself>', action }`, a walk to your own entry.
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

/** A node on a record's chain: the position an entitlement acts from. */
export type Position = { resource: string; id: string };

/**
 * An installed entitlement, as the engine reads it back: it applies to a record only when `from`
 * is on the record's hydrated path, `where` holds, and the `owner` (the table of whoever granted
 * it) still allows the action on that record through the normal walk.
 */
export type Entitlement = { from: Position; where?: Condition | null; owner: PermixLike };

/** The slice of the permix wrapper the rebac check engine consumes. */
export type PermixLike = {
  check: (resource: string, action: string, id?: string, data?: unknown) => boolean;
  isSuperadmin?: () => boolean;
  getActor: () => Actor | null;
  entitlements?: (resource: string, action: string) => Entitlement[];
};
