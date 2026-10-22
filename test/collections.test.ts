import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  createRebacCheck,
  type RebacSchema,
  type ResolveRelation,
} from '../index';

const resolveRelation: ResolveRelation = (resource, segment) => {
  if (resource === 'db:contact' && segment === 'organization') return 'db:organization';
  if (resource === 'db:contact' && segment === 'user') return 'db:user';
  return null;
};

const ownedBy = (action: string) => ({
  any: [
    {
      all: [
        { rule: { field: 'ownerModel', operator: Operator.equals, value: 'Organization' } },
        { rel: 'organization', action },
      ],
    },
    {
      all: [
        { rule: { field: 'ownerModel', operator: Operator.equals, value: 'User' } },
        { rel: 'user', action },
      ],
    },
  ],
});

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:user': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:contact': {
      actions: { read: ownedBy('read'), manage: ownedBy('manage') },
      collections: { readMany: 'read', create: ownedBy('manage') },
    },
    'db:segment': { actions: { read: ownedBy('read') } },
  },
};

const check = createRebacCheck(resolveRelation);

const o1 = { id: 'o1' };
const u1 = { id: 'u1' };
const orgScope = { ownerModel: 'Organization', organizationId: 'o1', organization: o1 };
const userScope = { ownerModel: 'User', userId: 'u1', user: u1 };

const viewerOfO1 = async () => {
  const permix = createPermissions();
  await permix.setup({ resource: 'db:organization', id: 'o1', actions: { read: true } });
  return permix;
};

const adminOfO1 = async () => {
  const permix = createPermissions();
  await permix.setup({ resource: 'db:organization', id: 'o1', actions: { manage: true } });
  return permix;
};

describe('collections: what may be done to a resource as a whole, under an owner', () => {
  test('readMany delegates to the row action, evaluated on the scope row', async () => {
    const permix = await viewerOfO1();
    expect(
      check(
        permix,
        schema,
        { resource: 'db:contact', record: orgScope },
        { collection: 'readMany' },
      ),
    ).toBe(true);
    expect(
      check(
        permix,
        schema,
        { resource: 'db:contact', record: userScope },
        { collection: 'readMany' },
      ),
    ).toBe(false);
  });

  test('create is a proxy for manage on the owner, checked on the draft row', async () => {
    const draft = { ...orgScope, name: 'new' };
    expect(
      check(
        await viewerOfO1(),
        schema,
        { resource: 'db:contact', record: draft },
        { collection: 'create' },
      ),
    ).toBe(false);
    expect(
      check(
        await adminOfO1(),
        schema,
        { resource: 'db:contact', record: draft },
        { collection: 'create' },
      ),
    ).toBe(true);
  });

  test('the scope row routes by ownerModel, so a shared FK cannot leak across owners', async () => {
    const permix = await adminOfO1();
    const userOwnedUnderO1 = {
      ownerModel: 'User',
      userId: 'u1',
      organizationId: 'o1',
      user: u1,
      organization: o1,
    };
    expect(
      check(
        permix,
        schema,
        { resource: 'db:contact', record: userOwnedUnderO1 },
        { collection: 'create' },
      ),
    ).toBe(false);
  });

  test('a resource with no rule for the collection denies, even for a holder with every row action', async () => {
    const permix = await adminOfO1();
    expect(
      check(
        permix,
        schema,
        { resource: 'db:segment', record: orgScope },
        { collection: 'readMany' },
      ),
    ).toBe(false);
    expect(
      check(
        permix,
        schema,
        { resource: 'db:contact', record: orgScope },
        { collection: 'archive' },
      ),
    ).toBe(false);
  });

  test('superadmin passes a collection check like any other', async () => {
    const permix = createPermissions();
    permix.setSuperadmin(true);
    expect(
      check(
        permix,
        schema,
        { resource: 'db:segment', record: orgScope },
        { collection: 'readMany' },
      ),
    ).toBe(true);
  });

  test('a row action still works on a real row; a collection name is never an action', async () => {
    const permix = await viewerOfO1();
    const row = { id: 'c1', ...orgScope };
    expect(check(permix, schema, { resource: 'db:contact', record: row }, 'read')).toBe(true);
    expect(check(permix, schema, { resource: 'db:contact', record: row }, 'readMany')).toBe(false);
  });
});
