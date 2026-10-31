import { describe, expect, test } from 'bun:test';
import {
  createPermissions,
  createRebacCheck,
  installPermissions,
  type Permissions,
  permixOf,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
      },
    },
  },
};
const check = createRebacCheck(mapOf({ 'db:space': { organization: 'db:organization' } }));

const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const s2 = { id: 's2', organizationId: 'o1', organization: o1 };
const can = async (table: Permissions, resource: string, record: Row, action: string) =>
  check(await permixOf(table), schema, { resource, record }, action);

const orgOwner: Permissions = [
  { entries: [{ resource: 'db:organization', id: 'o1', actions: { own: true } }] },
];

describe('permissions as data', () => {
  test('the empty permissions hold nothing', async () => {
    expect(await can([], 'db:organization', o1, 'read')).toBe(false);
  });

  test('a group without an owner is permissions grants', async () => {
    expect(await can(orgOwner, 'db:organization', o1, 'own')).toBe(true);
    expect(await can(orgOwner, 'db:space', s1, 'manage')).toBe(true);
  });

  test('a group with an owner installs its entries as entitlements backed by that permissions', async () => {
    const table: Permissions = [
      {
        entries: [
          {
            resource: 'db:space',
            anchor: { resource: 'db:space', id: 's1' },
            actions: { manage: true },
          },
        ],
        owner: orgOwner,
      },
    ];
    expect(await can(table, 'db:space', s1, 'manage')).toBe(true);
    expect(await can(table, 'db:space', s2, 'manage')).toBe(false);
    expect(await can(table, 'db:organization', o1, 'read')).toBe(false);
  });

  test('nested owners: an entitlement backed by permissions whose own entitlement is backed by the org', async () => {
    const member: Permissions = [
      { entries: [{ resource: 'db:organization', id: 'o1', actions: { read: true } }] },
      {
        entries: [
          {
            resource: 'db:space',
            anchor: { resource: 'db:space', id: 's1' },
            actions: { manage: true },
          },
        ],
        owner: orgOwner,
      },
    ];
    const holder: Permissions = [
      {
        entries: [
          {
            resource: 'db:space',
            anchor: { resource: 'db:space', id: 's1' },
            actions: { manage: true },
          },
          {
            resource: 'db:space',
            anchor: { resource: 'db:space', id: 's2' },
            actions: { manage: true },
          },
        ],
        owner: member,
      },
    ];
    expect(await can(holder, 'db:space', s1, 'manage')).toBe(true);
    expect(await can(holder, 'db:space', s2, 'manage')).toBe(false);
    expect(await can(holder, 'db:space', s2, 'read')).toBe(true);
  });

  test('installPermissions adds to a permix the app already holds', async () => {
    const permix = createPermissions();
    await permix.setup({ resource: 'db:organization', id: 'o2', actions: { read: true } });
    await installPermissions(permix, orgOwner);
    expect(permix.check('db:organization', 'read', 'o2')).toBe(true);
    expect(permix.check('db:organization', 'own', 'o1')).toBe(true);
  });

  test('installPermissions and permixOf agree', async () => {
    const permix = createPermissions();
    await installPermissions(permix, orgOwner);
    expect((await permixOf(orgOwner)).getJSON()).toEqual(permix.getJSON());
  });
});
