import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import {
  conditionMisses,
  type LensAt,
  lensAt,
  lensLimits,
  lensSize,
  relationPathProblem,
  type Under,
} from './lens';
import { listOf, relationOf, type SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';
import { validateActionRule } from './validateActionRule';

const relIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  at: LensAt,
  rule: ActionRule,
  path: string,
  seen?: Set<string>,
  computed = false,
): ValidationIssue[] => {
  const { resource, under } = at;
  const follow = (landed: LensAt, action: string): ValidationIssue[] => {
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
      relIssues(map, schema, at, child, `${path}.any[${i}]`, seen, computed),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(map, schema, at, child, `${path}.all[${i}]`, seen, computed),
    );
  if ('rule' in rule) return conditionMisses(map, at, rule.rule, path, { actor: true, computed });
  if ('arrayOperator' in rule) {
    if (under)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is a second list under an item of \`${under.list}\`: one list per walk`,
        },
      ];
    const list = listOf(map, resource, rule.rel);
    if (!list)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is not a declared list: mark the list field \`/// @permissions(down: [...])\``,
        },
      ];
    const item: Under = { list: `${resource}.${rule.rel}`, listRelation: list, prefix: [] };
    return relIssues(
      map,
      schema,
      lensAt(map, list.resource, item),
      rule.condition,
      `${path}.condition`,
      new Set(),
    );
  }
  let from = at;
  let run: string[] = [];
  let current = resource;
  const judge = (): ValidationIssue[] => {
    const problem = relationPathProblem(map, from, run.join('.'));
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
    from = lensAt(map, current);
    run = [];
  }
  const missed = judge();
  if (missed.length) return missed;
  if (!(rule.action in (schema.permissions[current]?.actions ?? {})))
    return [{ path, code: 'action', message: `\`${current}\` has no action \`${rule.action}\`` }];
  const landed = from.under
    ? lensAt(map, current, { ...from.under, prefix: [...from.under.prefix, ...run] })
    : lensAt(map, current);
  return under ? follow(landed, rule.action) : [];
};

/** Every action rule of a schema that is not well formed and positive, by `resource.action`. */
export const schemaRuleIssues = (schema: RebacSchema): ValidationIssue[] =>
  Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).errors.map((issue) => ({
        ...issue,
        path: `${resource}.${action}${issue.path.slice(1)}`,
      })),
    ),
  );

/** Every read of a well-formed action rule at `resource` (under an item: at its landing) outside the lens. */
export const actionRuleLensIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  resource: string,
  rule: ActionRule,
  at = '$',
  computed = false,
  under?: Under,
): ValidationIssue[] =>
  relIssues(
    map,
    schema,
    lensAt(map, resource, under),
    rule,
    at,
    under && new Set(),
    computed,
  ).filter((issue) => issue.code !== 'action');

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

/** Every read of a schema's action rules outside the lens, by `resource.action`. */
export const lensIssues = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] => [
  ...unmapped(map, schema),
  ...Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).ok
        ? actionRuleLensIssues(map, schema, resource, rule, `${resource}.${action}`)
        : [],
    ),
  ),
];

// why: a row that hydrates this much is doing too much; it is reported, not refused
const lensWarnings = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] =>
  Object.keys(schema.permissions).flatMap((resource) => {
    const size = lensSize(map, resource);
    return size > lensLimits.report
      ? [
          {
            path: resource,
            code: 'lensSize',
            message: `a \`${resource}\` row hydrates ${size} relations (over ${lensLimits.report}): split the walk, or mark an edge \`hydrate: false\``,
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
  const errors: ValidationIssue[] = [...unmapped(map, schema)];
  for (const [resource, permission] of Object.entries(schema.permissions)) {
    for (const [action, rule] of Object.entries(permission?.actions ?? {})) {
      const at = `${resource}.${action}`;
      const shape = validateActionRule(rule, { schema, resource, action });
      errors.push(
        ...shape.errors.map((issue) => ({ ...issue, path: `${at}${issue.path.slice(1)}` })),
      );
      if (shape.errors.every((issue) => issue.code === 'cycle'))
        errors.push(...relIssues(map, schema, lensAt(map, resource), rule, at));
    }
  }
  return { ok: errors.length === 0, errors, warnings: lensWarnings(map, schema) };
};
