import { type ValidationIssue, type ValidationResult, validateRule } from '@inixiative/json-rules';
import { isPlainObject } from 'lodash-es';

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

/** An action rule's shape, and every `{ rule }` in it a positive json-rules condition. */
export const validateActionRule = (rule: unknown): ValidationResult => {
  const errors = issues(rule, '$');
  return { ok: errors.length === 0, errors };
};
