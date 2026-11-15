import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import { conditionMisses, type LensNode, lensOf, stepLens, type Under } from './lens';
import type { SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';
import { validateActionRule } from './validateActionRule';

type Walking = Under & { seen: Set<string> };

const relIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  node: LensNode,
  rule: ActionRule,
  path: string,
  under?: Walking,
  computed = false,
): ValidationIssue[] => {
  const resource = node.resource;
  const follow = (landed: LensNode, action: string, at: Walking): ValidationIssue[] => {
    const key = `${landed.resource}\u0000${action}\u0000${at.prefix.join('.')}`;
    if (at.seen.has(key)) return [];
    at.seen.add(key);
    return relIssues(
      map,
      schema,
      landed,
      schema.permissions[landed.resource]?.actions[action] ?? null,
      path,
      at,
    );
  };
  if (rule === null || typeof rule !== 'object') {
    if (typeof rule !== 'string') return [];
    if (!(rule in (schema.permissions[resource]?.actions ?? {})))
      return [{ path, code: 'action', message: `\`${resource}\` has no action \`${rule}\`` }];
    return under ? follow(node, rule, under) : [];
  }
  if ('any' in rule)
    return rule.any.flatMap((child, i) =>
      relIssues(map, schema, node, child, `${path}.any[${i}]`, under, computed),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(map, schema, node, child, `${path}.all[${i}]`, under, computed),
    );
  if ('rule' in rule)
    return conditionMisses(map, node, rule.rule, path, {
      actor: true,
      computed,
      ...(under ? { under } : {}),
    });
  if ('arrayOperator' in rule) {
    if (under)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is a second list under an item of \`${under.list}\`: one list per walk`,
        },
      ];
    const list = node.lists.get(rule.rel);
    if (!list)
      return [
        {
          path,
          code: 'down',
          message: `\`${resource}.${rule.rel}\` is not a declared list: mark the list field \`/// @permissions(down: [...])\``,
        },
      ];
    return relIssues(map, schema, list.item, rule.condition, `${path}.condition`, {
      list: `${resource}.${rule.rel}`,
      prefix: [],
      seen: new Set(),
    });
  }
  let current = node;
  let prefix = under?.prefix ?? [];
  for (const segment of rule.rel.split('.')) {
    const hop = bridgeHop(schema.bridges, current.resource, segment);
    if (hop) {
      if (under)
        return [
          {
            path,
            code: 'down',
            message: `\`${segment}\` is a bridge under an item of \`${under.list}\`: a walk under an item stays on the declared relations`,
          },
        ];
      current = lensOf(map, hop.farResource);
      continue;
    }
    const step = stepLens(map, current, segment, under && { ...under, prefix });
    if ('miss' in step)
      return [{ path, ...step.miss, code: step.miss.code === 'down' ? 'down' : 'relation' }];
    if (!('next' in step))
      return [
        {
          path,
          code: 'relation',
          message: `\`${current.resource}\` has no relation \`${segment}\``,
        },
      ];
    prefix = [...prefix, segment];
    current = step.next;
  }
  if (!(rule.action in (schema.permissions[current.resource]?.actions ?? {})))
    return [
      {
        path,
        code: 'action',
        message: `\`${current.resource}\` has no action \`${rule.action}\``,
      },
    ];
  return under ? follow(current, rule.action, { ...under, prefix }) : [];
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

/** Every read of a well-formed action rule at `resource` outside the lens (`computed`: the caller built the root). */
export const actionRuleLensIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  resource: string,
  rule: ActionRule,
  at = '$',
  computed = false,
): ValidationIssue[] =>
  relIssues(map, schema, lensOf(map, resource), rule, at, undefined, computed).filter(
    (issue) => issue.code !== 'action',
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

/** A whole schema against the map, for a test or boot: well formed, positive, inside the lens, every action defined. */
export const validateSchema = (map: SchemaMap, schema: RebacSchema): ValidationResult => {
  const errors: ValidationIssue[] = [...unmapped(map, schema)];
  for (const [resource, permission] of Object.entries(schema.permissions)) {
    for (const [action, rule] of Object.entries(permission?.actions ?? {})) {
      const at = `${resource}.${action}`;
      const shape = validateActionRule(rule, { schema, resource, action });
      errors.push(
        ...shape.errors.map((issue) => ({ ...issue, path: `${at}${issue.path.slice(1)}` })),
      );
      if (shape.errors.every((issue) => issue.code === 'cycle'))
        errors.push(...relIssues(map, schema, lensOf(map, resource), rule, at));
    }
  }
  return { ok: errors.length === 0, errors };
};
