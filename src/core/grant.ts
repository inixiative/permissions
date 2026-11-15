import { isEqual } from 'lodash-es';
import { booleanAlgebra } from './algebra';
import { entitlementProblem } from './entitlementProblem';
import { asOwner } from './identity';
import { whereLensProblem } from './lens';
import type { EntitlementEntry } from './permix';
import { reachableFrom } from './reachableFrom';
import { conjuncts, rowsAbove, type SchemaMap } from './schemaMap';
import type { Anchor, Entitlement, PermixLike, RebacSchema, Row } from './types';
import { createWalker } from './walker';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  placed: Row,
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
 * Build the grant check, bound to the same schema map as the rebac check.
 *
 * A grant is judged in two passes. The first: the writer's table (its role; a delegate's role is
 * its owner's table capped at it) with no actor takes every action `entry` names on `placed`, the pseudo record `placeEntitlement` builds
 * from the hydrated anchor along the entry's path; a field it does not carry is unknown (json-rules
 * `absent: 'unknown'`), so the writer covers every record the `where` admits. In that pass an
 * entitlement counts as a role on its record would when it is marked `grantsBelow`, has no
 * `where`, and the walk meets it on a hydrated row above the granted record (`rowsAbove`: never
 * the granted record itself, never a placed one); its owner is walked from there under the same
 * rule. A `where` is excluded because it would be read on today's row and dropped from the grant.
 * Failing that, the
 * entitlement pass: the entry is one entitlement the writer holds, copied or narrowed — same
 * resource and anchor, each of its actions one the held entitlement holds or reaches by pure
 * delegation (a bare action name, alone or an arm of a top-level `any`), and every condition of the held `where`
 * among the entry's (the held `where` itself, or each child of its top `all`) — and for each granted
 * action, whoever granted the held one still takes that action on `placed`, in a walk that counts
 * every entitlement `where` as holding. The `where` is judged by structure alone and never by
 * that liveness walk, so a pin the placed record leaves unknown (`id in [A, B]`) passes on at any
 * depth. A granter limited only by a `where` counts as live; reads apply every `where` live.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  map: SchemaMap<R>,
): CanGrantEntitlement<R> => {
  const check = createWalker(map, 'unknown', booleanAlgebra);
  const backs = createWalker(map, 'unknown', booleanAlgebra, true);

  return (permix, schema, entry, placed) => {
    if (entitlementProblem(entry) !== null || whereLensProblem(map, entry.resource, entry.where))
      return false;
    const resource = entry.resource as R;
    const actions = Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .map(([action]) => action);
    const table = asOwner(permix, null);
    const above = rowsAbove(map, entry, placed);
    const subject = { resource, record: placed };
    if (actions.every((action) => check(table, schema, subject, action, new Set(), above)))
      return true;
    const reached = actions.map((action) => reachableFrom(schema, resource, action));
    const candidates = [...(reached[0] ?? [])].flatMap(
      (action) => permix.entitlements?.(resource, action) ?? [],
    );
    return candidates.some((held) => {
      const lowers = (up: ReadonlySet<string>) =>
        [...up].some((action) => held.actions[action] === true);
      const owner = asOwner(held.owner, null);
      const backed = (action: string) => backs(owner, schema, { resource, record: placed }, action);
      return (
        narrows(held, entry) && actions.every((action, i) => lowers(reached[i]!) && backed(action))
      );
    });
  };
};
