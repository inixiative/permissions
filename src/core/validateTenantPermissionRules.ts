import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { isPlainObject } from 'lodash-es';
import { relationOf, type SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';
import { validateActionRule } from './validateActionRule';
import {
  issuesForActionRuleAt,
  issuesForUndefinedActions,
  pathOfTenantPath,
} from './validateSchema';

const notAMap = (path: string, of: string): ValidationIssue[] => [
  { path, code: 'tenantPermissionRules', message: `not a map of ${of}` },
];

// The resource a relation path lands on from `resource`, or undefined when it cannot be walked.
const resourceAtPath = (map: SchemaMap, resource: string, path: string): string | undefined =>
  path
    .split('.')
    .reduce<string | undefined>(
      (current, segment) => current && relationOf(map, current, segment)?.resource,
      resource,
    );

/**
 * A tenant's `tenantPermissionRules` before it is saved: every resource is one the schema gives
 * `tenantPaths`, every action one that resource already has, and every rule well formed, positive
 * and free of a loop back to its own action. With the `map`, every read is inside the lens and
 * every action a rule names exists. With `tenant` (the resource of the row being written) too,
 * every resource is one whose records can reach a row of that kind.
 */
export const validateTenantPermissionRules = (
  rules: unknown,
  { schema, map, tenant }: { schema: RebacSchema; map?: SchemaMap; tenant?: string },
): ValidationResult => {
  if (rules === null || rules === undefined) return { ok: true, errors: [] };
  if (!isPlainObject(rules)) return { ok: false, errors: notAMap('$', 'resource to its rules') };
  const errors = Object.entries(rules as Record<string, unknown>).flatMap(
    ([resource, byAction]): ValidationIssue[] => {
      const permission = schema.permissions[resource];
      if (!permission)
        return [
          { path: resource, code: 'resource', message: `\`${resource}\` is not in the schema` },
        ];
      const tenantPaths = (permission.tenantPaths ?? []).map(pathOfTenantPath);
      if (!tenantPaths.length)
        return [
          {
            path: resource,
            code: 'tenantPaths',
            message: `\`${resource}\` declares no \`tenantPaths\`, so no record of it reads a tenant's rules`,
          },
        ];
      if (
        map &&
        tenant &&
        !tenantPaths.some((path) => resourceAtPath(map, resource, path) === tenant)
      )
        return [
          {
            path: resource,
            code: 'tenantPaths',
            message: `no \`${resource}\` record reads the rules of a \`${tenant}\``,
          },
        ];
      if (!isPlainObject(byAction)) return notAMap(resource, 'action to its rule');
      const tenantRules = [byAction as Record<string, unknown>];
      return Object.entries(byAction as Record<string, unknown>).flatMap(([action, rule]) => {
        const path = `${resource}.${action}`;
        if (!(action in permission.actions))
          return [{ path, code: 'action', message: `\`${resource}\` has no action \`${action}\`` }];
        const context = { schema, resource, action, tenantRules };
        const refused = issuesForActionRuleAt(rule, context, map);
        const found =
          refused.length || !map || !validateActionRule(rule).ok
            ? refused
            : issuesForUndefinedActions(map, schema, resource, rule as ActionRule);
        return found.map((issue) => ({ ...issue, path: `${path}${issue.path.slice(1)}` }));
      });
    },
  );
  return { ok: errors.length === 0, errors };
};
