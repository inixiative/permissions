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
      const key = id ? `${resource}:${id}` : resource;
      return permix.check(key, action, data);
    },
    setup: async (perms, options) => {
      if (options?.replace) accumulated = {};
      const entries = castArray(perms);
      for (const { resource, id, actions } of entries) {
        const key = id ? `${resource}:${id}` : resource;
        accumulated[key] = { ...actions };
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
