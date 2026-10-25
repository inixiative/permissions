import { type Condition, check as checkRule } from '@inixiative/json-rules';
import { evaluate, type Walk } from './evaluate';
import { asOwner, nodeId, permixId } from './identity';
import { onPath } from './onPath';
import type { PermixLike, Row } from './types';

// A `where` is literals and record paths, checked against the record at the entitlement's node.
// An absent path reads as NULL: write `where` positively, a negation passes on what is not loaded.
const holds = (where: Condition | null, record: Row): boolean =>
  where !== null && checkRule(where, record) === true;

// Entitlements are consulted after the table and the schema both miss, at the node the holder's
// own walk reached, with the record in hand. One applies when its anchor is on the record's
// path, its `where` holds, and whoever granted it can still do the action on this record: the
// owner's own table, walked from here. A space moved to another org stops reaching its grantor.
// An owner that is already on this walk for this node and action is a loop built from grant
// data, not a schema bug: it denies instead of throwing, so it can never hide a sibling.
export const entitled = <R extends string>(
  walk: Walk<R>,
  permix: PermixLike,
  resource: R,
  record: Row,
  action: string,
  visited: Set<string>,
): boolean => {
  const actor = permix.getActor();
  return (permix.entitlements?.(resource, action) ?? []).some(
    ({ anchor, where, owner }) =>
      !visited.has(`${permixId(owner)}:${nodeId(record)}:${resource}:${action}`) &&
      onPath(walk.resolveRelation, walk.schema, resource, record, anchor) &&
      (where === undefined || holds(where, record)) &&
      evaluate(walk, asOwner(owner, actor), resource, record, action, new Set(visited)),
  );
};
