import { resolvedSchemaMap } from '.\/resolvedSchemaMap';
import { type Admission, booleanAlgebra, pathsAlgebra } from './algebra';
import type { ResolvedSchemaMap, SchemaMap } from './schemaMap';
import type { ActionRule, CheckOptions, PermixLike, Subject } from './types';
import { makeWalker } from './walker';

export type RebacCheck<R extends string = string> = (
  permix: PermixLike,
  subject: Subject<R>,
  actionOrRule: ActionRule,
) => boolean;

/**
 * Build the rebac check over the app's schema map: its field maps, supplied maps, bridges,
 * polymorphism and rules, in the one object.
 *
 * A `rel` hop reads the relation field from the resource's model in `map.maps` and lands on the
 * model it leads to, in the same map; a path's polymorphic kinds come from `map.polymorphism`.
 * Cross-source `rel` hops cross the map's joined bridges that have no end supplied: the join-key
 * scalar on the record looks the far row up in a `BridgeDictionary` the engine builds from
 * `subject.bridgeData`; a far row absent there denies the walk. `string` delegates (rbac via permix or
 * the map's rules), `{ rule }` is an ABAC predicate over the record and the supplied rows
 * `subject.bridgeData` gives (`actor:<Model>.<column>`), `any`/`all` compose. A loop through a relation
 * denies; a rule naming itself on one record throws.
 */
export const makeRebacCheck = <R extends string = string>(
  schemaMap: SchemaMap<R>,
  { additionalRules }: CheckOptions = {},
): RebacCheck<R> => {
  const walker = makeWalker(resolvedSchemaMap(schemaMap), booleanAlgebra, false, additionalRules);
  return (permix, subject, actionOrRule) => walker(permix, subject, actionOrRule);
};

export type RebacPaths<R extends string = string> = (
  permix: PermixLike,
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
export const makeRebacPaths = <R extends string = string>(
  schemaMap: SchemaMap<R>,
  { limit = 20, additionalRules }: PathsOptions = {},
): RebacPaths<R> => {
  const walker = makeWalker(
    resolvedSchemaMap(schemaMap),
    pathsAlgebra(limit),
    false,
    additionalRules,
  );
  return (permix, subject, actionOrRule) => walker(permix, subject, actionOrRule);
};

export { type Admission, type Chain, PathLimitError } from './algebra';
