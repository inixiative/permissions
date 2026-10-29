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
import { mapOf } from './schemaMaps';

const relations = {
  'db:space': { organization: 'db:organization' },
  'db:integration': { space: 'db:space' },
};
const flat = mapOf(relations);
const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own' } },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: 'manage',
      },
    },
    'db:integration': {
      actions: {
        manage: {
          any: [
            { rel: 'space', action: 'manage' },
            {
              all: [
                { rule: { field: 'priority', operator: Operator.equals, value: 5 } },
                { rel: 'space', action: 'read' },
              ],
            },
          ],
        },
        label: {
          all: [
            { rule: { field: 'label', operator: Operator.equals, value: 'Ops' } },
            { rel: 'space', action: 'read' },
          ],
        },
      },
    },
  },
};
const check = createRebacCheck(flat);
const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const manageS1: EntitlementEntry = {
  resource: 'db:space',
  anchor: { resource: 'db:space', id: 's1' },
  actions: { manage: true },
};

describe('the walk', () => {
  test('an owner loop that does not pass through the holder denies, no stack overflow', async () => {
    const holder = createPermissions();
    const b = createPermissions();
    const c = createPermissions();
    await holder.setup([manageS1], { owner: b });
    await b.setup([manageS1], { owner: c });
    await c.setup([manageS1], { owner: b });
    expect(check(holder, schema, { resource: 'db:space', record: s1 }, 'manage')).toBe(false);
  });
  test('a row rule only widens: permissionRules { manage: false } keeps the schema grant', async () => {
    const t = createPermissions();
    await t.setup({
      resource: 'db:organization',
      id: 'o1',
      actions: { own: true },
    } as PermissionEntry);
    expect(
      check(
        t,
        schema,
        { resource: 'db:space', record: { ...s1, permissionRules: { manage: false } } },
        'manage',
      ),
    ).toBe(true);
  });
});
