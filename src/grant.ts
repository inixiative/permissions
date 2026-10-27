import { createRebacCheck } from './check';
import { onPath } from './onPath';
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
 * grant is refused. A `where` only narrows, so it is not consulted: the writer covers the whole set at
 * the anchor.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
  options: CheckOptions<R> = {},
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(resolveRelation, options);
  const directOwner = options.directOwner ?? (() => null);

  return (permix, schema, entry, placed) => {
    const resource = entry.resource as R;
    if (!onPath(directOwner, resource, placed, entry.anchor)) return false;
    return Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .every(([action]) => check(permix, schema, { resource, record: placed }, action));
  };
};
