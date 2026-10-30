import { isEqual } from 'lodash-es';
import { createRebacCheck } from './check';
import { asOwner } from './identity';
import type { EntitlementEntry } from './permix';
import { conjuncts, type SchemaMap } from './schemaMap';
import type {
  ActionRule,
  Anchor,
  CheckOptions,
  Entitlement,
  PermixLike,
  RebacSchema,
  Row,
} from './types';

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  placed: Row,
) => boolean;

const sameAnchor = (a: Anchor, b: Anchor) =>
  a.resource === b.resource && a.id === b.id && a.path === b.path;

const pureDelegates = (rule: ActionRule | undefined): string[] => {
  if (typeof rule === 'string') return [rule];
  if (typeof rule === 'object' && rule !== null && 'any' in rule && Object.keys(rule).length === 1)
    return rule.any.filter((arm): arm is string => typeof arm === 'string');
  return [];
};

const reachableFrom = (schema: RebacSchema, resource: string, action: string): Set<string> => {
  const actions = schema.permissions[resource]?.actions ?? {};
  const reached = new Set<string>();
  const climb = (current: string) => {
    if (reached.has(current)) return;
    reached.add(current);
    for (const next of pureDelegates(actions[current])) climb(next);
  };
  climb(action);
  return reached;
};

const narrows = (held: Entitlement, entry: EntitlementEntry) => {
  const granted = conjuncts(entry.where);
  return (
    sameAnchor(held.anchor, entry.anchor) &&
    conjuncts(held.where).every((condition) => granted.some((g) => isEqual(condition, g)))
  );
};

/**
 * Build the grant check, bound to the same schema map as the rebac check.
 *
 * A grant is judged in two passes. The first: the writer's table (its role; a delegate's role is
 * its owner's table capped at it) with no entitlements and no actor, takes every action `entry` names on `placed`, the pseudo record `placeEntitlement` builds
 * from the hydrated anchor along the entry's path; a field it does not carry is unknown (json-rules
 * `absent: 'unknown'`), so the writer covers every record the `where` admits. Failing that, the
 * entitlement pass: the entry is one entitlement the writer holds, copied or narrowed — same
 * resource and anchor, each of its actions one the held entitlement holds or reaches by pure
 * delegation (a bare action name, alone or an arm of a top-level `any`), and every condition of the held `where`
 * among the entry's (the held `where` itself, or each child of its top `all`) — and for each granted
 * action, whoever granted the held one still takes the held action it lowers from on `placed`.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  map: SchemaMap<R>,
  options: CheckOptions = {},
): CanGrantEntitlement<R> => {
  const check = createRebacCheck(map, { ...options, absent: 'unknown' });

  return (permix, schema, entry, placed) => {
    const resource = entry.resource as R;
    const actions = Object.entries(entry.actions)
      .filter(([, held]) => held === true)
      .map(([action]) => action);
    const table: PermixLike = {
      check: (on, action, id, data) => permix.check(on, action, id, data),
      isSuperadmin: () => permix.isSuperadmin?.() ?? false,
      getActor: () => null,
    };
    if (actions.every((action) => check(table, schema, { resource, record: placed }, action)))
      return true;
    const reached = actions.map((action) => reachableFrom(schema, resource, action));
    const candidates = [...(reached[0] ?? [])].flatMap(
      (action) => permix.entitlements?.(resource, action) ?? [],
    );
    return candidates.some((held) => {
      const owner = asOwner(held.owner, null);
      const backed = (action: string) =>
        held.actions[action] === true && check(owner, schema, { resource, record: placed }, action);
      return narrows(held, entry) && reached.every((up) => [...up].some(backed));
    });
  };
};
