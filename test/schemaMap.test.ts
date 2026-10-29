import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/json-rules';
import {
  type Anchor,
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  placeEntitlement,
  placeUnder,
  type RebacSchema,
  type Row,
  type SchemaMap,
} from '../index';

const scalar = { kind: 'scalar', type: 'String' } as const;
const toOne = (type: string, fromFields: string[], toFields: string[]) =>
  ({ kind: 'object', type, isList: false, fromFields, toFields }) as const;

const fieldMap: FieldMap = {
  models: {
    Organization: {
      fields: { id: scalar, spaces: { kind: 'object', type: 'Space', isList: true } },
    },
    Space: {
      fields: {
        id: scalar,
        organizationId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
      },
    },
    Integration: {
      fields: {
        id: scalar,
        ownerModel: scalar,
        organizationId: scalar,
        spaceId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
        space: toOne('Space', ['organizationId', 'spaceId'], ['organizationId', 'id']),
      },
    },
    Token: {
      fields: {
        id: scalar,
        ownerModel: scalar,
        integrationId: scalar,
        integration: toOne('Integration', ['integrationId'], ['id']),
      },
    },
    Inquiry: {
      fields: {
        id: scalar,
        sourceModel: scalar,
        targetModel: scalar,
        sourceOrganizationId: scalar,
        targetOrganizationId: scalar,
        sourceOrganization: toOne('Organization', ['sourceOrganizationId'], ['id']),
        targetOrganization: toOne('Organization', ['targetOrganizationId'], ['id']),
      },
    },
  },
};

const map: SchemaMap = {
  resources: {
    'db:organization': 'Organization',
    'db:space': 'Space',
    'db:integration': 'Integration',
    'db:token': 'Token',
    'db:inquiry': 'Inquiry',
  },
  fieldMap,
  polymorphism: {
    Integration: {
      axes: [
        {
          field: 'ownerModel',
          fkMap: { Organization: ['organizationId'], Space: ['organizationId', 'spaceId'] },
        },
      ],
    },
    Token: { axes: [{ field: 'ownerModel', fkMap: { Integration: ['integrationId'] } }] },
    Inquiry: {
      axes: [
        { field: 'sourceModel', fkMap: { Organization: ['sourceOrganizationId'] } },
        { field: 'targetModel', fkMap: { Organization: ['targetOrganizationId'] } },
      ],
    },
  },
};

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: 'own',
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
      },
    },
    'db:integration': {
      actions: {
        manage: {
          any: [
            {
              all: [
                { rule: { field: 'ownerModel', operator: 'equals', value: 'Organization' } },
                { rel: 'organization', action: 'manage' },
              ],
            },
            {
              all: [
                { rule: { field: 'ownerModel', operator: 'equals', value: 'Space' } },
                { rel: 'space', action: 'manage' },
              ],
            },
          ],
        },
      },
    },
    'db:token': { actions: { delete: { rel: 'integration', action: 'manage' } } },
    'db:inquiry': {
      actions: {
        read: {
          any: [
            { rel: 'sourceOrganization', action: 'read' },
            { rel: 'targetOrganization', action: 'read' },
          ],
        },
      },
    },
  },
};

const check = createRebacCheck(map);
const canGrant = createCanGrantEntitlement(map);

const o1 = { id: 'o1' };
const o2 = { id: 'o2' };
const space = (id: string, organization: Row) => ({
  id,
  organizationId: organization.id,
  organization,
});
const s1 = space('s1', o1);
const orgIntegration = (id: string, organization: Row) => ({
  id,
  ownerModel: 'Organization',
  organizationId: organization.id,
  organization,
});
const spaceIntegration = (id: string, s: Row) => ({
  id,
  ownerModel: 'Space',
  organizationId: (s.organization as Row).id,
  spaceId: s.id,
  organization: s.organization,
  space: s,
});
const inquiry = (id: string, source: Row, target: Row) => ({
  id,
  sourceModel: 'Organization',
  targetModel: 'Organization',
  sourceOrganizationId: source.id,
  sourceOrganization: source,
  targetOrganizationId: target.id,
  targetOrganization: target,
});

const table = async (resource: string, id: string, actions: string[]) => {
  const permix = createPermissions();
  await permix.setup({
    resource,
    id,
    actions: Object.fromEntries(actions.map((action) => [action, true])),
  } as PermissionEntry);
  permix.setActor({ model: 'User', record: { id: 'w1' } });
  return permix;
};
const at = (resource: string, id: string, path?: string): Anchor =>
  path === undefined ? { resource, id } : { resource, id, path };
const entitlement = (resource: string, anchor: Anchor, action: string): EntitlementEntry => ({
  resource,
  anchor,
  actions: { [action]: true },
});
const holderOf = async (entry: EntitlementEntry) => {
  const holder = createPermissions();
  await holder.setup([entry], { owner: await table('db:organization', 'o1', ['own']) });
  return holder;
};
const may = async (
  writer: Awaited<ReturnType<typeof table>>,
  entry: EntitlementEntry,
  anchor: Row,
) => {
  const placed = placeEntitlement(map, entry, anchor);
  return placed !== null && placed.every((record) => canGrant(writer, schema, entry, record));
};

describe('the path names a kind at each polymorphic step: read time', () => {
  test('via organization: every kind that carries the organization (R81)', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'organization'), 'manage'),
    );
    const manages = (record: Row) =>
      check(holder, schema, { resource: 'db:integration', record }, 'manage');
    expect(manages(orgIntegration('i1', o1))).toBe(true);
    expect(manages(spaceIntegration('i2', s1))).toBe(true);
  });

  test("via space.organization: the spaces' integrations, not the organization's own", async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
    );
    const manages = (record: Row) =>
      check(holder, schema, { resource: 'db:integration', record }, 'manage');
    expect(manages(spaceIntegration('i2', s1))).toBe(true);
    expect(manages(orgIntegration('i1', o1))).toBe(false);
  });

  test('an inquiry: the side and its kind', async () => {
    const holder = await holderOf(
      entitlement('db:inquiry', at('db:organization', 'o1', 'targetOrganization'), 'read'),
    );
    const reads = (record: Row) =>
      check(holder, schema, { resource: 'db:inquiry', record }, 'read');
    expect(reads(inquiry('q1', o2, o1))).toBe(true);
    expect(reads(inquiry('q2', o1, o2))).toBe(false);
  });

  test('a list relation is not a path', async () => {
    await expect(
      holderOf(entitlement('db:space', at('db:organization', 'o1', 'spaces'), 'read')),
    ).resolves.toBeDefined();
    const holder = await holderOf(
      entitlement('db:space', at('db:organization', 'o1', 'spaces'), 'read'),
    );
    expect(
      check(holder, schema, { resource: 'db:space', record: { ...s1, spaces: [o1] } }, 'read'),
    ).toBe(false);
  });
});

describe('placeEntitlement: the pseudo record, built from the anchor along the path', () => {
  test('one step: the foreign key, one record per kind it admits, each owner under the anchor', () => {
    expect(
      placeEntitlement(
        map,
        entitlement('db:integration', at('db:organization', 'o1', 'organization'), 'manage'),
        o1,
      ),
    ).toEqual([
      { ownerModel: 'Organization', organizationId: 'o1', organization: o1 },
      {
        ownerModel: 'Space',
        organizationId: 'o1',
        organization: o1,
        space: { organizationId: 'o1', organization: o1 },
      },
    ]);
  });

  test('two steps: a pseudo space under the anchor, its id unknown', () => {
    expect(
      placeEntitlement(
        map,
        entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
        o1,
      ),
    ).toEqual([
      {
        ownerModel: 'Space',
        organizationId: 'o1',
        space: { organizationId: 'o1', organization: o1 },
      },
    ]);
  });

  test('the where pins exact values; the path wins over a pinned foreign key', () => {
    const entry = {
      ...entitlement('db:integration', at('db:organization', 'o1', 'organization'), 'manage'),
      where: {
        all: [
          { field: 'provider', operator: 'equals', value: 'slack' },
          { field: 'organizationId', operator: 'equals', value: 'o2' },
          { field: 'ownerModel', operator: 'equals', value: 'Organization' },
        ],
      },
    } as EntitlementEntry;
    expect(placeEntitlement(map, entry, o1)).toEqual([
      { provider: 'slack', ownerModel: 'Organization', organizationId: 'o1', organization: o1 },
    ]);
  });

  test('a self anchor is the anchor itself', () => {
    expect(
      placeEntitlement(map, entitlement('db:space', at('db:space', 's1'), 'read'), s1),
    ).toEqual([s1]);
  });

  test('a path that does not end at the anchor model is null', () => {
    expect(
      placeEntitlement(
        map,
        entitlement('db:integration', at('db:space', 's1', 'organization'), 'manage'),
        s1,
      ),
    ).toBeNull();
    expect(
      placeEntitlement(
        map,
        entitlement('db:space', at('db:organization', 'o1', 'spaces'), 'read'),
        o1,
      ),
    ).toBeNull();
  });
});

describe('the grant check on the placed record', () => {
  test('a manager of o1 grants its own integrations (narrowed), not every kind under it', async () => {
    const manager = await table('db:organization', 'o1', ['manage']);
    const integrations = entitlement(
      'db:integration',
      at('db:organization', 'o1', 'organization'),
      'manage',
    );
    expect(await may(manager, integrations, o1)).toBe(false);
    expect(
      await may(
        manager,
        {
          ...integrations,
          where: { field: 'ownerModel', operator: 'equals', value: 'Organization' },
        } as EntitlementEntry,
        o1,
      ),
    ).toBe(true);
    expect(
      await may(
        manager,
        entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
        o1,
      ),
    ).toBe(false);
  });

  test('an owner of o1 grants both', async () => {
    const owner = await table('db:organization', 'o1', ['own']);
    expect(
      await may(
        owner,
        entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
        o1,
      ),
    ).toBe(true);
  });

  test('a token through its integration: a kind at each step', async () => {
    const owner = await table('db:organization', 'o1', ['own']);
    const tokens = entitlement(
      'db:token',
      at('db:organization', 'o1', 'integration.organization'),
      'delete',
    );
    expect(placeEntitlement(map, tokens, o1)?.map((token) => token.integration)).toEqual([
      { ownerModel: 'Organization', organizationId: 'o1', organization: o1 },
      {
        ownerModel: 'Space',
        organizationId: 'o1',
        organization: o1,
        space: { organizationId: 'o1', organization: o1 },
      },
    ]);
    expect(await may(owner, tokens, o1)).toBe(true);
    expect(await may(await table('db:organization', 'o2', ['own']), tokens, o1)).toBe(false);
  });
});

describe('the map is indexed once', () => {
  test('two resources on one model are refused when the check is built', () => {
    expect(() =>
      createRebacCheck({ ...map, resources: { ...map.resources, 'db:org': 'Organization' } }),
    ).toThrow(/Organization/);
  });
});

describe('placeUnder: a record of a resource under an anchor, along a path', () => {
  test('the path decides the relation: its foreign keys, composite ones too, and its kind', () => {
    expect(placeUnder(map, 'db:integration', 'space', 'db:space', s1)).toEqual([
      { ownerModel: 'Space', organizationId: 'o1', spaceId: 's1', space: s1 },
    ]);
  });

  test('a side: the inquiry an organization receives', () => {
    expect(placeUnder(map, 'db:inquiry', 'targetOrganization', 'db:organization', o1)).toEqual([
      { targetModel: 'Organization', targetOrganizationId: 'o1', targetOrganization: o1 },
    ]);
  });

  test('a path that does not lead to the anchor places nothing', () => {
    expect(placeUnder(map, 'db:integration', 'organization', 'db:space', s1)).toEqual([]);
  });
});

describe('placeEntitlement refuses a malformed entry: the same rules setup applies', () => {
  const integrations = entitlement(
    'db:integration',
    at('db:organization', 'o1', 'organization'),
    'manage',
  );

  test('an anchor on another resource without a path', () => {
    expect(
      placeEntitlement(
        map,
        entitlement('db:integration', at('db:organization', 'o1'), 'manage'),
        o1,
      ),
    ).toBeNull();
  });

  test('a where that can hold on a missing value', () => {
    const negated = {
      ...integrations,
      where: { field: 'provider', operator: 'notEquals', value: 'slack' },
    } as EntitlementEntry;
    expect(placeEntitlement(map, negated, o1)).toBeNull();
  });

  test('an action that is not a boolean', () => {
    const odd = { ...integrations, actions: { manage: 'yes' } } as unknown as EntitlementEntry;
    expect(placeEntitlement(map, odd, o1)).toBeNull();
  });
});
