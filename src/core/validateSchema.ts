import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import {
  countRelationsOneRowHydrates,
  issueRefusesTheRead,
  issuesForReadsOutsideLens,
  type LensesAtRow,
  lensesAtListItem,
  lensesAtRow,
  relationLensLimits,
  whyRelationPathCannotBeWalked,
} from './lens';
import { relationOf, type SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';
import { validateActionRule } from './validateActionRule';

const relIssues = (
  map: SchemaMap,
  schema: RebacSchema,
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
      map,
      schema,
      landed,
      schema.permissions[landed.resource]?.actions[action] ?? null,
      path,
      seen,
    );
  };
  if (rule === null || typeof rule !== 'object') {
    if (typeof rule !== 'string') return [];
    if (!(rule in (schema.permissions[resource]?.actions ?? {})))
      return [{ path, code: 'action', message: `\`${resource}\` has no action \`${rule}\`` }];
    return under ? follow(at, rule) : [];
  }
  if ('any' in rule)
    return rule.any.flatMap((child, i) =>
      relIssues(map, schema, at, child, `${path}.any[${i}]`, seen),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(map, schema, at, child, `${path}.all[${i}]`, seen),
    );
  if ('rule' in rule) return issuesForReadsOutsideLens(map, at, rule.rule, path, { actor: true });
  if ('arrayOperator' in rule) {
    if (under)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is a second list under an item of \`${under.list}\`: one list per walk`,
        },
      ];
    const item = lensesAtListItem(map, resource, rule.rel);
    if (!item)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is not a declared list: mark the list field \`/// @permissions(down: [...])\``,
        },
      ];
    return relIssues(map, schema, item, rule.condition, `${path}.condition`, new Set());
  }
  let from = at;
  let run: string[] = [];
  let current = resource;
  const judge = (): ValidationIssue[] => {
    const problem = whyRelationPathCannotBeWalked(map, from, run.join('.'));
    return problem
      ? [{ path, code: problem.code === 'down' ? 'down' : 'relation', message: problem.message }]
      : [];
  };
  for (const segment of rule.rel.split('.')) {
    const hop = bridgeHop(schema.bridges, current, segment);
    if (!hop) {
      run.push(segment);
      const next = relationOf(map, current, segment);
      if (!next) return judge();
      current = next.resource;
      continue;
    }
    if (under)
      return [
        {
          path,
          code: 'down',
          message: `\`${segment}\` is a bridge under an item of \`${under.list}\`: a walk under an item stays on the declared relations`,
        },
      ];
    const missed = judge();
    if (missed.length) return missed;
    current = hop.farResource;
    from = lensesAtRow(map, current);
    run = [];
  }
  const missed = judge();
  if (missed.length) return missed;
  if (!(rule.action in (schema.permissions[current]?.actions ?? {})))
    return [{ path, code: 'action', message: `\`${current}\` has no action \`${rule.action}\`` }];
  const landed = from.under
    ? lensesAtRow(map, current, { ...from.under, prefix: [...from.under.prefix, ...run] })
    : lensesAtRow(map, current);
  return under ? follow(landed, rule.action) : [];
};

const issuesOfEveryActionRule = (
  schema: RebacSchema,
  judgedInItsSchema: boolean,
): ValidationIssue[] =>
  Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(
        rule,
        judgedInItsSchema ? { schema, resource, action } : undefined,
      ).errors.map((issue) => ({ ...issue, path: `${resource}.${action}${issue.path.slice(1)}` })),
    ),
  );

/** Every action rule of a schema that is not well formed and positive, by `resource.action`. */
export const schemaRuleIssues = (schema: RebacSchema): ValidationIssue[] =>
  issuesOfEveryActionRule(schema, false);

/** Every read of a well-formed action rule at `resource` outside the lens. */
export const issuesForRuleReadsOutsideLens = (
  map: SchemaMap,
  schema: RebacSchema,
  resource: string,
  rule: ActionRule,
  at = '$',
): ValidationIssue[] =>
  relIssues(map, schema, lensesAtRow(map, resource), rule, at).filter(
    (issue) => issue.code !== 'action' && issueRefusesTheRead(issue),
  );

// why: a resource with no model in the map has no lens, so nothing it reads could be refused
const unmapped = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] => {
  const far = new Set(
    (schema.bridges ?? []).flatMap((bridge) =>
      bridge.endpoints.map((end) => `${end.fieldMap}:${end.model}`),
    ),
  );
  return Object.keys(schema.permissions)
    .filter((resource) => !map.resources[resource] && !far.has(resource))
    .map((resource) => ({
      path: resource,
      code: 'lens',
      message: `\`${resource}\` is not a resource in the map: add it to \`resources\`, or nothing it reads is checked`,
    }));
};

// Every read, action and operator issue of a schema's well-formed rules, by `resource.action`.
const readIssues = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] => [
  ...unmapped(map, schema),
  ...Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).ok
        ? relIssues(map, schema, lensesAtRow(map, resource), rule, `${resource}.${action}`)
        : [],
    ),
  ),
];

/** Every read of a schema's action rules outside the lens, by `resource.action`. */
export const schemaIssuesRefusedOnFirstUse = (
  map: SchemaMap,
  schema: RebacSchema,
): ValidationIssue[] =>
  readIssues(map, schema).filter((issue) => issue.code !== 'action' && issueRefusesTheRead(issue));

// why: a row that hydrates this much is doing too much; it is reported, not refused
const lensWarnings = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] =>
  Object.keys(schema.permissions).flatMap((resource) => {
    const size = countRelationsOneRowHydrates(map, resource);
    return size > relationLensLimits.report
      ? [
          {
            path: resource,
            code: 'countRelationsOneRowHydrates',
            message: `a \`${resource}\` row hydrates ${size} relations (over ${relationLensLimits.report}): split the walk, or mark an edge \`hydrate: false\``,
          },
        ]
      : [];
  });

/**
 * A whole schema against the map, for a test or boot: well formed, positive, inside the lens,
 * every action defined (`errors`), and every resource whose row hydrates too much (`warnings`).
 */
export const validateSchema = (
  map: SchemaMap,
  schema: RebacSchema,
): ValidationResult & { warnings: ValidationIssue[] } => {
  const errors = [...issuesOfEveryActionRule(schema, true), ...readIssues(map, schema)];
  return { ok: errors.length === 0, errors, warnings: lensWarnings(map, schema) };
};
