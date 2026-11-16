import { isPlainObject } from 'lodash-es';
import { answerOnce } from './freezeThenJudgeOnce';
import type { RebacSchema } from './types';

type Delegates = (rule: unknown) => string[];

/** The actions an action is implied by: a bare name, or the bare names of a top-level `any`. */
const pureDelegates: Delegates = (rule) => {
  if (typeof rule === 'string') return [rule];
  if (!isPlainObject(rule)) return [];
  const node = rule as Record<string, unknown>;
  return Object.keys(node).length === 1 && Array.isArray(node.any)
    ? node.any.filter((arm): arm is string => typeof arm === 'string')
    : [];
};

/** Every action name a rule reaches through any `any`/`all`. */
export const allDelegates: Delegates = (rule) => {
  if (typeof rule === 'string') return [rule];
  if (!isPlainObject(rule)) return [];
  const node = rule as Record<string, unknown>;
  for (const key of ['any', 'all'] as const)
    if (Array.isArray(node[key])) return (node[key] as unknown[]).flatMap(allDelegates);
  return [];
};

/** Every action delegation reaches from `start`, each start included; `rulesOf` gives an action's rules. */
export const delegationReach = (
  start: readonly string[],
  rulesOf: (action: string) => unknown[],
  delegates: Delegates,
): Set<string> => {
  const reached = new Set<string>();
  const pending = [...start];
  while (pending.length) {
    const next = pending.pop() as string;
    if (reached.has(next)) continue;
    reached.add(next);
    pending.push(...rulesOf(next).flatMap(delegates));
  }
  return reached;
};

const reached = new WeakMap<RebacSchema, Map<string, ReadonlySet<string>>>();

// why: a schema is frozen on first use, so what an action is implied by never changes
export const reachableFrom = (
  schema: RebacSchema,
  resource: string,
  action: string,
): ReadonlySet<string> => {
  const actions = schema.permissions[resource]?.actions ?? {};
  return answerOnce(
    reached,
    schema,
    `${resource}\u0000${action}`,
    () => delegationReach([action], (next) => [actions[next]], pureDelegates),
    Object.isFrozen(schema),
  );
};
