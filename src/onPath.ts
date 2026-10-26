import { parentFields } from './parentFields';
import { recordId } from './recordId';
import type { Anchor, RebacSchema, ResolveRelation, Row } from './types';

// The anchor is the record itself or an ancestor on the resource's natural tree: the relations
// the schema's own `rel` arms name for that resource, nothing else. A hydrated sideways foreign
// key (`replacedBy`, `defaultIntegration`) is not an anchor. Off the tree, the entitlement is
// not acting from where it says.
export const onPath = <R extends string>(
  resolveRelation: ResolveRelation<R>,
  schema: RebacSchema<R>,
  resource: R,
  record: Row,
  anchor: Anchor,
  seen: WeakSet<object> = new WeakSet(),
): boolean => {
  if (seen.has(record)) return false;
  seen.add(record);
  if (resource === anchor.resource && recordId(record) === anchor.id) return true;
  return [...parentFields(schema, resource)].some((field) => {
    const value = record[field];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const next = resolveRelation(resource, field);
    return next !== null && onPath(resolveRelation, schema, next, value as Row, anchor, seen);
  });
};
