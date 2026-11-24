import {
  ArrayOperator,
  type ValidationIssue,
  type ValidationResult,
  validateRule,
} from '@inixiative/json-rules';
import { isPlainObject } from 'lodash-es';
import {
  issuesOfDelegationBackToOwnAction,
  type PlaceOfActionRule,
} from './issuesOfDelegationBackToOwnAction';
import { idField } from './recordId';
import { resolvedSchemaMap } from './resolvedSchemaMap';
import { issuesForRuleReadsOutsideLens, whyResourceIsNoPlaceForARule } from './ruleReads';
import type { ActionRule } from './types';

const hasOnly = (node: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(node).every((key) => keys.includes(key));

const arrayOperators: readonly unknown[] = Object.values(ArrayOperator);

const listIssues = (node: Record<string, unknown>, path: string): ValidationIssue[] => {
  const fromSuppliedRow = typeof node.rel === 'string' && node.rel.split('.')[0]?.includes(':');
  if (
    typeof node.rel !== 'string' ||
    node.rel === '' ||
    (node.rel.includes('.') && !fromSuppliedRow)
  )
    return [
      {
        path,
        code: 'actionRule',
        message:
          '`rel` names one list relation, or a list on a supplied row (`actor:User.devices`)',
      },
    ];
  if (node.arrayOperator !== ArrayOperator.any)
    return arrayOperators.includes(node.arrayOperator)
      ? [
          {
            path: `${path}.arrayOperator`,
            code: 'arrayOperator',
            message: `\`${String(node.arrayOperator)}\` is refused: only \`any\` (some item passes) crosses a list, the rest hold on no rows or count them`,
          },
        ]
      : [{ path, code: 'actionRule', message: '`arrayOperator` is `any`' }];
  if (!('condition' in node))
    return [{ path, code: 'actionRule', message: '`condition` is the rule judged on each item' }];
  return issues(node.condition, `${path}.condition`);
};

const issues = (rule: unknown, path: string): ValidationIssue[] => {
  if (rule === null || typeof rule === 'string' || typeof rule === 'boolean') return [];
  if (!isPlainObject(rule)) return [{ path, code: 'actionRule', message: 'not an action rule' }];
  const node = rule as Record<string, unknown>;
  if ('rel' in node && hasOnly(node, ['rel', 'action']))
    return typeof node.rel === 'string' && typeof node.action === 'string'
      ? []
      : [{ path, code: 'actionRule', message: '`rel` and `action` are strings' }];
  if ('arrayOperator' in node && hasOnly(node, ['rel', 'arrayOperator', 'condition']))
    return listIssues(node, path);
  if ('rule' in node && hasOnly(node, ['rule']))
    return validateRule(node.rule, { positive: true, rowKey: idField() }).errors.map((issue) => ({
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

/** Where a rule sits: a {@link PlaceOfActionRule}, with no `action` for a rule asked inline or kept outside the map. */
export type ActionRuleContext = Omit<PlaceOfActionRule, 'action'> & { action?: string };

// A rule's shape and positivity; only a well-formed rule is judged further.
const issuesOfShapeOrElse = (rule: unknown, more: () => ValidationIssue[]): ValidationIssue[] => {
  const shape = issues(rule, '$');
  return shape.length ? shape : more();
};

/** A rule's shape and positivity, then a cycle back to its own action; no reads. */
export const issuesOfShapeAndCycle = (rule: unknown, place: PlaceOfActionRule): ValidationIssue[] =>
  issuesOfShapeOrElse(rule, () => issuesOfDelegationBackToOwnAction(rule, place));

/**
 * What a check refuses in an action rule: its shape, and every `{ rule }` in it a positive
 * json-rules condition. Given where the rule sits (`context`), also a rule that delegates back to
 * its own action on the same record (through the map's rules, the record's other rules or the
 * additional rule sets) and every read outside the lens at its resource.
 */
export const validateActionRule = (
  rule: unknown,
  context?: ActionRuleContext,
): ValidationResult => {
  const whyNoPlace = context
    ? whyResourceIsNoPlaceForARule(resolvedSchemaMap(context.schemaMap), context.resource)
    : null;
  if (whyNoPlace) return { ok: false, errors: [{ path: '$', code: 'lens', message: whyNoPlace }] };
  const errors = issuesOfShapeOrElse(rule, () =>
    context
      ? [
          ...(context.action === undefined
            ? []
            : issuesOfDelegationBackToOwnAction(rule, { ...context, action: context.action })),
          ...issuesForRuleReadsOutsideLens(
            resolvedSchemaMap(context.schemaMap),
            context.resource,
            rule as ActionRule,
          ),
        ]
      : [],
  );
  return { ok: errors.length === 0, errors };
};
