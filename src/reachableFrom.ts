import type { ActionRule, RebacSchema } from './types';

const pureDelegates = (rule: ActionRule | undefined): string[] => {
  if (typeof rule === 'string') return [rule];
  if (typeof rule === 'object' && rule !== null && 'any' in rule && Object.keys(rule).length === 1)
    return rule.any.filter((arm): arm is string => typeof arm === 'string');
  return [];
};

export const reachableFrom = (
  schema: RebacSchema,
  resource: string,
  action: string,
): Set<string> => {
  const actions = schema.permissions[resource]?.actions ?? {};
  const reached = new Set<string>();
  const climb = (current: string) => {
    if (reached.has(current)) return;
    reached.add(current);
    for (const next of pureDelegates(actions[current])) climb(next);
  };
  climb(action);
  return reached;
};
