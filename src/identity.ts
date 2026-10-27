import type { Actor, Anchor, PermixLike } from './types';

// Stable identity for cycle detection that does NOT depend on `record.id` — an id may be absent or
// collide across resources, both of which would make an id-based key falsely report a cycle. A
// WeakMap assigns each visited object a process-unique number; entries are GC'd with the objects.
const identity = (): ((value: object) => number) => {
  let counter = 0;
  const ids = new WeakMap<object, number>();
  return (value) => {
    let id = ids.get(value);
    if (id === undefined) {
      id = ++counter;
      ids.set(value, id);
    }
    return id;
  };
};
export const nodeId = identity();
const tableId = identity();

// An entitlement's owner walk runs on a slice of the owner's table (its grants, the request's
// actor). The slice is a fresh object per walk, so for cycle detection it resolves back to the
// table it was cut from: the same table re-entering the same node and action is a loop.
const origin = new WeakMap<PermixLike, PermixLike>();
export const permixId = (permix: PermixLike): number => tableId(origin.get(permix) ?? permix);

export const fromAnchor = (
  anchor: Anchor,
  actions: Record<string, boolean | undefined>,
  actor: Actor | null,
): PermixLike => ({
  check: (resource, action, id) =>
    resource === anchor.resource && id === anchor.id && actions[action] === true,
  getActor: () => actor,
});

export const asOwner = (owner: PermixLike, actor: Actor | null): PermixLike => {
  const slice: PermixLike = {
    check: (resource, action, id, data) => owner.check(resource, action, id, data),
    isSuperadmin: () => owner.isSuperadmin?.() ?? false,
    entitlements: (resource, action) => owner.entitlements?.(resource, action) ?? [],
    getActor: () => actor,
  };
  origin.set(slice, origin.get(owner) ?? owner);
  return slice;
};
