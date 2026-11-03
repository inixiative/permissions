import { listFields } from '@inixiative/json-rules';
import { relationOf, type SchemaMap } from './schemaMap';
import type { ActionRule, RebacSchema } from './types';

/** The relations a schema's rules walk, by resource: the segments `{ rel }` paths and `{ rule }` fields cross. */
export type WalkedRelations = Map<string, Set<string>>;

// What an action rule reads off its record: each `{ rel }` path, and each field a `{ rule }` reads
// there (not `__actor`, not a scope reference).
const pathsOf = (rule: ActionRule): string[] => {
  if (rule === null || typeof rule !== 'object') return [];
  if ('rel' in rule) return [rule.rel];
  if ('rule' in rule)
    return listFields(rule.rule).filter(
      (path) => !path.startsWith('__actor') && !path.startsWith('$'),
    );
  if ('any' in rule) return rule.any.flatMap(pathsOf);
  if ('all' in rule) return rule.all.flatMap(pathsOf);
  return [];
};

const addPath = (map: SchemaMap, walked: WalkedRelations, resource: string, path: string) => {
  let current = resource;
  for (const segment of path.split('.')) {
    const relation = relationOf(map, current, segment);
    if (!relation) return;
    const segments = walked.get(current) ?? new Set<string>();
    segments.add(segment);
    walked.set(current, segments);
    current = relation.resource;
  }
};

/** Add the relations `rules` walk from `resource` to `walked`. */
export const walkRules = (
  map: SchemaMap,
  walked: WalkedRelations,
  resource: string,
  rules: Iterable<ActionRule>,
): WalkedRelations => {
  for (const rule of rules) for (const path of pathsOf(rule)) addPath(map, walked, resource, path);
  return walked;
};

/**
 * Every to-one relation the schema's rules walk, by resource: a `{ rel }` path's segments, and the
 * relations a `{ rule }` reads a field through. A bridge hop is looked up, never loaded, so it ends
 * the path.
 */
export const walkedRelations = (map: SchemaMap, schema: RebacSchema): WalkedRelations => {
  const walked: WalkedRelations = new Map();
  for (const [resource, permission] of Object.entries(schema.permissions))
    walkRules(map, walked, resource, Object.values(permission?.actions ?? {}));
  return walked;
};
