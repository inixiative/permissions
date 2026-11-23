import type { EntitlementEntry } from './permix';

/** The actions an entitlement entry holds: those set to `true`. */
export const actionsEntryHolds = (entry: EntitlementEntry): string[] =>
  Object.entries(entry.actions)
    .filter(([, held]) => held === true)
    .map(([action]) => action);
