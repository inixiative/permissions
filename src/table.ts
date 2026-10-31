import { createPermissions, type PermissionEntry, type Permix } from './permix';
import type { Actor } from './types';

/**
 * A table as data: groups of entries. A group without `owner` is table grants; a group with one is
 * entitlements, backed by the table of whoever granted them.
 */
export type Table<Action extends string = string> = {
  entries: PermissionEntry<Action>[];
  owner?: Table;
}[];

export const installTable = async <Action extends string, A extends Actor>(
  permix: Permix<Action, A>,
  table: Table<Action>,
): Promise<void> => {
  for (const { entries, owner } of table)
    await permix.setup(entries, owner ? { owner: await tablePermix(owner) } : undefined);
};

export const tablePermix = async <Action extends string = string>(
  table: Table<Action>,
): Promise<Permix<Action>> => {
  const permix = createPermissions<Action>();
  await installTable(permix, table);
  return permix;
};
