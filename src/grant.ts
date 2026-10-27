import { createRebacCheck } from './check';
import type { EntitlementEntry } from './permix';
import type { CheckOptions, PermixLike, RebacSchema, ResolveRelation, Row } from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  placed: Row,
) => boolean;

/**
 * Build the grant check, bound to the same resolver and tenancy as the rebac check.
 *
 * A grant is an action: `canGrantEntitlement` holds when the writer (`permix`: its table, its own
 * entitlements, its actor) could take every action `entry` names on `placed`, the pseudo record of
 * `entry.resource` the app built at the anchor: the anchor row itself for a grant anchored on its
 * own model, else a record whose direct owner is the anchor, with its columns, hydrated. The library
 * builds no record of its own (it does not own hydration). `placed` must sit at the anchor, or the
 * grant is refused. The app gives `placed` the values the entry's `where` pins exactly; a field it
 * does not carry is unknown (json-rules `absent: 'unknown'`), so the writer covers every record the
 * `where` admits.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
  options: CheckOptions = {},
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(resolveRelation, { ...options, absent: 'unknown' });

  return (permix, schema, entry, placed) => {
    const resource = entry.resource as R;
    return Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .every(([action]) => check(permix, schema, { resource, record: placed }, action));
  };
};
