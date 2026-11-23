import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import {
  type Anchor,
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  pseudoRecordsBelowAnchor,
  pseudoRecordsOfEntitlement,
  type Row,
  type SchemaMap,
} from '../index';
import {
  canGrantWithRules,
  checkWithRules,
  type Rules,
  stringColumn as scalar,
} from './schemaMaps';

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
  permissions: {},
  maps: { db: fieldMap },
  polymorphism: {
    db: {
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
  },
};

const schema: Rules = {
  permissions: {
    'db:Organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:Space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: 'own',
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
      },
    },
    'db:Integration': {
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
    'db:Token': { actions: { delete: { rel: 'integration', action: 'manage' } } },
    'db:Inquiry': {
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

const check = checkWithRules(map);
const canGrant = canGrantWithRules(map);

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
  await holder.setup([entry], { owner: await table('db:Organization', 'o1', ['own']) });
  return holder;
};
const may = async (
  writer: Awaited<ReturnType<typeof table>>,
  entry: EntitlementEntry,
  anchor: Row,
) => {
  const placed = pseudoRecordsOfEntitlement(map, entry, anchor);
  return placed?.every((record) => canGrant(writer, schema, entry, record));
};

describe('the path names a kind at each polymorphic step: read time', () => {
  test('via organization: every kind that carries the organization (R81)', async () => {
    const holder = await holderOf(
      entitlement('db:Integration', at('db:Organization', 'o1', 'organization'), 'manage'),
    );
    const manages = (record: Row) =>
      check(holder, schema, { resource: 'db:Integration', record }, 'manage');
    expect(manages(orgIntegration('i1', o1))).toBe(true);
    expect(manages(spaceIntegration('i2', s1))).toBe(true);
  });

  test("via space.organization: the spaces' integrations, not the organization's own", async () => {
    const holder = await holderOf(
      entitlement('db:Integration', at('db:Organization', 'o1', 'space.organization'), 'manage'),
    );
    const manages = (record: Row) =>
      check(holder, schema, { resource: 'db:Integration', record }, 'manage');
    expect(manages(spaceIntegration('i2', s1))).toBe(true);
    expect(manages(orgIntegration('i1', o1))).toBe(false);
  });

  test('an inquiry: the side and its kind', async () => {
    const holder = await holderOf(
      entitlement('db:Inquiry', at('db:Organization', 'o1', 'targetOrganization'), 'read'),
    );
    const reads = (record: Row) =>
      check(holder, schema, { resource: 'db:Inquiry', record }, 'read');
    expect(reads(inquiry('q1', o2, o1))).toBe(true);
    expect(reads(inquiry('q2', o1, o2))).toBe(false);
  });

  test('a list relation is not a path', async () => {
    const holder = await holderOf(
      entitlement('db:Organization', at('db:Space', 's1', 'spaces'), 'read'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:Organization', record: { ...o1, spaces: [s1] } },
        'read',
      ),
    ).toBe(false);
  });
});

describe('pseudoRecordsOfEntitlement: the pseudo record, built from the anchor along the path', () => {
  test('one step: the foreign key, one record per kind it admits, each owner under the anchor', () => {
    expect(
      pseudoRecordsOfEntitlement(
        map,
        entitlement('db:Integration', at('db:Organization', 'o1', 'organization'), 'manage'),
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
      pseudoRecordsOfEntitlement(
        map,
        entitlement('db:Integration', at('db:Organization', 'o1', 'space.organization'), 'manage'),
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
      ...entitlement('db:Integration', at('db:Organization', 'o1', 'organization'), 'manage'),
      where: {
        all: [
          { field: 'provider', operator: 'equals', value: 'slack' },
          { field: 'organizationId', operator: 'equals', value: 'o2' },
          { field: 'ownerModel', operator: 'equals', value: 'Organization' },
        ],
      },
    } as EntitlementEntry;
    expect(pseudoRecordsOfEntitlement(map, entry, o1)).toEqual([
      { provider: 'slack', ownerModel: 'Organization', organizationId: 'o1', organization: o1 },
    ]);
  });

  test('a self anchor is the anchor itself', () => {
    expect(
      pseudoRecordsOfEntitlement(map, entitlement('db:Space', at('db:Space', 's1'), 'read'), s1),
    ).toEqual([s1]);
  });

  test('a path that does not end at the anchor model is null', () => {
    expect(
      pseudoRecordsOfEntitlement(
        map,
        entitlement('db:Integration', at('db:Space', 's1', 'organization'), 'manage'),
        s1,
      ),
    ).toBeNull();
    expect(
      pseudoRecordsOfEntitlement(
        map,
        entitlement('db:Organization', at('db:Space', 's1', 'spaces'), 'read'),
        s1,
      ),
    ).toBeNull();
  });
});

describe('the grant check on the placed record', () => {
  test('a manager of o1 grants its own integrations (narrowed), not every kind under it', async () => {
    const manager = await table('db:Organization', 'o1', ['manage']);
    const integrations = entitlement(
      'db:Integration',
      at('db:Organization', 'o1', 'organization'),
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
        entitlement('db:Integration', at('db:Organization', 'o1', 'space.organization'), 'manage'),
        o1,
      ),
    ).toBe(false);
  });

  test('an owner of o1 grants both', async () => {
    const owner = await table('db:Organization', 'o1', ['own']);
    expect(
      await may(
        owner,
        entitlement('db:Integration', at('db:Organization', 'o1', 'space.organization'), 'manage'),
        o1,
      ),
    ).toBe(true);
  });

  test('a token through its integration: a kind at each step', async () => {
    const owner = await table('db:Organization', 'o1', ['own']);
    const tokens = entitlement(
      'db:Token',
      at('db:Organization', 'o1', 'integration.organization'),
      'delete',
    );
    expect(pseudoRecordsOfEntitlement(map, tokens, o1)?.map((token) => token.integration)).toEqual([
      { ownerModel: 'Organization', organizationId: 'o1', organization: o1 },
      {
        ownerModel: 'Space',
        organizationId: 'o1',
        organization: o1,
        space: { organizationId: 'o1', organization: o1 },
      },
    ]);
    expect(await may(owner, tokens, o1)).toBe(true);
    expect(await may(await table('db:Organization', 'o2', ['own']), tokens, o1)).toBe(false);
  });
});

describe('pseudoRecordsBelowAnchor: a record of a resource under an anchor, along a path', () => {
  test('the path decides the relation: its foreign keys, composite ones too, and its kind', () => {
    expect(pseudoRecordsBelowAnchor(map, 'db:Integration', 'space', 'db:Space', s1)).toEqual([
      { ownerModel: 'Space', organizationId: 'o1', spaceId: 's1', space: s1 },
    ]);
  });

  test('a side: the inquiry an organization receives', () => {
    expect(
      pseudoRecordsBelowAnchor(map, 'db:Inquiry', 'targetOrganization', 'db:Organization', o1),
    ).toEqual([
      { targetModel: 'Organization', targetOrganizationId: 'o1', targetOrganization: o1 },
    ]);
  });

  test('a path that does not lead to the anchor places nothing', () => {
    expect(pseudoRecordsBelowAnchor(map, 'db:Integration', 'organization', 'db:Space', s1)).toEqual(
      [],
    );
  });
});

describe('pseudoRecordsOfEntitlement refuses a malformed entry: the same rules setup applies', () => {
  const integrations = entitlement(
    'db:Integration',
    at('db:Organization', 'o1', 'organization'),
    'manage',
  );

  test('an anchor on another resource without a path', () => {
    expect(
      pseudoRecordsOfEntitlement(
        map,
        entitlement('db:Integration', at('db:Organization', 'o1'), 'manage'),
        o1,
      ),
    ).toBeNull();
  });

  test('a where that can hold on a missing value', () => {
    const negated = {
      ...integrations,
      where: { field: 'provider', operator: 'notEquals', value: 'slack' },
    } as EntitlementEntry;
    expect(pseudoRecordsOfEntitlement(map, negated, o1)).toBeNull();
  });

  test('an action that is not a boolean', () => {
    const odd = { ...integrations, actions: { manage: 'yes' } } as unknown as EntitlementEntry;
    expect(pseudoRecordsOfEntitlement(map, odd, o1)).toBeNull();
  });
});
