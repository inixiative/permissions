import type { Absent, Bridge, Condition, Row } from '@inixiative/json-rules';

export type { Row };

export type RelationCheck = { rel: string; action: string }; // walk a relation, then check `action`
/** ABAC (json-rules) over the record, with who is acting under the reserved key `__actor`. */
export type RuleCheck = { rule: Condition };

/** Who is acting: what kind of credential (`model`) and its row (`record`). A `{ rule }` reads it as `__actor`. */
export type Actor = { model: string; record: Row };

/** The serializable permission algebra: rebac (`rel`) + abac (`rule`) + rbac (`string` delegation). */
export type ActionRule =
  | string // delegate to another action on the same resource
  | RelationCheck
  | RuleCheck
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
 * The record an entitlement acts from, and the relation path that reaches it from the entitled
 * record (`'space.organization'`). A record anchored at itself has no path.
 */
export type Anchor = { resource: string; id: string; path?: string };

export type CheckOptions = {
  absent?: Absent;
};

/**
 * An installed entitlement, as the engine reads it back: it applies to a record only when the
 * record's hydrated `anchor.path` reaches the anchor, `where` holds, and the `owner` (the table of whoever granted
 * it) still allows the action on that record through the normal walk.
 */
export type Entitlement = {
  anchor: Anchor;
  where?: Condition;
  actions: Record<string, boolean | undefined>;
  owner: PermixLike;
};

/** The slice of the permix wrapper the rebac check engine consumes. */
export type PermixLike = {
  check: (resource: string, action: string, id?: string, data?: unknown) => boolean;
  isSuperadmin?: () => boolean;
  getActor: () => Actor | null;
  entitlements?: (resource: string, action: string) => Entitlement[];
};
