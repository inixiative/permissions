import { type Absent, type Condition, check as checkRule } from '@inixiative/json-rules';
import { evaluate, type Walk } from './evaluate';
import { asOwner, nodeId, permixId } from './identity';
import type { PermixLike, Row } from './types';

const holds = (where: Condition, record: Row, absent: Absent): boolean =>
  checkRule(where, record, { absent }) === true;

// Entitlements are consulted after the table and the schema both miss, at the node the holder's
// own walk reached, with the record in hand. One applies when its `where` holds (the app folds
// where the entitlement sits into it) and whoever granted it can still do the action on this record: the
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
    ({ where, owner }) =>
      !visited.has(`${permixId(owner)}:${nodeId(record)}:${resource}:${action}`) &&
      (where === undefined || holds(where, record, walk.absent)) &&
      evaluate(walk, asOwner(owner, actor), resource, record, action, new Set(visited)),
  );
};
