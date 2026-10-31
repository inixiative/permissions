import { type ValidationIssue, type ValidationResult, validateRule } from '@inixiative/json-rules';
import { isPlainObject } from 'lodash-es';
import type { RebacSchema } from './types';

const hasOnly = (node: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(node).every((key) => keys.includes(key));

const issues = (rule: unknown, path: string): ValidationIssue[] => {
  if (rule === null || typeof rule === 'string' || typeof rule === 'boolean') return [];
  if (!isPlainObject(rule)) return [{ path, code: 'actionRule', message: 'not an action rule' }];
  const node = rule as Record<string, unknown>;
  if ('rel' in node && hasOnly(node, ['rel', 'action']))
    return typeof node.rel === 'string' && typeof node.action === 'string'
      ? []
      : [{ path, code: 'actionRule', message: '`rel` and `action` are strings' }];
  if ('rule' in node && hasOnly(node, ['rule']))
    return validateRule(node.rule, { positive: true }).errors.map((issue) => ({
      ...issue,
      path: `${path}.rule${issue.path.slice(1)}`,
    }));
  for (const key of ['any', 'all'] as const)
    if (key in node && hasOnly(node, [key]))
      return Array.isArray(node[key])
        ? (node[key] as unknown[]).flatMap((child, index) =>
            issues(child, `${path}.${key}[${index}]`),
          )
        : [{ path, code: 'actionRule', message: `\`${key}\` is an array` }];
  return [{ path, code: 'actionRule', message: 'not an action rule' }];
};

export type ActionRuleContext = {
  schema: RebacSchema;
  resource: string;
  action: string;
  rowRules?: Record<string, unknown> | null;
};

const delegatesOf = (rule: unknown): string[] => {
  if (typeof rule === 'string') return [rule];
  if (!isPlainObject(rule)) return [];
  const node = rule as Record<string, unknown>;
  for (const key of ['any', 'all'] as const)
    if (Array.isArray(node[key])) return (node[key] as unknown[]).flatMap(delegatesOf);
  return [];
};

const cycles = (rule: unknown, { schema, resource, action, rowRules }: ActionRuleContext) => {
  const actions = schema.permissions[resource]?.actions ?? {};
  const seen = new Set<string>();
  const pending = delegatesOf(rule);
  while (pending.length) {
    const next = pending.pop() as string;
    if (next === action)
      return [{ path: '$', code: 'cycle', message: `\`${action}\` delegates back to itself` }];
    if (seen.has(next)) continue;
    seen.add(next);
    pending.push(...delegatesOf(actions[next]), ...delegatesOf(rowRules?.[next]));
  }
  return [];
};

/**
 * An action rule's shape, and every `{ rule }` in it a positive json-rules condition. Given where
 * the rule sits (`context`), also refuses a rule that delegates back to its own action on the same
 * record, through the schema or the record's other rules.
 */
export const validateActionRule = (
  rule: unknown,
  context?: ActionRuleContext,
): ValidationResult => {
  const shape = issues(rule, '$');
  const errors = shape.length || !context ? shape : cycles(rule, context);
  return { ok: errors.length === 0, errors };
};
