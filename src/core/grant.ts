import { isEqual } from 'lodash-es';
import { createRebacCheck } from './check';
import { entitlementProblem } from './entitlementProblem';
import { asOwner } from './identity';
import type { EntitlementEntry } from './permix';
import { reachableFrom } from './reachableFrom';
import { conjuncts, literalValues, type SchemaMap } from './schemaMap';
import type { Anchor, CheckOptions, Entitlement, PermixLike, RebacSchema, Row } from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  placed: Row,
) => boolean;

const sameAnchor = (a: Anchor, b: Anchor) =>
  a.resource === b.resource && a.id === b.id && a.path === b.path;

const fieldOf = (rule: unknown) => (rule as { field: string }).field;

const implies = (granted: unknown, held: unknown) => {
  if (isEqual(granted, held)) return true;
  const within = literalValues(held);
  const values = literalValues(granted);
  return (
    within !== null &&
    values !== null &&
    (held as { operator: string }).operator === 'in' &&
    fieldOf(granted) === fieldOf(held) &&
    values.every((value) => within.includes(value))
  );
};

const narrows = (held: Entitlement, entry: EntitlementEntry) => {
  const granted = conjuncts(entry.where);
  return (
    sameAnchor(held.anchor, entry.anchor) &&
    conjuncts(held.where).every((condition) => granted.some((g) => implies(g, condition)))
  );
};

/**
 * Build the grant check, bound to the same schema map as the rebac check.
 *
 * A writer grants `entry` when, for each action it names, it could take that action on `placed`,
 * the pseudo record `placeEntitlement` builds from the hydrated anchor along the entry's path. The
 * check is the rebac walk itself over the writer's table and its own entitlements, with no actor:
 * implications, `rel` hops and every owner's backing apply as at read time. A field `placed` does
 * not carry is unknown (json-rules `absent: 'unknown'`), so a held `where` applies only where the
 * entry's `where` pins what it reads, and the writer covers every record the entry admits. Failing
 * the walk, the action may come from one held entitlement copied or narrowed: same resource and
 * anchor, the action one it holds or reaches by pure delegation (a bare action name, alone or an
 * arm of a top-level `any`), every condition of the held `where` among the entry's (the held
 * `where` itself, or each child of its top `all`) or narrowed by one of them (a held `in` of
 * literals by an `equals` or `in` on the same field whose values it lists), and whoever granted the
 * held one still takes the action on `placed`.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  map: SchemaMap<R>,
  options: CheckOptions = {},
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(map, { ...options, absent: 'unknown' });

  return (permix, schema, entry, placed) => {
    if (entitlementProblem(entry) !== null) return false;
    const resource = entry.resource as R;
    const writer = asOwner(permix, null);
    const takes = (taker: PermixLike, action: string) =>
      check(taker, schema, { resource, record: placed }, action);
    const copies = (action: string) =>
      [...reachableFrom(schema, resource, action)].some((held) =>
        (permix.entitlements?.(resource, held) ?? []).some(
          (entitlement) =>
            narrows(entitlement, entry) && takes(asOwner(entitlement.owner, null), action),
        ),
      );
    return Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .every(([action]) => takes(writer, action) || copies(action));
  };
};
