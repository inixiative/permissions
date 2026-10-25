import { createRebacCheck } from './check';
import { isConditionalEntitlement } from './conditionalEntitlement';
import { pathTo } from './pathTo';
import type { EntitlementEntry } from './permix';
import { recordId } from './recordId';
import type { PermixLike, RebacSchema, ResolveRelation, Row } from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  position: Row,
) => boolean;

/**
 * Build the grant check, bound to the same relation resolver as the rebac check.
 *
 * A grant is an action: `canGrantEntitlement` holds when the writer (`permix`: its table, its own
 * entitlements, its actor) could take every action `entry` names, from `position` (the hydrated
 * record at `entry.from`). Each action is judged on a stand-in record of `entry.resource` placed
 * under the position along the resource's own `rel` tree, through the normal check: grant time
 * mirrors read time. A `where` only narrows, so it is not consulted: the writer covers the whole
 * collection at the position. A granted action holds outright, so its holder never meets the ABAC
 * in its rule (conditions on the record or the actor); such an action is granted at its strongest:
 * the writer must also hold every terminal (`null`) action of the resource, and on a resource with
 * none it is granted by nobody but a superadmin. A position off the resource's tree, or one that is
 * not the record `from` names, grants nothing.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(resolveRelation);

  return (permix, schema, entry, position) => {
    if (recordId(position) !== entry.from.id) return false;
    const resource = entry.resource as R;
    const path = pathTo(resolveRelation, schema, resource, entry.from.resource);
    if (!path) return false;

    const record = path.reduceRight<Row>((inner, field) => ({ [field]: inner }), position);
    const may = (action: string) => check(permix, schema, { resource, record }, action);
    const actions = schema.permissions[resource]?.actions ?? {};
    const terminals = Object.keys(actions).filter((action) => actions[action] === null);

    return Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .every(
        ([action]) =>
          may(action) &&
          (!isConditionalEntitlement(actions, action, new Set()) ||
            permix.isSuperadmin?.() === true ||
            (terminals.length > 0 && terminals.every(may))),
      );
  };
};
