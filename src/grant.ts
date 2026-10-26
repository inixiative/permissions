import { createRebacCheck } from './check';
import { pathTo } from './pathTo';
import type { EntitlementEntry } from './permix';
import { recordId } from './recordId';
import type { PermixLike, RebacSchema, ResolveRelation, Row } from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  anchor: Row,
) => boolean;

/**
 * Build the grant check, bound to the same relation resolver as the rebac check.
 *
 * A grant is an action: `canGrantEntitlement` holds when the writer (`permix`: its table, its own
 * entitlements, its actor) could take every action `entry` names, from `anchor` (the hydrated
 * record at `entry.anchor`). Each action is judged on a stand-in record of `entry.resource` placed
 * under the anchor along the resource's own `rel` tree, through the normal check: grant time
 * mirrors read time. A `where` only narrows, so it is not consulted: the writer covers the whole
 * collection at the anchor. The holder's read runs the action through the writer's walk on the real
 * record, so the rule's conditions (on the record and on `__actor`) hold there. An anchor off the
 * resource's tree, or one that is not the record `anchor` names, grants nothing.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(resolveRelation);

  return (permix, schema, entry, anchor) => {
    if (recordId(anchor) !== entry.anchor.id) return false;
    const resource = entry.resource as R;
    const path = pathTo(resolveRelation, schema, resource, entry.anchor.resource);
    if (!path) return false;

    const record = path.reduceRight<Row>((inner, field) => ({ [field]: inner }), anchor);
    const may = (action: string) => check(permix, schema, { resource, record }, action);

    return Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .every(([action]) => may(action));
  };
};
