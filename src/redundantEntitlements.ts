import { isEqual } from 'lodash-es';
import type { EntitlementEntry } from './permix';

const heldActions = (entry: EntitlementEntry) =>
  Object.entries(entry.actions)
    .filter(([, held]) => held === true)
    .map(([action]) => action);

/** Whether `held` makes `entry` redundant: identical aside from `held` holding every action `entry` does. */
export const coversEntitlement = (held: EntitlementEntry, entry: EntitlementEntry): boolean =>
  held.resource === entry.resource &&
  isEqual(held.anchor, entry.anchor) &&
  isEqual(held.where, entry.where) &&
  heldActions(entry).every((action) => held.actions[action] === true);

/** `entries` without the redundant ones: the first of identical entries, and none another covers. */
export const withoutRedundantEntitlements = <E extends EntitlementEntry>(entries: E[]): E[] =>
  entries.filter((entry, i) =>
    entries.every(
      (other, j) =>
        i === j || !coversEntitlement(other, entry) || (coversEntitlement(entry, other) && i < j),
    ),
  );
