import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import { conditionMisses, listMessage, notLoaded, outsideMessage, type Under } from './lens';
import { fieldOf, type LensNode, lensOf, listOf, relationOf, type SchemaMap } from './schemaMap';
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
      relIssues(map, schema, node, child, `${path}.any[${i}]`, under),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(map, schema, node, child, `${path}.all[${i}]`, under),
    );
  if ('rule' in rule) return conditionMisses(map, node, rule.rule, path, under);
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
    const field = fieldOf(map, current.resource, segment);
    if (field?.kind === 'object' && field.isList)
      return [{ path, code: 'relation', message: listMessage(map, current.resource, segment) }];
    if (!current.toOne.has(segment)) {
      if (under && relationOf(map, current.resource, segment))
        return [{ path, ...notLoaded(under, [...prefix, segment]) }];
      return [
        {
          path,
          code: 'relation',
          message:
            field?.kind === 'object' || field?.kind === 'bridge'
              ? outsideMessage(map, current.resource, segment)
              : `\`${current.resource}\` has no relation \`${segment}\``,
        },
      ];
    }
    prefix = [...prefix, segment];
    current = current.below(segment);
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

/**
 * Every read of one well-formed action rule at `resource` that leaves the lens: a `{ rel }`
 * segment that is not a relation hydration follows (code `relation`), a path a `{ rule }` reads
 * outside it (code `lens`), and a list arm the declarations do not carry or a walk under an item
 * outside its declared paths (code `down`). An action the rule names but nothing defines is not
 * here (`validateSchema` reports it).
 */
export const actionRuleLensIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  resource: string,
  rule: ActionRule,
  at = '$',
): ValidationIssue[] =>
  relIssues(map, schema, lensOf(map, resource), rule, at).filter(
    (issue) => issue.code !== 'action',
  );

/**
 * Every read of a schema's action rules that leaves the lens, by `resource.action`
 * ({@link actionRuleLensIssues}). A check refuses a schema that has one, on first use.
 */
export const lensIssues = (map: SchemaMap, schema: RebacSchema): ValidationIssue[] =>
  Object.entries(schema.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).ok
        ? actionRuleLensIssues(map, schema, resource, rule, `${resource}.${action}`)
        : [],
    ),
  );

/**
 * A whole schema checked against the map, for a test or boot: every action rule well formed and
 * positive (`validateActionRule`), every read inside the lens ({@link lensIssues}), and every
 * action a rule names defined where it lands. A rule that names a relation the map doesn't have
 * otherwise denies forever without saying why.
 */
export const validateSchema = (map: SchemaMap, schema: RebacSchema): ValidationResult => {
  const errors: ValidationIssue[] = [];
  for (const [resource, permission] of Object.entries(schema.permissions)) {
    for (const [action, rule] of Object.entries(permission?.actions ?? {})) {
      const at = `${resource}.${action}`;
      const shape = validateActionRule(rule, { schema, resource, action });
      errors.push(
        ...shape.errors.map((issue) => ({ ...issue, path: `${at}${issue.path.slice(1)}` })),
      );
      if (validateActionRule(rule).ok)
        errors.push(...relIssues(map, schema, lensOf(map, resource), rule, at));
    }
  }
  return { ok: errors.length === 0, errors };
};
