import { isEqual } from 'lodash-es';
import { booleanAlgebra } from './algebra';
import { rowsAbove } from './anchorPath';
import { entitlementProblem } from './entitlementProblem';
import { asOwner } from './identity';
import { whyEntitlementWhereLeavesLens } from './lens';
import type { EntitlementEntry } from './permix';
import { reachableFrom } from './reachableFrom';
import type { SchemaMap } from './schemaMap';
import type { Anchor, CheckOptions, Entitlement, PermixLike, Row } from './types';
import { createWalker } from './walker';
import { conjuncts } from './whereConjuncts';

export type CanGrantEntitlement = (
  permix: PermixLike,
  entry: EntitlementEntry,
  pseudoRecord: Row,
) => boolean;

const sameAnchor = (a: Anchor, b: Anchor) =>
  a.resource === b.resource && a.id === b.id && a.path === b.path;

const narrows = (held: Entitlement, entry: EntitlementEntry) => {
  const granted = conjuncts(entry.where);
  return (
    sameAnchor(held.anchor, entry.anchor) &&
    conjuncts(held.where).every((condition) => granted.some((g) => isEqual(condition, g)))
  );
};

/**
 * Build the grant check (README, Granting one). First pass: the writer's table, given no `data`,
 * takes every action `entry` names on `pseudoRecord`, counting an entitlement
 * only on a row above the granted record (`rowsAbove`), marked `grantsBelow`, without a `where`.
 * Failing that, the entry narrows one entitlement the writer holds, and its granter still takes
 * each action on `pseudoRecord` in a walk that counts every `where` as holding.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  map: SchemaMap<R>,
  { additionalRules }: Pick<CheckOptions, 'additionalRules'> = {},
): CanGrantEntitlement => {
  const check = createWalker(map, booleanAlgebra, false, additionalRules);
  const backs = createWalker(map, booleanAlgebra, true, additionalRules);

  return (permix, entry, pseudoRecord) => {
    if (
      entitlementProblem(entry) !== null ||
      whyEntitlementWhereLeavesLens(map, entry.resource, entry.where)
    )
      return false;
    const resource = entry.resource as R;
    const actions = Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .map(([action]) => action);
    const table = asOwner(permix);
    const above = rowsAbove(map, entry, pseudoRecord);
    const subject = { resource, record: pseudoRecord };
    if (actions.every((action) => check(table, subject, action, above))) return true;
    const reached = actions.map((action) => ({
      action,
      implying: reachableFrom(map, resource, action),
    }));
    const candidates = [...(reached[0]?.implying ?? [])].flatMap(
      (action) => permix.entitlements?.(resource, action) ?? [],
    );
    return candidates.some((held) => {
      const lowers = (up: ReadonlySet<string>) =>
        [...up].some((action) => held.actions[action] === true);
      const owner = asOwner(held.owner);
      const backed = (action: string) => backs(owner, { resource, record: pseudoRecord }, action);
      return (
        narrows(held, entry) &&
        reached.every(({ action, implying }) => lowers(implying) && backed(action))
      );
    });
  };
};
