import { type Condition, check as checkRule } from '@inixiative/json-rules';
import {
  evaluate,
  identifyRowOncePerCheck,
  isNodeOnPath,
  type Visited,
  type Walk,
} from './evaluate';
import { asOwner, permixId } from './identity';
import { whyEntitlementWhereLeavesLens } from './lens';
import { anchorRowReachedFrom } from './placement';
import { reachableFrom } from './reachableFrom';
import type { PermixLike, Row } from './types';

const holds = (where: Condition, record: Row): boolean => checkRule(where, record) === true;

/**
 * The entitlements that admit `action` on `record`: its path reaches the anchor, its `where` holds
 * inside the lens, and its owner, walked from here, takes the action. In the grant check's first
 * pass one counts only at a row in `above`, marked `grantsBelow`, without a `where`.
 */
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
  const held = [...reachableFrom(walk.map, resource, action)].flatMap(
    (implying) => permix.entitlements?.(resource, implying) ?? [],
  );
  return walk.algebra.any(
    held.map(
      ({ anchor, where, owner, ref, grantsBelow }) =>
        () =>
          !isNodeOnPath(
            walk,
            visited,
            `${permixId(owner)}:${identifyRowOncePerCheck(walk, resource, record)}:${resource}:${action}`,
          ) &&
          (above
            ? grantsBelow === true && where === undefined
            : where === undefined ||
              (whyEntitlementWhereLeavesLens(walk.map, resource, where) === null &&
                (walk.ignoreWheres || holds(where, record)))) &&
          anchorRowReachedFrom(walk.map, resource, record, anchor, true, walk.idField) !== undefined
            ? walk.algebra.through(
                ref,
                evaluate(walk, asOwner(owner), resource, record, action, visited),
              )
            : walk.algebra.none,
    ),
  );
};
