import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import { resolveField, type SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';
import { validateActionRule } from './validateActionRule';

const relIssues = (
  map: SchemaMap,
  schema: RebacSchema,
  resource: string,
  rule: ActionRule,
  path: string,
): ValidationIssue[] => {
  if (rule === null || typeof rule !== 'object') {
    if (typeof rule === 'string' && !(rule in (schema.permissions[resource]?.actions ?? {})))
      return [{ path, code: 'action', message: `\`${resource}\` has no action \`${rule}\`` }];
    return [];
  }
  if ('any' in rule)
    return rule.any.flatMap((child, i) =>
      relIssues(map, schema, resource, child, `${path}.any[${i}]`),
    );
  if ('all' in rule)
    return rule.all.flatMap((child, i) =>
      relIssues(map, schema, resource, child, `${path}.all[${i}]`),
    );
  if (!('rel' in rule)) return [];
  let current = resource;
  for (const segment of rule.rel.split('.')) {
    const hop = bridgeHop(schema.bridges, current, segment);
    const next = hop ? hop.farResource : resolveField(map, current, segment);
    if (!next)
      return [{ path, code: 'relation', message: `\`${current}\` has no relation \`${segment}\`` }];
    current = next;
  }
  return rule.action in (schema.permissions[current]?.actions ?? {})
    ? []
    : [{ path, code: 'action', message: `\`${current}\` has no action \`${rule.action}\`` }];
};

/**
 * A whole schema checked against the map, for a test or boot: every action rule well formed and
 * positive (`validateActionRule`), every `{ rel }` segment a relation
 * or a bridge, and every action a rule names defined where it lands. A rule that names a relation
 * the map doesn't have otherwise denies forever without saying why.
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
      errors.push(...relIssues(map, schema, resource, rule, at));
    }
  }
  return { ok: errors.length === 0, errors };
};
