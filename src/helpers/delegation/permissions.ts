import { createPermissions, type PermissionEntry, type Permix } from '../../core/permix';
import type { Actor } from '../../core/types';

/**
 * Permissions as data: groups of entries. A group without `owner` is permissions grants; a group
 * with one is entitlements, backed by the permissions of whoever granted them.
 */
export type Permissions<Action extends string = string> = {
  entries: PermissionEntry<Action>[];
  owner?: Permissions;
}[];

export const installPermissions = async <Action extends string, A extends Actor>(
  permix: Permix<Action, A>,
  permissions: Permissions<Action>,
): Promise<void> => {
  for (const { entries, owner } of permissions)
    await permix.setup(entries, owner ? { owner: await permixOf(owner) } : undefined);
};

export const permixOf = async <Action extends string = string>(
  permissions: Permissions<Action>,
): Promise<Permix<Action>> => {
  const permix = createPermissions<Action>();
  await installPermissions(permix, permissions);
  return permix;
};
