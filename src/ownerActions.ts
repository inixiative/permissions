import type { ActionRule, ModelPermission } from './types';

/**
 * Build the standard action set for an owner-polymorphic model — one whose ownership fans out to
 * several possible parents (e.g. a record owned by a user OR an organization OR a space). Each
 * standard action delegates to the same action on whichever relation is present.
 */
export const ownerActions = (
  rels: readonly string[] = ['user', 'organization', 'space'],
): ModelPermission['actions'] => {
  const fanout = (action: string): ActionRule => ({ any: rels.map((rel) => ({ rel, action })) });
  return {
    own: fanout('own'),
    manage: fanout('manage'),
    operate: fanout('operate'),
    read: fanout('read'),
  };
};
