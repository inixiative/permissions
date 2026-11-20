import type { ValidationIssue, ValidationResult } from '@inixiative/json-rules';
import { isPlainObject } from 'lodash-es';
import type { SchemaMap } from './schemaMap';
import type { RebacSchema } from './types';
import { issuesForActionRuleAt } from './validateSchema';

const notAMap = (path: string, of: string): ValidationIssue[] => [
  { path, code: 'tenantPermissionRules', message: `not a map of ${of}` },
];

/**
 * A tenant's `tenantPermissionRules` before it is saved: every resource is one the schema gives
 * `tenantPaths`, every action one that resource already has, and every rule well formed, positive
 * and free of a loop back to its own action. With the `map`, every read is inside the lens too.
 */
export const validateTenantPermissionRules = (
  rules: unknown,
  { schema, map }: { schema: RebacSchema; map?: SchemaMap },
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
      if (!permission.tenantPaths?.length)
        return [
          {
            path: resource,
            code: 'tenantPaths',
            message: `\`${resource}\` declares no \`tenantPaths\`, so no record of it reads a tenant's rules`,
          },
        ];
      if (!isPlainObject(byAction)) return notAMap(resource, 'action to its rule');
      const tenantRules = [byAction as Record<string, unknown>];
      return Object.entries(byAction as Record<string, unknown>).flatMap(([action, rule]) => {
        const path = `${resource}.${action}`;
        if (!(action in permission.actions))
          return [{ path, code: 'action', message: `\`${resource}\` has no action \`${action}\`` }];
        const found = issuesForActionRuleAt(rule, { schema, resource, action, tenantRules }, map);
        return found.map((issue) => ({ ...issue, path: `${path}${issue.path.slice(1)}` }));
      });
    },
  );
  return { ok: errors.length === 0, errors };
};
