import { union } from 'lodash-es';
import type { PermissionEntry } from './permix';
import { reachableFrom } from './reachableFrom';
import type { RebacSchema } from './types';

/**
 * `entry` kept at `ceiling` — the action the delegate's role maps to — by the schema's chain on
 * its resource: each action the ceiling reaches by pure delegation and the entry holds or implies,
 * as plain `true`. Null when nothing is kept. A conditional action is not held.
 */
export const capAtRole = <Action extends string = string>(
  schema: RebacSchema,
  entry: PermissionEntry<NoInfer<Action>>,
  ceiling: string,
): PermissionEntry<Action> | null => {
  const held = (action: string) => (entry.actions as Record<string, unknown>)[action] === true;
  const kept = union(
    Object.keys(schema.permissions[entry.resource]?.actions ?? {}),
    Object.keys(entry.actions),
  ).filter((action) => {
    const implying = reachableFrom(schema, entry.resource, action);
    return implying.has(ceiling) && [...implying].some(held);
  });
  return kept.length
    ? {
        ...entry,
        actions: Object.fromEntries(kept.map((action) => [action, true])) as Partial<
          Record<Action, true>
        >,
      }
    : null;
};
