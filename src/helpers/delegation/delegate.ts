import type { EntitlementEntry } from '../../core/permix';
import type { RebacSchema } from '../../core/types';
import { capAtRole } from './capAtRole';
import type { Permissions } from './permissions';

/**
 * What a delegate's row says: `full` (its owner's permissions whole), a `ceiling` (the owner's
 * permissions grants kept at that action) and `entitlements` (backed by the owner's permissions).
 * Who may set `full` is the app's policy; this resolves it.
 */
export type Delegation<Action extends string = string> = {
  full?: boolean;
  ceiling?: string;
  entitlements?: EntitlementEntry<Action>[];
};

const capped = <Action extends string>(
  schema: RebacSchema,
  owner: Permissions<Action>,
  ceiling: string,
): Permissions<Action> =>
  owner.flatMap((group) => {
    if (group.owner) return [];
    const entries = group.entries.flatMap(
      (entry) => capAtRole<Action>(schema, entry, ceiling) ?? [],
    );
    return entries.length ? [{ entries }] : [];
  });

/**
 * A delegate's permissions from its owner's. `full` is the owner's permissions whole; otherwise
 * the owner's permissions grants capped at `ceiling` (none without one; the owner's entitlements
 * never), and the delegate's `entitlements` backed by the owner's permissions. Nothing set is
 * nothing.
 */
export const delegate = <Action extends string = string>(
  schema: RebacSchema,
  owner: Permissions<Action>,
  delegation: Delegation<NoInfer<Action>>,
): Permissions<Action> => {
  if (delegation.full) return owner;
  const entitlements = delegation.entitlements ?? [];
  return [
    ...(delegation.ceiling ? capped(schema, owner, delegation.ceiling) : []),
    ...(entitlements.length ? [{ entries: entitlements, owner }] : []),
  ];
};
