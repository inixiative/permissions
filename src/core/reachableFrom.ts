import { isPlainObject } from 'lodash-es';
import type { RebacSchema } from './types';

/**
 * The actions `rule` delegates to by name. `pure`: only a bare name or a top-level `any`'s bare
 * names (what an action is implied by); otherwise every name in any `any`/`all` (what it can reach).
 */
export const delegatesOf = (rule: unknown, pure: boolean): string[] => {
  if (typeof rule === 'string') return [rule];
  if (!isPlainObject(rule)) return [];
  const node = rule as Record<string, unknown>;
  if (pure)
    return Object.keys(node).length === 1 && Array.isArray(node.any)
      ? node.any.filter((arm): arm is string => typeof arm === 'string')
      : [];
  for (const key of ['any', 'all'] as const)
    if (Array.isArray(node[key]))
      return (node[key] as unknown[]).flatMap((child) => delegatesOf(child, false));
  return [];
};

/** Every action delegation reaches from `start`, each start included; `rulesOf` gives an action's rules. */
export const delegationReach = (
  start: readonly string[],
  rulesOf: (action: string) => unknown[],
  pure: boolean,
): Set<string> => {
  const reached = new Set<string>();
  const pending = [...start];
  while (pending.length) {
    const next = pending.pop() as string;
    if (reached.has(next)) continue;
    reached.add(next);
    pending.push(...rulesOf(next).flatMap((rule) => delegatesOf(rule, pure)));
  }
  return reached;
};

export const reachableFrom = (
  schema: RebacSchema,
  resource: string,
  action: string,
): Set<string> => {
  const actions = schema.permissions[resource]?.actions ?? {};
  return delegationReach([action], (next) => [actions[next]], true);
};
