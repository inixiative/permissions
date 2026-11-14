import { createPermissions, type PermissionEntry, type Permix } from '../../core/permix';
import type { Actor, PermixLike } from '../../core/types';

/**
 * Permissions as data: groups of entries. A group without `owner` is permissions grants; a group
 * with one is entitlements, backed by the permissions of whoever granted them.
 */
export type Permissions<Action extends string = string> = {
  entries: PermissionEntry<Action>[];
  owner?: Permissions;
}[];

const building = Symbol('building');

/** Owners built in one install, by the `Permissions` object they were built from. */
export type BuiltOwners = Map<Permissions, PermixLike | typeof building>;

/**
 * Installs each group. An owner reached more than once (two delegates of one owner, the two sides
 * of a diamond) is built once per install when it is the same `Permissions` object, so a chain
 * reached along many paths is never rebuilt per path. An owner reached again while it is still
 * being built is a loop in the data: that edge backs nothing.
 */
export const installPermissions = async <Action extends string, A extends Actor>(
  permix: Permix<Action, A>,
  permissions: Permissions<Action>,
  built: BuiltOwners = new Map(),
): Promise<void> => {
  for (const { entries, owner } of permissions)
    await permix.setup(entries, owner ? { owner: await ownerOf(owner, built) } : undefined);
};

const ownerOf = async (owner: Permissions, built: BuiltOwners): Promise<PermixLike> => {
  const held = built.get(owner);
  if (held === building) return createPermissions();
  if (held) return held;
  built.set(owner, building);
  const permix = await permixOf(owner, built);
  built.set(owner, permix);
  return permix;
};

export const permixOf = async <Action extends string = string>(
  permissions: Permissions<Action>,
  built: BuiltOwners = new Map(),
): Promise<Permix<Action>> => {
  const permix = createPermissions<Action>();
  await installPermissions(permix, permissions, built);
  return permix;
};
