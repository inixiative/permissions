import { type Admission, booleanAlgebra, pathsAlgebra } from './algebra';
import type { SchemaMap } from './schemaMap';
import type { ActionRule, CheckOptions, PermixLike, RebacSchema, Subject } from './types';
import { createWalker } from './walker';

export type RebacCheck<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  subject: Subject<R>,
  actionOrRule: ActionRule,
) => boolean;

/**
 * Build the rebac check, bound to the app's schema map.
 *
 * A `rel` hop reads the relation field from `map` (its `fieldMap` model, the resource it leads to);
 * a path's polymorphic kinds come from `map.polymorphism`. Cross-source `rel` hops are resolved by the engine from
 * `schema.bridges`: the join-key scalar on the record looks the far row up in a `BridgeDictionary`
 * the engine builds from `subject.data`; a far row absent there denies the walk. `string` delegates
 * (rbac via permix or schema), `{ rule }` is an ABAC predicate over the record and the actor (read
 * by path at `__actor`), `any`/`all` compose. A loop through a relation denies; a rule naming
 * itself on one record throws.
 */
export const createRebacCheck = <R extends string = string>(
  map: SchemaMap<R>,
  { absent = 'null', additionalRules }: CheckOptions = {},
): RebacCheck<R> => {
  const walker = createWalker(map, absent, booleanAlgebra, false, additionalRules);
  return (permix, schema, subject, actionOrRule) => walker(permix, schema, subject, actionOrRule);
};

export type RebacPaths<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  subject: Subject<R>,
  actionOrRule: ActionRule,
) => Admission[];

export type PathsOptions = CheckOptions & { limit?: number };

/**
 * Every way a check is admitted, on the same walk `check` runs: one {@link Admission} per way, each
 * the chains of entitlement `ref`s it stands on, holder first. A grant held directly is `[[]]`;
 * nothing admits is `[]`. The order is the walk's: the schema before entitlements, and
 * entitlements in the order they were set up. A walk that finds more than `limit` (default 20)
 * throws {@link PathLimitError}.
 */
export const createRebacPaths = <R extends string = string>(
  map: SchemaMap<R>,
  { absent = 'null', limit = 20, additionalRules }: PathsOptions = {},
): RebacPaths<R> => {
  const walker = createWalker(map, absent, pathsAlgebra(limit), false, additionalRules);
  return (permix, schema, subject, actionOrRule) => walker(permix, schema, subject, actionOrRule);
};

export { type Admission, type Chain, PathLimitError } from './algebra';
