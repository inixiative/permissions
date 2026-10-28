import { describe, expect, test } from 'bun:test';
import { type FieldMap, Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  placeEntitlement,
  type RebacSchema,
  type Row,
  type SchemaMap,
} from '../index';

const scalar = { kind: 'scalar', type: 'String' } as const;
const toOne = (type: string, fromFields: string[], toFields: string[]) =>
  ({ kind: 'object', type, isList: false, fromFields, toFields }) as const;

const fieldMap: FieldMap = {
  models: {
    Organization: { fields: { id: scalar } },
    Space: {
      fields: {
        id: scalar,
        organizationId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
      },
    },
    OrganizationUser: {
      fields: {
        id: scalar,
        organizationId: scalar,
        userId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
      },
    },
    SpaceUser: {
      fields: {
        id: scalar,
        organizationId: scalar,
        spaceId: scalar,
        userId: scalar,
        space: toOne('Space', ['organizationId', 'spaceId'], ['organizationId', 'id']),
      },
    },
    Integration: {
      fields: {
        id: scalar,
        ownerModel: scalar,
        organizationId: scalar,
        spaceId: scalar,
        userId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
        space: toOne('Space', ['organizationId', 'spaceId'], ['organizationId', 'id']),
        organizationUser: toOne(
          'OrganizationUser',
          ['organizationId', 'userId'],
          ['organizationId', 'userId'],
        ),
        spaceUser: toOne(
          'SpaceUser',
          ['organizationId', 'spaceId', 'userId'],
          ['organizationId', 'spaceId', 'userId'],
        ),
      },
    },
  },
};

const map: SchemaMap = {
  resources: {
    'db:organization': 'Organization',
    'db:space': 'Space',
    'db:organizationUser': 'OrganizationUser',
    'db:spaceUser': 'SpaceUser',
    'db:integration': 'Integration',
  },
  fieldMap,
  polymorphism: {
    Integration: {
      axes: [
        {
          field: 'ownerModel',
          fkMap: {
            Organization: ['organizationId'],
            Space: ['organizationId', 'spaceId'],
            OrganizationUser: ['organizationId', 'userId'],
            SpaceUser: ['organizationId', 'spaceId', 'userId'],
          },
        },
      ],
    },
  },
};

const kindIs = (value: string) => ({
  rule: { field: 'ownerModel', operator: Operator.equals, value },
});

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own' } },
    'db:space': { actions: { own: { rel: 'organization', action: 'own' }, manage: 'own' } },
    'db:organizationUser': { actions: { own: { rel: 'organization', action: 'own' } } },
    'db:spaceUser': { actions: { own: { rel: 'space', action: 'own' } } },
    'db:integration': {
      actions: {
        manage: {
          any: [
            { all: [kindIs('Organization'), { rel: 'organization', action: 'manage' }] },
            { all: [kindIs('Space'), { rel: 'space', action: 'manage' }] },
            { all: [kindIs('OrganizationUser'), { rel: 'organizationUser', action: 'own' }] },
            { all: [kindIs('SpaceUser'), { rel: 'spaceUser', action: 'own' }] },
          ],
        },
      },
    },
  },
};

const check = createRebacCheck(map);
const canGrant = createCanGrantEntitlement(map);

const organizationOf = (id: string) => ({ id });
const o1 = organizationOf('o1');
const o2 = organizationOf('o2');
const spaceOf = (id: string, organization: Row) => ({
  id,
  organizationId: organization.id,
  organization,
});
const s1 = spaceOf('s1', o1);

const integrationsUnder = (organization: Row) => {
  const space = spaceOf(`s-${organization.id}`, organization);
  const member = { id: 'ou', organizationId: organization.id, userId: 'u1', organization };
  const spaceMember = {
    id: 'su',
    organizationId: organization.id,
    spaceId: space.id,
    userId: 'u1',
    space,
  };
  const base = { organizationId: organization.id, organization };
  return {
    Organization: { ...base, id: 'i-org', ownerModel: 'Organization' },
    Space: { ...base, id: 'i-space', ownerModel: 'Space', spaceId: space.id, space },
    OrganizationUser: {
      ...base,
      id: 'i-member',
      ownerModel: 'OrganizationUser',
      userId: 'u1',
      organizationUser: member,
    },
    SpaceUser: {
      ...base,
      id: 'i-space-member',
      ownerModel: 'SpaceUser',
      spaceId: space.id,
      userId: 'u1',
      space,
      spaceUser: spaceMember,
    },
  };
};

const table = async (actions: string[]) => {
  const permix = createPermissions();
  await permix.setup({
    resource: 'db:organization',
    id: 'o1',
    actions: Object.fromEntries(actions.map((action) => [action, true])),
  } as PermissionEntry);
  permix.setActor({ model: 'User', record: { id: 'w1' } });
  return permix;
};
const owner = () => table(['own']);
const admin = () => table(['manage']);

const underO1 = (where?: EntitlementEntry['where']): EntitlementEntry => ({
  resource: 'db:integration',
  anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
  actions: { manage: true },
  ...(where ? { where } : {}),
});
const theOrganizations = () =>
  underO1({ field: 'ownerModel', operator: 'equals', value: 'Organization' } as never);

const may = async (writer: Awaited<ReturnType<typeof table>>, entry: EntitlementEntry) => {
  const placed = placeEntitlement(map, entry, o1);
  return placed !== null && placed.every((record) => canGrant(writer, schema, entry, record));
};

const holderOf = async (entry: EntitlementEntry) => {
  const holder = createPermissions();
  await holder.setup([entry], { owner: await owner() });
  return holder;
};

describe('an anchor path names the anchor and the axis; every kind on it is reached (R81)', () => {
  test('under o1: all four kinds of integration, none under o2', async () => {
    const holder = await holderOf(underO1());
    for (const record of Object.values(integrationsUnder(o1)))
      expect(check(holder, schema, { resource: 'db:integration', record }, 'manage')).toBe(true);
    for (const record of Object.values(integrationsUnder(o2)))
      expect(check(holder, schema, { resource: 'db:integration', record }, 'manage')).toBe(false);
  });

  test("the where narrows the kinds: ownerModel = Organization reaches the organization's own only", async () => {
    const holder = await holderOf(theOrganizations());
    const reached = Object.entries(integrationsUnder(o1))
      .filter(([, record]) =>
        check(holder, schema, { resource: 'db:integration', record }, 'manage'),
      )
      .map(([kind]) => kind);
    expect(reached).toEqual(['Organization']);
  });
});

describe('the grant is judged on one pseudo record per kind the entry admits (R81)', () => {
  test('unfiltered: four pseudo records, each owner placed under the anchor', () => {
    const placed = placeEntitlement(map, underO1(), o1);
    expect(placed?.map((record) => record.ownerModel)).toEqual([
      'Organization',
      'Space',
      'OrganizationUser',
      'SpaceUser',
    ]);
    expect(placed?.[1]).toEqual({
      ownerModel: 'Space',
      organizationId: 'o1',
      organization: o1,
      space: { organizationId: 'o1', organization: o1 },
    });
  });

  test('the owner grants it unfiltered; an admin does not', async () => {
    expect(await may(await owner(), underO1())).toBe(true);
    expect(await may(await admin(), underO1())).toBe(false);
  });

  test("an admin grants it narrowed to the organization's own", async () => {
    expect(placeEntitlement(map, theOrganizations(), o1)?.length).toBe(1);
    expect(await may(await admin(), theOrganizations())).toBe(true);
  });

  test('anchored at a space: the kinds that carry its keys, a space and its members', () => {
    const atSpace: EntitlementEntry = {
      resource: 'db:integration',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      actions: { manage: true },
    };
    expect(placeEntitlement(map, atSpace, s1)?.map((record) => record.ownerModel)).toEqual([
      'Space',
      'SpaceUser',
    ]);
  });
});
