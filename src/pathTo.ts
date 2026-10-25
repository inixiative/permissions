import { parentFields } from './parentFields';
import type { RebacSchema, ResolveRelation } from './types';

// The relation fields that lead from `resource` to `target` along the resource's own `rel` tree.
export const pathTo = <R extends string>(
  resolveRelation: ResolveRelation<R>,
  schema: RebacSchema<R>,
  resource: R,
  target: string,
  seen: Set<string> = new Set(),
): string[] | null => {
  if (resource === target) return [];
  if (seen.has(resource)) return null;
  seen.add(resource);
  for (const field of parentFields(schema, resource)) {
    const next = resolveRelation(resource, field);
    const rest = next === null ? null : pathTo(resolveRelation, schema, next, target, seen);
    if (rest) return [field, ...rest];
  }
  return null;
};
