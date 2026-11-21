import type { PermixLike, Row } from './types';

// A process-unique number per object, for a row with no key (`identityKeyOfRow`) and for a table.
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
const nodeId = identity();
const tableId = identity();

// An entitlement's owner walk runs on a slice of the owner's table (its grants). The slice is a fresh object per walk, so for cycle detection it resolves back to the
// table it was cut from: the same table re-entering the same node and action is a loop.
const origin = new WeakMap<PermixLike, PermixLike>();
export const permixId = (permix: PermixLike): number => tableId(origin.get(permix) ?? permix);

export const asOwner = (owner: PermixLike): PermixLike => {
  const slice: PermixLike = {
    check: (resource, action, id, data) => owner.check(resource, action, id, data),
    isSuperadmin: () => owner.isSuperadmin?.() ?? false,
    entitlements: (resource, action) => owner.entitlements?.(resource, action) ?? [],
  };
  origin.set(slice, origin.get(owner) ?? owner);
  return slice;
};

/** A row's identity on a walk: its key (`identityKeyOfRow`) when it has one, so a row loaded twice is one row; else the object. */
export const rowId = (record: Row, key: string | undefined): string =>
  key === undefined ? `#${nodeId(record)}` : `=${key}`;
