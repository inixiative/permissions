import type { Bridge, Condition } from '@inixiative/json-rules';

export type Row = Record<string, unknown>;

export type RelationCheck = { rel: string; action: string }; // walk a relation, then check `action`
export type RuleCheck = { rule: Condition }; // ABAC predicate (json-rules) over the record
export type SelfCheck = { self: string }; // record[field] matches the current actor id

/** The serializable permission algebra: rebac (`rel`) + abac (`rule`) + rbac (`string` delegation). */
export type ActionRule =
  | string // delegate to another action on the same resource
  | RelationCheck
  | RuleCheck
  | SelfCheck
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
 * supplemental hydrated rows per `map:model`, the same shape json-rules' `buildBridgeDictionary`
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

/** The slice of the permix wrapper the rebac check engine consumes. */
export type PermixLike = {
  check: (resource: string, action: string, id?: string, data?: unknown) => boolean;
  isSuperadmin?: () => boolean;
  getUserId: () => string | null;
};
