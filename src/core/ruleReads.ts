import type { ValidationIssue } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import {
  issueRefusesTheRead,
  issuesForReadsOutsideLens,
  issuesOfSuppliedListArm,
  type LensesAtRow,
  lensesAtListItem,
  lensesAtRow,
  whyRelationPathCannotBeWalked,
} from './lens';
import { relationOf } from './relations';
import type { SchemaMap } from './schemaMap';
import { bridgesWalkedFromRecords, suppliedModelAt } from './supplied';
import type { ActionRule } from './types';

/** Walk a `{ rel }` path from `at` as a check hops it: the lenses where it lands, or why it cannot be walked. */
export const walkRelationPath = (
  schemaMap: SchemaMap,
  at: LensesAtRow,
  rel: string,
  path: string,
): { landed: LensesAtRow } | { issues: ValidationIssue[] } => {
  const { under } = at;
  let from = at;
  let run: string[] = [];
  let current = at.resource;
  const judge = (): ValidationIssue[] => {
    const problem = whyRelationPathCannotBeWalked(schemaMap, from, run.join('.'));
    return problem
      ? [{ path, code: problem.code === 'down' ? 'down' : 'relation', message: problem.message }]
      : [];
  };
  for (const segment of rel.split('.')) {
    const hop = bridgeHop(bridgesWalkedFromRecords(schemaMap), current, segment);
    if (!hop) {
      run.push(segment);
      const next = relationOf(schemaMap, current, segment);
      if (!next) return { issues: judge() };
      current = next.resource;
      continue;
    }
    if (under)
      return {
        issues: [
          {
            path,
            code: 'down',
            message: `\`${segment}\` is a bridge under an item of \`${under.list}\`: a walk under an item stays on the declared relations`,
          },
        ],
      };
    const missed = judge();
    if (missed.length) return { issues: missed };
    current = hop.farResource;
    from = lensesAtRow(schemaMap, current);
    run = [];
  }
  const missed = judge();
  if (missed.length) return { issues: missed };
  return {
    landed: from.under
      ? lensesAtRow(schemaMap, current, { ...from.under, prefix: [...from.under.prefix, ...run] })
      : lensesAtRow(schemaMap, current),
  };
};

/** Every read, action and operator issue of a well-formed rule at `at`. */
export const relIssues = (
  schemaMap: SchemaMap,
  at: LensesAtRow,
  rule: ActionRule,
  path: string,
  seen?: Set<string>,
): ValidationIssue[] => {
  const { resource, under } = at;
  const follow = (landed: LensesAtRow, action: string): ValidationIssue[] => {
    const key = `${landed.resource}\u0000${action}\u0000${landed.under?.prefix.join('.')}`;
    if (!seen || seen.has(key)) return [];
    seen.add(key);
    return relIssues(
      schemaMap,
      landed,
      schemaMap.permissions[landed.resource]?.actions[action] ?? null,
      path,
      seen,
    );
  };
  if (rule === null || typeof rule !== 'object') {
    if (typeof rule !== 'string') return [];
    if (!(rule in (schemaMap.permissions[resource]?.actions ?? {})))
      return [{ path, code: 'action', message: `\`${resource}\` has no action \`${rule}\`` }];
    return under ? follow(at, rule) : [];
  }
  if ('any' in rule)
    return rule.any.flatMap((child, i) =>
      relIssues(schemaMap, at, child, `${path}.any[${i}]`, seen),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(schemaMap, at, child, `${path}.all[${i}]`, seen),
    );
  if ('rule' in rule)
    return issuesForReadsOutsideLens(schemaMap, at, rule.rule, path, { supplied: true });
  if ('arrayOperator' in rule) {
    if (under)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is a second list under an item of \`${under.list}\`: one list per walk`,
        },
      ];
    if (suppliedModelAt(schemaMap, rule.rel.split('.')[0] ?? ''))
      return issuesOfSuppliedListArm(schemaMap, rule.rel, rule.condition, path);
    const item = lensesAtListItem(schemaMap, resource, rule.rel);
    if (!item)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is not a declared list: mark the list field \`/// @permissions(down: [...])\``,
        },
      ];
    return relIssues(schemaMap, item, rule.condition, `${path}.condition`, new Set());
  }
  const walked = walkRelationPath(schemaMap, at, rule.rel, path);
  if ('issues' in walked) return walked.issues;
  if (!(rule.action in (schemaMap.permissions[walked.landed.resource]?.actions ?? {})))
    return [
      {
        path,
        code: 'action',
        message: `\`${walked.landed.resource}\` has no action \`${rule.action}\``,
      },
    ];
  const landed = walked.landed;
  return under ? follow(landed, rule.action) : [];
};

/** Whether a check refuses on this issue: a read it cannot make, not an action that does not exist (it denies) nor an operator that does not fit. */
export const isRefusedByACheck = (issue: ValidationIssue): boolean =>
  issue.code !== 'action' && issueRefusesTheRead(issue);

/** Every read of a well-formed action rule at `resource` that a check refuses: outside the lens, a relation it cannot walk, a list it does not declare. */
export const issuesForRuleReadsOutsideLens = (
  schemaMap: SchemaMap,
  resource: string,
  rule: ActionRule,
  at = '$',
): ValidationIssue[] =>
  relIssues(schemaMap, lensesAtRow(schemaMap, resource), rule, at).filter(isRefusedByACheck);
