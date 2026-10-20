import type { Bridge, Condition, Row } from '@inixiative/json-rules';

export type { Row };

export type RelationCheck = { rel: string; action: string }; // walk a relation, then check `action`
export type RuleCheck = { rule: Condition }; // ABAC predicate (json-rules) over the record
/**
 * `record[self]` is the acting person's id (`selfId(actor)`). With `action`, the actor must also hold
 * `action` on its own entry (the check's `selfResource`, e.g. `db:user:<id>`); without one it is
 * identity only.
 */
export type SelfCheck = { self: string; action?: string };
/** An ABAC predicate (json-rules) over the actor itself: `{ actor: { field: 'model', … } }`. */
export type ActorCheck = { actor: Condition };

/** One flat actor field: a scalar or a list of ids. */
export type ActorValue = string | number | boolean | Date | null | readonly (string | number)[];

/** A party: whose authority is drawn on (a person, a membership, an organization, …). */
export type Party = { model: string; id: string } & { [field: string]: ActorValue };

/**
 * Who is acting now, plain data like a record: its `model` (what kind of thing acts: a person, a
 * token, …), its `id`, the `principal` whose authority it draws on, and any flat meta the app adds.
 * `{ actor }` conditions read it (dotted paths reach the principal: `principal.model`).
 */
export type Actor = { model: string; id: string; principal: Party } & {
  [field: string]: ActorValue | Party;
};

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

/**
 * One resource's permission entry. `actions` are checked on an existing row; `collections` are
 * checked on a scope row (the parent's keys) or a draft row (the row about to be created). Inside a
 * collection rule, a string names a row action of the same resource, evaluated on that row.
 */
export type ResourcePermission = {
  actions: Record<string, ActionRule>;
  collections?: Record<string, ActionRule>;
};

/**
 * The permission schema. `permissions` maps a (map-qualified) resource — e.g. `db:User` — to its
 * actions and collections; `bridges` are the cross-source edges (json-rules `Bridge`s) a `rel` walk
 * may traverse. Generic over the resource key: defaults to `string`, or pass a narrow union.
 */
export type RebacSchema<R extends string = string> = {
  bridges?: Bridge[];
  permissions: Partial<Record<R, ResourcePermission>>;
};

/** Check a collection rule (`schema.permissions[resource].collections[name]`) at the root. */
export type CollectionCheck = { collection: string };

/**
 * What the check evaluates against: the `record`, its (map-qualified) `resource`, and `data` —
 * supplemental hydrated rows per `map:model`, the same shape json-rules' `indexBridges` takes.
 */
export type Subject<R extends string = string> = {
  resource: R;
  record: Row;
  data?: Record<string, Row[]>;
};

/**
 * Resolve an INTRA-map relation field to the resource it points at — the ORM-specific seam the app
 * injects. Returns `null` to abort the walk when the relation is unknown.
 */
export type ResolveRelation<R extends string = string> = (
  resource: R,
  relationSegment: string,
) => R | null;

/** A rule-valued grant: on the whole resource (no `id`) or on one row. */
export type RuleEntry = { id?: string; rule: ActionRule };

/** The slice of the permix wrapper the rebac check engine consumes. */
export type PermixLike = {
  check: (resource: string, action: string, id?: string, data?: unknown) => boolean;
  isSuperadmin?: () => boolean;
  getActor: () => Actor | null;
  /** Rule-valued grants on `resource` for `action` (OR'd with the schema rule at the merge point). */
  rules?: (resource: string, action: string) => RuleEntry[];
  /** Ids of the id-keyed entries on `resource` holding exactly `action` as `true`. */
  heldIds?: (resource: string, action: string) => string[];
};

/**
 * Several permix passes over one subject: a leaf is one full engine pass; `any` / `all` combine
 * passes. E.g. "principal allows AND grant allows" is `{ all: [principal, grant] }`.
 */
export type PermixExpression<P extends PermixLike = PermixLike> =
  | P
  | { any: PermixExpression<P>[] }
  | { all: PermixExpression<P>[] };
