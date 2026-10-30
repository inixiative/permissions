import { validateRule } from '@inixiative/json-rules';
import type { EntitlementEntry } from './permix';
import type { Anchor } from './types';

const isAnchor = (value: unknown): value is Anchor =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as Anchor).resource === 'string' &&
  (value as Anchor).resource.length > 0 &&
  typeof (value as Anchor).id === 'string' &&
  (value as Anchor).id.length > 0 &&
  ((value as Anchor).path === undefined ||
    (typeof (value as Anchor).path === 'string' && (value as Anchor).path !== ''));

/** What is wrong with an entitlement entry, or null: the rules `setup` and `placeEntitlement` share. */
export const entitlementProblem = (entry: EntitlementEntry): string | null => {
  if (!isAnchor(entry.anchor)) return '`anchor` is { resource, id, path? }, non-empty strings';
  if ((entry.anchor.path === undefined) !== (entry.anchor.resource === entry.resource))
    return '`anchor.path` reaches the anchor from the record: none at the record itself';
  if ((entry as { id?: unknown }).id !== undefined)
    return '`anchor` with `id`: a single row is `where: { field: "id", … }`';
  if (
    typeof entry.actions !== 'object' ||
    entry.actions === null ||
    Object.values(entry.actions).some((value) => value !== undefined && typeof value !== 'boolean')
  )
    return 'entitlement actions are booleans';
  if (!Object.values(entry.actions).some((value) => value === true))
    return 'an entitlement grants at least one action';
  if (entry.where === null)
    return '`where: null` is not a rule: omit `where` for none, or write the rule';
  if (entry.where !== undefined) {
    const result = validateRule(entry.where, { positive: true });
    if (!result.ok)
      return `invalid entitlement \`where\`: ${result.errors.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`;
  }
  return null;
};
