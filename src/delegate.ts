import { capEntry } from './capEntry';
import type { EntitlementEntry } from './permix';
import type { Table } from './table';
import type { RebacSchema } from './types';

/**
 * What a delegate's row says: `full` (its owner's table whole), a `ceiling` (the owner's table
 * grants kept at that action) and `entitlements` (backed by the owner's table). Who may set `full`
 * is the app's policy; this resolves it.
 */
export type Delegation<Action extends string = string> = {
  full?: boolean;
  ceiling?: string;
  entitlements?: EntitlementEntry<Action>[];
};

const capped = <Action extends string>(
  schema: RebacSchema,
  owner: Table<Action>,
  ceiling: string,
): Table<Action> =>
  owner.flatMap((group) => {
    if (group.owner) return [];
    const entries = group.entries.flatMap(
      (entry) => capEntry<Action>(schema, entry, ceiling) ?? [],
    );
    return entries.length ? [{ entries }] : [];
  });

/**
 * A delegate's table from its owner's. `full` is the owner's table whole; otherwise the owner's
 * table grants capped at `ceiling` (none without one; the owner's entitlements never), and the
 * delegate's `entitlements` backed by the owner's table. Nothing set is nothing.
 */
export const delegate = <Action extends string = string>(
  schema: RebacSchema,
  owner: Table<Action>,
  delegation: Delegation<NoInfer<Action>>,
): Table<Action> => {
  if (delegation.full) return owner;
  const entitlements = delegation.entitlements ?? [];
  return [
    ...(delegation.ceiling ? capped(schema, owner, delegation.ceiling) : []),
    ...(entitlements.length ? [{ entries: entitlements, owner }] : []),
  ];
};
