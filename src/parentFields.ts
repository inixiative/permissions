import type { ActionRule, RebacSchema } from './types';

// The relations a resource's own rules walk: the first segment of every `rel` arm, any depth.
const parentFieldsOf = new WeakMap<object, Set<string>>();
export const parentFields = (schema: RebacSchema<string>, resource: string): Set<string> => {
  const actions = schema.permissions[resource]?.actions;
  if (!actions) return new Set();
  const cached = parentFieldsOf.get(actions);
  if (cached) return cached;
  const fields = new Set<string>();
  const visit = (rule: ActionRule): void => {
    if (!rule || typeof rule !== 'object') return;
    if ('rel' in rule) fields.add(rule.rel.split('.')[0]);
    else if ('any' in rule) rule.any.forEach(visit);
    else if ('all' in rule) rule.all.forEach(visit);
  };
  Object.values(actions).forEach(visit);
  parentFieldsOf.set(actions, fields);
  return fields;
};
