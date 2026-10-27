import { recordId } from './recordId';
import type { Anchor, DirectOwner, Row } from './types';

// An entitlement acts at its anchor: the record itself, or the record's direct owner on the app's
// tenancy tree. Reach further down comes from the schema walk, never from skipping a level.
export const onPath = <R extends string>(
  directOwner: DirectOwner<R>,
  resource: R,
  record: Row,
  anchor: Anchor,
): boolean => {
  if (resource === anchor.resource && recordId(record) === anchor.id) return true;
  const owner = directOwner(resource, record);
  return owner !== null && owner.resource === anchor.resource && owner.id === anchor.id;
};
