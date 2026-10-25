import { createRebacCheck } from './check';
import type { EntitlementEntry } from './permix';
import { parentFields, recordId } from './tree';
import type { ActionRule, PermixLike, RebacSchema, ResolveRelation, Row } from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  position: Row,
) => boolean;

// An action's rule is ReBAC (walks) plus ABAC (`rule` conditions on the record, `actor` conditions
// on who acts). An entitlement holds the action outright, so its holder never meets the ABAC: true
// when the rule, or a same-resource action it delegates to, carries any. A `rel` walk is not
// skipped, so it is not followed.
const isConditionalEntitlement = (
  actions: Record<string, ActionRule>,
  rule: ActionRule | undefined,
  seen: Set<string>,
): boolean => {
  if (rule === undefined || rule === null || typeof rule === 'boolean') return false;
  if (typeof rule === 'string') {
    if (seen.has(rule)) return false;
    seen.add(rule);
    return isConditionalEntitlement(actions, actions[rule], seen);
  }
  if ('rule' in rule || 'actor' in rule) return true;
  if ('any' in rule) return rule.any.some((r) => isConditionalEntitlement(actions, r, seen));
  if ('all' in rule) return rule.all.some((r) => isConditionalEntitlement(actions, r, seen));
  return false;
};

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
 * none it is granted by nobody but a superadmin. A position
 * off the resource's tree, or one that is not the record `from` names, grants nothing.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(resolveRelation);

  const pathTo = (
    schema: RebacSchema<R>,
    resource: R,
    target: string,
    seen: Set<string>,
  ): string[] | null => {
    if (resource === target) return [];
    if (seen.has(resource)) return null;
    seen.add(resource);
    for (const field of parentFields(schema, resource)) {
      const next = resolveRelation(resource, field);
      const rest = next === null ? null : pathTo(schema, next, target, seen);
      if (rest) return [field, ...rest];
    }
    return null;
  };

  return (permix, schema, entry, position) => {
    if (recordId(position) !== entry.from.id) return false;
    const resource = entry.resource as R;
    const path = pathTo(schema, resource, entry.from.resource, new Set());
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
