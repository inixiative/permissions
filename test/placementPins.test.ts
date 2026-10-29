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
const o1 = { id: 'o1' };
const o2 = { id: 'o2' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };

describe('what a grant pins onto its pseudo records', () => {
  test('placeEntitlement is null for an anchor row that is not the entry’s', () => {
    const e: EntitlementEntry = {
      resource: 'db:space',
      anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
      actions: { manage: true },
    };
    expect(placeEntitlement(flat, e, o2)).toBeNull();
  });
  test('a non-equals leaf pins nothing: the writer must cover every value it admits', () => {
    const e = {
      resource: 'db:integration',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      where: { field: 'priority', operator: 'greaterThan', value: 5 },
      actions: { manage: true },
    } as EntitlementEntry;
    const placed = placeEntitlement(flat, e, s1)!;
    expect(placed.every((r) => !('priority' in r))).toBe(true);
    const reader = createPermissions();
    return reader
      .setup({ resource: 'db:space', id: 's1', actions: { read: true } } as PermissionEntry)
      .then(() => {
        expect(placed.every((r) => createCanGrantEntitlement(flat)(reader, schema, e, r))).toBe(
          false,
        );
      });
  });
  test('an equals with options (caseInsensitive) pins nothing', async () => {
    const e = {
      resource: 'db:integration',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      where: { field: 'label', operator: 'equals', value: 'Ops', caseInsensitive: true },
      actions: { label: true },
    } as EntitlementEntry;
    const placed = placeEntitlement(flat, e, s1)!;
    const reader = createPermissions();
    await reader.setup({
      resource: 'db:space',
      id: 's1',
      actions: { read: true },
    } as PermissionEntry);
    expect(placed.every((r) => createCanGrantEntitlement(flat)(reader, schema, e, r))).toBe(false);
  });
  test('a dotted equals leaf is not pinned as a literal key', () => {
    const e = {
      resource: 'db:integration',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      where: { field: 'space.name', operator: 'equals', value: 'x' },
      actions: { manage: true },
    } as EntitlementEntry;
    expect(placeEntitlement(flat, e, s1)!.every((r) => !('space.name' in r))).toBe(true);
  });
});
