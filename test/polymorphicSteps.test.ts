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
    Webhook: {
      fields: {
        id: scalar,
        ownerModel: scalar,
        organizationId: scalar,
        integrationId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
        integration: toOne('Integration', ['integrationId'], ['id']),
      },
    },
  },
};
const map: SchemaMap = {
  resources: {
    'db:organization': 'Organization',
    'db:space': 'Space',
    'db:integration': 'Integration',
    'db:webhook': 'Webhook',
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
    Webhook: {
      axes: [
        {
          field: 'ownerModel',
          fkMap: { Integration: ['integrationId'], Organization: ['organizationId'] },
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
    'db:integration': {
      actions: {
        manage: {
          any: [
            { all: [kindIs('Organization'), { rel: 'organization', action: 'manage' }] },
            { all: [kindIs('Space'), { rel: 'space', action: 'manage' }] },
          ],
        },
      },
    },
    'db:webhook': {
      actions: {
        manage: {
          any: [
            { all: [kindIs('Integration'), { rel: 'integration', action: 'manage' }] },
            { all: [kindIs('Organization'), { rel: 'organization', action: 'manage' }] },
          ],
        },
      },
    },
  },
};
const check = createRebacCheck(map);
const canGrant = createCanGrantEntitlement(map);
const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const o1Owner = async () => {
  const p = createPermissions();
  await p.setup({
    resource: 'db:organization',
    id: 'o1',
    actions: { own: true },
  } as PermissionEntry);
  return p;
};

describe('polymorphic steps', () => {
  test('an integration of a kind the `space` relation does not admit is not under s1', async () => {
    const holder = createPermissions();
    await holder.setup(
      [
        {
          resource: 'db:integration',
          anchor: { resource: 'db:space', id: 's1', path: 'space' },
          actions: { manage: true },
        },
      ],
      { owner: await o1Owner() },
    );
    const orgKind = {
      id: 'i1',
      ownerModel: 'Organization',
      organizationId: 'o1',
      organization: o1,
      spaceId: 's1',
      space: s1,
    };
    expect(check(holder, schema, { resource: 'db:integration', record: orgKind }, 'manage')).toBe(
      false,
    );
    const spaceKind = { ...orgKind, ownerModel: 'Space' };
    expect(check(holder, schema, { resource: 'db:integration', record: spaceKind }, 'manage')).toBe(
      true,
    );
  });
  test('the root where narrows only the first step’s kinds: a deeper step keeps every kind', async () => {
    const writer = createPermissions();
    await writer.setup(
      [
        {
          resource: 'db:integration',
          anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
          where: { field: 'ownerModel', operator: 'equals', value: 'Organization' } as never,
          actions: { manage: true },
        },
      ],
      { owner: await o1Owner() },
    );
    const entry = {
      resource: 'db:webhook',
      anchor: { resource: 'db:organization', id: 'o1', path: 'integration.organization' },
      where: { field: 'ownerModel', operator: 'in', value: ['Integration', 'Organization'] },
      actions: { manage: true },
    } as EntitlementEntry;
    const placed = placeEntitlement(map, entry, o1);
    expect(placed!.map((r) => (r.integration as { ownerModel: string }).ownerModel).sort()).toEqual(
      ['Organization', 'Space'],
    );
    expect(placed!.every((r) => canGrant(writer, schema, entry, r))).toBe(false);
  });
});
