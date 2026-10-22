import type { PermissionEntry } from './permix';
import type { Entitlements } from './types';

export type GrantKey = { resource: string; id?: string };

/**
 * Split a grant key: `db:integration` → the whole resource, `db:integration:i7` → that row. The
 * resource is `map:model`; anything after the second `:` is the id.
 */
export const parseGrantKey = (key: string): GrantKey => {
  const [map, model, ...rest] = key.split(':');
  if (!map || !model) throw new Error(`A grant key is "map:model" or "map:model:id", got "${key}"`);
  const id = rest.join(':');
  return id ? { resource: `${map}:${model}`, id } : { resource: `${map}:${model}` };
};

/** Entitlements as permix entries, for a holder whose entitlements widen it. */
export const entitlementEntries = <Action extends string = string>(
  entitlements: Entitlements,
): PermissionEntry<Action>[] =>
  Object.entries(entitlements ?? {}).map(([key, actions]) => ({
    ...parseGrantKey(key),
    actions: actions as PermissionEntry<Action>['actions'],
  }));
