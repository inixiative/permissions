import { castArray } from 'lodash-es';
import { createPermix } from 'permix';
import type { ActionRule, Actor, RuleEntry } from './types';

/**
 * A granted action: `true` (held), a permix predicate, or an {@link ActionRule} the engine evaluates
 * on the record at the merge point (OR'd with the schema rule). `false` / `null` grant nothing.
 */
export type ActionValue = boolean | ((data?: unknown) => boolean) | ActionRule;

export type ActionState<Action extends string = string> = Partial<Record<Action, ActionValue>>;

export type PermissionEntry<Action extends string = string> = {
  resource: string;
  id?: string;
  actions: ActionState<Action>;
};

type BooleanState = Record<string, boolean | ((data?: unknown) => boolean)>;

const isRule = (value: ActionValue): value is Exclude<ActionRule, boolean | null> =>
  typeof value === 'string' || (typeof value === 'object' && value !== null);

/**
 * A thin, role-agnostic wrapper over `permix`. Holds the actor's granted actions (keyed by
 * `resource` or `resource:id`), rule-valued entries, a superadmin bypass and
 * the current actor. App code populates it from roles/entitlements (hydration stays app-side); the
 * rebac {@link createRebacCheck} engine reads it back through the {@link PermixLike} slice.
 */
export type Permix<Action extends string = string, A extends Actor = Actor> = {
  check: (resource: string, action: Action, id?: string, data?: unknown) => boolean;
  setup: (
    perms: PermissionEntry<Action> | PermissionEntry<Action>[],
    options?: { replace?: boolean },
  ) => Promise<void>;
  setSuperadmin: (value: boolean) => void;
  isSuperadmin: () => boolean;
  setActor: (actor: A) => void;
  getActor: () => A | null;
  rules: (resource: string, action: string) => RuleEntry[];
  getJSON: () => Record<string, Record<string, boolean>> | null;
};

type Key = { resource: string; id?: string };

export const createPermissions = <
  Action extends string = string,
  A extends Actor = Actor,
>(): Permix<Action, A> => {
  const permix = createPermix<Record<string, { action: Action }>>();
  let isSuperadmin = false;
  let actor: A | null = null;
  let accumulated: Record<string, BooleanState> = {};
  let ruleState: Record<string, Record<string, ActionRule>> = {};
  let keys: Record<string, Key> = {};

  return {
    check: (resource, action, id, data) => {
      if (isSuperadmin) return true;
      // Only probe entities we actually set up: an unregistered key makes permix log a spurious
      // "Incorrect entity name" warning on every deny (the engine probes speculatively).
      const granted = (key: string) => key in accumulated && permix.check(key, action, data);
      // An id-keyed grant is checked first, then the resource-wide grant: a "read all documents"
      // grant (set up with no id) must still apply when checking a specific record id.
      if (id && granted(`${resource}:${id}`)) return true;
      return granted(resource);
    },
    setup: async (perms, options) => {
      if (options?.replace) {
        accumulated = {};
        ruleState = {};
        keys = {};
      }
      for (const { resource, id, actions } of castArray(perms)) {
        const key = id ? `${resource}:${id}` : resource;
        keys[key] = id ? { resource, id } : { resource };
        const booleans: BooleanState = {};
        const rules: Record<string, ActionRule> = {};
        for (const [action, value] of Object.entries(actions) as [string, ActionValue][]) {
          if (typeof value === 'boolean' || typeof value === 'function') booleans[action] = value;
          else if (isRule(value)) rules[action] = value;
        }
        // Merge, don't overwrite: successive setups for the same key are additive.
        accumulated[key] = { ...accumulated[key], ...booleans };
        if (Object.keys(rules).length) ruleState[key] = { ...ruleState[key], ...rules };
      }
      await permix.setup(accumulated as Parameters<typeof permix.setup>[0]);
    },
    setSuperadmin: (value) => {
      isSuperadmin = value;
    },
    isSuperadmin: () => isSuperadmin,
    setActor: (value) => {
      actor = value;
    },
    getActor: () => actor,
    rules: (resource, action) =>
      Object.entries(ruleState).flatMap(([key, rules]) => {
        const owner = keys[key];
        const rule = rules[action];
        if (!owner || owner.resource !== resource || rule === undefined) return [];
        return [owner.id ? { id: owner.id, rule } : { rule }];
      }),
    getJSON: () => permix.dehydrate() as Record<string, Record<string, boolean>>,
  };
};
