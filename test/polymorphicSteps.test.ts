import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import { Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  pseudoRecordsOfEntitlement,
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
      Webhook: {
        axes: [
          {
            field: 'ownerModel',
            fkMap: { Integration: ['integrationId'], Organization: ['organizationId'] },
          },
        ],
      },
    },
  },
};
const kindIs = (value: string) => ({
  rule: { field: 'ownerModel', operator: Operator.equals, value },
});
const schema: Rules = {
  permissions: {
    'db:Organization': { actions: { own: null, manage: 'own' } },
    'db:Space': { actions: { own: { rel: 'organization', action: 'own' }, manage: 'own' } },
    'db:Integration': {
      actions: {
        manage: {
          any: [
            { all: [kindIs('Organization'), { rel: 'organization', action: 'manage' }] },
            { all: [kindIs('Space'), { rel: 'space', action: 'manage' }] },
          ],
        },
      },
    },
    'db:Webhook': {
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
const check = checkWithRules(map);
const canGrant = canGrantWithRules(map);
const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const o1Owner = async () => {
  const p = createPermissions();
  await p.setup({
    resource: 'db:Organization',
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
          resource: 'db:Integration',
          anchor: { resource: 'db:Space', id: 's1', path: 'space' },
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
    expect(check(holder, schema, { resource: 'db:Integration', record: orgKind }, 'manage')).toBe(
      false,
    );
    const spaceKind = { ...orgKind, ownerModel: 'Space' };
    expect(check(holder, schema, { resource: 'db:Integration', record: spaceKind }, 'manage')).toBe(
      true,
    );
  });
  test('the root where narrows only the first step’s kinds: a deeper step keeps every kind', async () => {
    const writer = createPermissions();
    await writer.setup(
      [
        {
          resource: 'db:Integration',
          anchor: { resource: 'db:Organization', id: 'o1', path: 'organization' },
          where: { field: 'ownerModel', operator: 'equals', value: 'Organization' } as never,
          actions: { manage: true },
        },
      ],
      { owner: await o1Owner() },
    );
    const entry = {
      resource: 'db:Webhook',
      anchor: { resource: 'db:Organization', id: 'o1', path: 'integration.organization' },
      where: { field: 'ownerModel', operator: 'in', value: ['Integration', 'Organization'] },
      actions: { manage: true },
    } as EntitlementEntry;
    const pseudoRecord = pseudoRecordsOfEntitlement(map, entry, o1);
    expect(
      pseudoRecord?.map((r) => (r.integration as { ownerModel: string }).ownerModel).sort(),
    ).toEqual(['Organization', 'Space']);
    expect(pseudoRecord?.every((r) => canGrant(writer, schema, entry, r))).toBe(false);
  });
});
