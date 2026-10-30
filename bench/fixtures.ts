import {
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type RebacSchema,
} from '../index';
import { mapOf } from '../test/schemaMaps';

export const DEPTH = 6;
export const model = (i: number) => `m${i}`;

const standard = (parent: boolean) => ({
  own: parent ? { rel: 'parent', action: 'own' } : null,
  manage: parent ? { any: ['own', { rel: 'parent', action: 'manage' }] } : 'own',
  operate: parent ? { any: ['manage', { rel: 'parent', action: 'operate' }] } : 'manage',
  read: parent ? { any: ['operate', { rel: 'parent', action: 'read' }] } : 'operate',
});

export const schema: RebacSchema = {
  permissions: Object.fromEntries(
    Array.from({ length: DEPTH + 1 }, (_, i) => [model(i), { actions: standard(i > 0) }]),
  ),
};

export const map = mapOf(
  Object.fromEntries(Array.from({ length: DEPTH }, (_, i) => [model(i + 1), { parent: model(i) }])),
);

export const recordAt = (depth: number, leaf: string): Record<string, unknown> => {
  let record: Record<string, unknown> = { id: 'root' };
  for (let i = 1; i <= depth; i++) {
    const id = i === depth ? leaf : `n${i}`;
    record = { id, parentId: record.id, parent: record };
  }
  return record;
};

export const pool = (depth: number, size = 16) =>
  Array.from({ length: size }, (_, i) => recordAt(depth, `leaf${i}`));

export const table = async (...entries: PermissionEntry[]): Promise<Permix> => {
  const permix = createPermissions();
  await permix.setup(entries);
  return permix;
};

export const rootOwner = () =>
  table({ resource: model(0), id: 'root', actions: { own: true } } as PermissionEntry);

export const pathUp = (depth: number) => Array.from({ length: depth }, () => 'parent').join('.');

export const entitlement = (
  resource: string,
  anchorId: string,
  depth: number,
  actions: Record<string, boolean> = { read: true },
): EntitlementEntry => ({
  resource,
  anchor: { resource: model(0), id: anchorId, ...(depth > 0 ? { path: pathUp(depth) } : {}) },
  actions,
});
