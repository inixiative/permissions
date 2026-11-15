import { type Absent, type Condition, check as checkRule } from '@inixiative/json-rules';
import { evaluate, type Visited, type Walk } from './evaluate';
import { asOwner, permixId, rowId } from './identity';
import { lensAt, whereProblemAt } from './lens';
import { reachableFrom } from './reachableFrom';
import { recordId } from './recordId';
import { rowKey, rowsAlong } from './schemaMap';
import type { Anchor, PermixLike, Row } from './types';

const holds = (where: Condition, record: Row, absent: Absent): boolean =>
  checkRule(where, record, { absent }) === true;

const reaches = <R extends string, T>(
  walk: Walk<R, T>,
  resource: R,
  record: Row,
  anchor: Anchor,
) => {
  const segments = anchor.path?.split('.') ?? [];
  const steps = rowsAlong(walk.map, resource, record, segments, true);
  const end = steps[segments.length];
  return end?.resource === anchor.resource && recordId(end.row) === anchor.id;
};

// Entitlements are consulted after the table and the schema both miss, at the node the holder's
// own walk reached, with the record in hand. One applies when the record's path reaches its anchor (each
// polymorphic step one of the kinds its relation admits), its
// `where` holds, and whoever granted it can still do the action on this record: the
// owner's own table, walked from here. A space moved to another org stops reaching its grantor.
// A `where` that reads outside the lens never holds, even in the liveness walk.
// An owner that is already on this walk for this node and action is a loop built from grant
// data, not a schema bug: it denies instead of throwing, so it can never hide a sibling.
// In the grant check's first pass (`walk.above`) one counts only at a hydrated row above the
// granted record, and only when it is marked `grantsBelow` and has no `where`, at every depth of
// the owner walk.
export const entitled = <R extends string, T>(
  walk: Walk<R, T>,
  permix: PermixLike,
  resource: R,
  record: Row,
  action: string,
  visited: Visited,
): T => {
  const { above } = walk;
  if (above && !above.has(record)) return walk.algebra.none;
  const actor = permix.getActor();
  const held = [...reachableFrom(walk.schema, resource, action)].flatMap(
    (implying) => permix.entitlements?.(resource, implying) ?? [],
  );
  return walk.algebra.any(
    held.map(
      ({ anchor, where, owner, ref, grantsBelow }) =>
        () =>
          !visited.has(
            `${permixId(owner)}:${rowId(record, rowKey(walk.map, resource, record, walk.idField))}:${resource}:${action}`,
          ) &&
          (above
            ? grantsBelow === true && where === undefined
            : where === undefined ||
              (whereProblemAt(walk.map, lensAt(walk.map, resource), where) === null &&
                (walk.ignoreWheres || holds(where, record, walk.absent)))) &&
          reaches(walk, resource, record, anchor)
            ? walk.algebra.through(
                ref,
                evaluate(walk, asOwner(owner, actor), resource, record, action, new Map(visited)),
              )
            : walk.algebra.none,
    ),
  );
};
