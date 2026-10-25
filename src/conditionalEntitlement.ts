import type { ActionRule } from './types';

// An action's rule is ReBAC (walks) plus ABAC (`rule` conditions on the record, `actor` conditions
// on who acts). An entitlement holds the action outright, so its holder never meets the ABAC: true
// when the rule, or a same-resource action it delegates to, carries any. A `rel` walk is not
// skipped, so it is not followed.
export const isConditionalEntitlement = (
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
