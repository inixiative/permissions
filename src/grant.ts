import type { Condition } from '@inixiative/json-rules';
import { onPath } from './onPath';
import type { EntitlementEntry } from './permix';
import { prove } from './prove';
import type { CheckOptions, PermixLike, RebacSchema, ResolveRelation, Row } from './types';

/** Per action the grant names: `true` (the writer's table or schema covers it, nothing to carry) or
 * the condition the stored grant must carry (the `where`s of the entitlements the writer needed). */
export type GrantProof = Record<string, true | Condition>;

export type CanGrantEntitlement<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  entry: EntitlementEntry,
  placed: Row,
) => GrantProof | null;

/**
 * Build the grant check, bound to the same resolver and tenancy as the rebac check.
 *
 * A grant is an action: the writer (`permix`: its table, its own entitlements and their owners, its
 * actor) must be able to take every action `entry` names on `placed`, the pseudo record of
 * `entry.resource` the app built at the anchor (the anchor row itself, or a record whose direct owner
 * is the anchor, with its columns, hydrated); the library builds no record of its own. `placed`
 * not at the anchor, or an action the writer cannot take, refuses the grant (`null`). Otherwise, per
 * action, the proof: `true` when the writer's table or schema covers it, else the `where`s of the
 * entitlements it needed (AND along a rule, OR across alternatives, a parent's re-rooted onto the
 * child); the app stores the grant with that condition. A filter that cannot be re-rooted refuses.
 */
export const createCanGrantEntitlement = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
  { directOwner = () => null }: CheckOptions<R> = {},
): CanGrantEntitlement<R> => {
  return (permix, schema, entry, placed) => {
    const resource = entry.resource as R;
    if (!onPath(directOwner, resource, placed, entry.anchor)) return null;
    const walk = { resolveRelation, directOwner, schema, getDict: () => undefined };
    const result: GrantProof = {};
    for (const [action, held] of Object.entries(entry.actions)) {
      if (held !== true) continue;
      const proof = prove(walk, permix, resource, placed, action, new Set());
      if (proof === false) return null;
      result[action] = proof;
    }
    return result;
  };
};
