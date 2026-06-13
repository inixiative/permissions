import type { Condition } from '@inixiative/json-rules';

export type Row = Record<string, unknown>;

export type RelationCheck = { rel: string; action: string }; // walk a relation field, then check `action`
export type RuleCheck = { rule: Condition }; // ABAC predicate (json-rules) over the record
export type SelfCheck = { self: string }; // record[field] matches the current actor id

/** The serializable permission algebra: rebac (`rel`) + abac (`rule`) + rbac (`string` delegation). */
export type ActionRule =
  | string // delegate to another action on the same model
  | RelationCheck
  | RuleCheck
  | SelfCheck
  | { any: ActionRule[] } // OR
  | { all: ActionRule[] } // AND
  | null; // terminal deny

export type ModelPermission = { actions: Record<string, ActionRule> };

/**
 * `model → { actions }`, entries optional (only governed models need one). Generic over the model
 * key: defaults to `string`, or pass a narrow union (e.g. a Prisma AccessorName) and the schema,
 * `model` arg, and resolver all enforce that union — no cast needed for the consumer's own types.
 */
export type RebacSchema<M extends string = string> = Partial<Record<M, ModelPermission>>;

/**
 * Resolve the model a relation field points at, given the source model + relation segment.
 * This is the ORM-specific seam the app injects (e.g. derived from a Prisma model map). Return
 * `null` to abort the walk when the relation is unknown. Generic over the model key (default `string`).
 */
export type ResolveModel<M extends string = string> = (
  model: M,
  relationSegment: string,
) => M | null;

/** The slice of the permix wrapper the rebac check engine consumes. */
export type PermixLike = {
  check: (resource: string, action: string, id?: string, data?: unknown) => boolean;
  isSuperadmin?: () => boolean;
  getUserId: () => string | null;
};
