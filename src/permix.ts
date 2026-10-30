import type { Condition } from '@inixiative/json-rules';
import { castArray } from 'lodash-es';
import { createPermix } from 'permix';
import { entitlementProblem } from './entitlementProblem';
import type { Actor, Anchor, Entitlement, PermixLike } from './types';

export type ActionState<Action extends string = string> = Partial<
  Record<Action, boolean | ((data?: unknown) => boolean)>
>;

/** A grant: the actor holds `actions` on a resource, or on one row of it. Lives in the table. */
export type GrantEntry<Action extends string = string> = {
  resource: string;
  id?: string;
  actions: ActionState<Action>;
};

/**
 * An entitlement: `actions` on `resource`, acting from an anchor on the record's chain, narrowed
 * by `where` — plain json-rules over the record at that node, literals and record paths only;
 * whatever referred to the holder (its own id, its user) was written in when the grant was made.
 * Whoever granted it is the `owner` of the `setup` call that installs it, and at check time the
 * entitlement holds only if that owner's own table still allows the action on the record.
 */
export type EntitlementEntry<Action extends string = string> = {
  resource: string;
  anchor: Anchor;
  where?: Condition;
  actions: Partial<Record<Action, boolean>>;
};

export type PermissionEntry<Action extends string = string> =
  | GrantEntry<Action>
  | EntitlementEntry<Action>;

export type SetupOptions = { replace?: boolean; owner?: PermixLike };

type PermissionState = Record<string, ActionState>;

const isEntitlement = (entry: PermissionEntry): entry is EntitlementEntry =>
  (entry as EntitlementEntry).anchor !== undefined;

const validate = (entry: PermissionEntry, owner: PermixLike | undefined): void => {
  if (!isEntitlement(entry)) {
    if ((entry as EntitlementEntry).where !== undefined)
      throw new Error('`where` needs `anchor`: an entitlement acts from an anchor');
    return;
  }
  const problem = entitlementProblem(entry);
  if (problem) throw new Error(problem);
  if (!owner)
    throw new Error('an entry with `anchor` needs setup(entries, { owner }): whoever granted it');
};

/**
 * A thin, role-agnostic wrapper over `permix`. Holds the actor's granted actions (keyed by
 * `resource` or `resource:id`), its entitlements (kept beside the table, each with the table of
 * whoever granted it), a superadmin bypass, and the current actor (its id plus app-supplied meta).
 * App code populates it from roles/entitlements (hydration stays app-side); the rebac
 * {@link createRebacCheck} engine reads it back through the {@link PermixLike} slice.
 */
export type Permix<Action extends string = string, A extends Actor = Actor> = {
  check: (resource: string, action: Action, id?: string, data?: unknown) => boolean;
  setup: (
    perms: PermissionEntry<Action> | PermissionEntry<Action>[],
    options?: SetupOptions,
  ) => Promise<void>;
  entitlements: (resource: string, action: Action) => Entitlement[];
  setSuperadmin: (value: boolean) => void;
  isSuperadmin: () => boolean;
  setActor: (actor: A) => void;
  getActor: () => A | null;
  getJSON: () => Record<string, Record<string, boolean>> | null;
};

export const createPermissions = <
  Action extends string = string,
  A extends Actor = Actor,
>(): Permix<Action, A> => {
  const permix = createPermix<Record<string, { action: Action }>>();
  let isSuperadmin = false;
  let actor: A | null = null;
  let accumulated: PermissionState = {};
  let entitlements = new Map<string, Entitlement[]>();

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
      const entries = castArray(perms);
      for (const entry of entries) validate(entry, options?.owner);
      if (options?.replace) {
        accumulated = {};
        entitlements = new Map();
      }
      for (const entry of entries) {
        if (isEntitlement(entry)) {
          const { resource, anchor, where, actions } = entry;
          const held = { anchor, where, actions, owner: options?.owner as PermixLike };
          for (const [action, value] of Object.entries(actions)) {
            if (value !== true) continue;
            const key = `${resource}\0${action}`;
            const list = entitlements.get(key);
            if (list) list.push(held);
            else entitlements.set(key, [held]);
          }
          continue;
        }
        const { resource, id, actions } = entry;
        const key = id ? `${resource}:${id}` : resource;
        // Merge, don't overwrite: successive setups for the same key are additive — e.g. a `read`
        // grant then a `manage` grant on `organization:o1` must leave both actions in place.
        accumulated[key] = { ...accumulated[key], ...actions };
      }
      await permix.setup(accumulated as Parameters<typeof permix.setup>[0]);
    },
    entitlements: (resource, action) => [...(entitlements.get(`${resource}\0${action}`) ?? [])],
    setSuperadmin: (value) => {
      isSuperadmin = value;
    },
    isSuperadmin: () => isSuperadmin,
    setActor: (value) => {
      actor = value;
    },
    getActor: () => actor,
    getJSON: () => permix.dehydrate() as Record<string, Record<string, boolean>>,
  };
};
