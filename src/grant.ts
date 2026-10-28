import { createRebacCheck } from './check';
import type { EntitlementEntry } from './permix';
import type { SchemaMap } from './schemaMap';
import type { CheckOptions, PermixLike, RebacSchema, Row } from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  placed: Row,
) => boolean;

/**
 * Build the grant check, bound to the same schema map as the rebac check.
 *
 * A grant is an action: `canGrantEntitlement` holds when the writer (`permix`: its table, its own
 * entitlements, its actor) could take every action `entry` names on `placed`, the pseudo record
 * `placeEntitlement` builds from the hydrated anchor along the entry's path. A field it does not
 * carry is unknown (json-rules `absent: 'unknown'`), so the writer covers every record the
 * `where` admits.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  map: SchemaMap<R>,
  options: CheckOptions = {},
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(map, { ...options, absent: 'unknown' });

  return (permix, schema, entry, placed) => {
    const resource = entry.resource as R;
    return Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .every(([action]) => check(permix, schema, { resource, record: placed }, action));
  };
};
