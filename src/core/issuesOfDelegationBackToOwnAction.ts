import type { ValidationIssue } from '@inixiative/json-rules';
import { allDelegates, delegationReach } from './reachableFrom';
import type { SchemaMap } from './schemaMap';

/** Where an action's rule sits: the map, the resource, the action, and the other rule sets that reach the same record (`action → rule`). */
export type PlaceOfActionRule = {
  schemaMap: SchemaMap;
  resource: string;
  action: string;
  rowRules?: Record<string, unknown> | null;
  additionalRules?: readonly (Record<string, unknown> | null | undefined)[];
};

/** A cycle: the rule delegates back to its own action on the same record, through the map's rules, the record's other rules or the additional rule sets. */
export const issuesOfDelegationBackToOwnAction = (
  rule: unknown,
  { schemaMap, resource, action, rowRules, additionalRules = [] }: PlaceOfActionRule,
): ValidationIssue[] => {
  const actions = schemaMap.permissions[resource]?.actions ?? {};
  const reached = delegationReach(
    allDelegates(rule),
    (next) => [actions[next], rowRules?.[next], ...additionalRules.map((rules) => rules?.[next])],
    allDelegates,
  );
  return reached.has(action)
    ? [{ path: '$', code: 'cycle', message: `\`${action}\` delegates back to itself` }]
    : [];
};
