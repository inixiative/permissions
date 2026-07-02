import { castArray } from 'lodash-es';
import { createPermix } from 'permix';

export type ActionState<Action extends string = string> = Partial<
  Record<Action, boolean | ((data?: unknown) => boolean)>
>;

export type PermissionEntry<Action extends string = string> = {
  resource: string;
  id?: string;
  actions: ActionState<Action>;
};

export type Entitlements = Record<string, boolean> | null;

type PermissionState = Record<string, ActionState>;

/**
 * A thin, role-agnostic wrapper over `permix`. Holds the actor's granted actions (keyed by
 * `resource` or `resource:id`), a superadmin bypass, and the current actor id. App code populates
 * it from roles/entitlements (hydration stays app-side); the rebac {@link createRebacCheck} engine
 * reads it back through the {@link PermixLike} slice.
 */
export type Permix<Action extends string = string> = {
  check: (resource: string, action: Action, id?: string, data?: unknown) => boolean;
  setup: (
    perms: PermissionEntry<Action> | PermissionEntry<Action>[],
    options?: { replace?: boolean },
  ) => Promise<void>;
  setSuperadmin: (value: boolean) => void;
  isSuperadmin: () => boolean;
  setUserId: (id: string) => void;
  getUserId: () => string | null;
  getJSON: () => Record<string, Record<string, boolean>> | null;
};

export const createPermissions = <Action extends string = string>(): Permix<Action> => {
  const permix = createPermix<Record<string, { action: Action }>>();
  let isSuperadmin = false;
  let userId: string | null = null;
  let accumulated: PermissionState = {};

  return {
    check: (resource, action, id, data) => {
      if (isSuperadmin) return true;
      // Only probe entities we actually set up: an unregistered key makes permix log a spurious
      // "Incorrect entity name" warning on every deny (the engine probes speculatively). Gating on
      // `accumulated` is equivalent — an unregistered entity is never granted — and stays quiet.
      const granted = (key: string) => key in accumulated && permix.check(key, action, data);
      // An id-keyed grant is checked first, then the resource-wide grant: a "read all documents"
      // grant (set up with no id) must still apply when checking a specific record id.
      if (id && granted(`${resource}:${id}`)) return true;
      return granted(resource);
    },
    setup: async (perms, options) => {
      if (options?.replace) accumulated = {};
      const entries = castArray(perms);
      for (const { resource, id, actions } of entries) {
        const key = id ? `${resource}:${id}` : resource;
        // Merge, don't overwrite: successive setups for the same key are additive — e.g. a `read`
        // grant then a `manage` grant on `organization:o1` must leave both actions in place.
        accumulated[key] = { ...accumulated[key], ...actions };
      }
      await permix.setup(accumulated as Parameters<typeof permix.setup>[0]);
    },
    setSuperadmin: (value) => {
      isSuperadmin = value;
    },
    isSuperadmin: () => isSuperadmin,
    setUserId: (id) => {
      userId = id;
    },
    getUserId: () => userId,
    getJSON: () => permix.dehydrate() as Record<string, Record<string, boolean>>,
  };
};
