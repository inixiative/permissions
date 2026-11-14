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
  test('an in list of literals places one record per value, lists on one field intersect, two fields multiply', () => {
    const e = {
      resource: 'db:integration',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      where: {
        all: [
          { field: 'label', operator: 'in', value: ['Ops', 'Eng', 'Sales'] },
          { field: 'label', operator: 'in', value: ['Eng', 'Ops'] },
          { field: 'priority', operator: 'in', value: [1, 2] },
        ],
      },
      actions: { label: true },
    } as EntitlementEntry;
    expect(
      (placeEntitlement(flat, e, s1) ?? []).map(({ label, priority }) => [label, priority]),
    ).toEqual([
      ['Ops', 1],
      ['Ops', 2],
      ['Eng', 1],
      ['Eng', 2],
    ]);
  });
  test('an in list pins nothing when its lists share no value, it is empty, it holds a non-literal, or the records would be too many', () => {
    const placedLabels = (where: EntitlementEntry['where']) =>
      (
        placeEntitlement(
          flat,
          {
            resource: 'db:integration',
            anchor: { resource: 'db:space', id: 's1', path: 'space' },
            where,
            actions: { label: true },
          } as EntitlementEntry,
          s1,
        ) ?? []
      ).map((record) => ('label' in record ? record.label : 'unknown'));
    const many = (prefix: string) => Array.from({ length: 17 }, (_, index) => `${prefix}${index}`);
    expect(
      placedLabels({
        all: [
          { field: 'label', operator: 'in', value: ['Ops'] },
          { field: 'label', operator: 'in', value: ['Eng'] },
        ],
      }),
    ).toEqual(['unknown']);
    expect(placedLabels({ field: 'label', operator: 'in', value: [] })).toEqual(['unknown']);
    expect(placedLabels({ field: 'label', operator: 'in', value: [null] })).toEqual(['unknown']);
    expect(
      placedLabels({
        all: [
          { field: 'label', operator: 'in', value: many('l') },
          { field: 'name', operator: 'in', value: many('n') },
        ],
      }),
    ).toEqual(['unknown']);
  });
  test('an in list under the writer’s own list is granted on every record it places, and refused once one falls outside', async () => {
    const owner = createPermissions();
    await owner.setup({
      resource: 'db:space',
      id: 's1',
      actions: { manage: true },
    } as PermissionEntry);
    const reader = createPermissions();
    await reader.setup(
      [
        {
          resource: 'db:integration',
          anchor: { resource: 'db:space', id: 's1', path: 'space' },
          where: { field: 'label', operator: 'in', value: ['Ops', 'Eng'] },
          actions: { manage: true },
        } as EntitlementEntry,
      ],
      { owner },
    );
    const grantsLabels = (labels: string[]) => {
      const e = {
        resource: 'db:integration',
        anchor: { resource: 'db:space', id: 's1', path: 'space' },
        where: { field: 'label', operator: 'in', value: labels },
        actions: { manage: true },
      } as EntitlementEntry;
      const placed = placeEntitlement(flat, e, s1);
      return (
        placed !== null &&
        placed.every((record) => createCanGrantEntitlement(flat)(reader, schema, e, record))
      );
    };
    expect(grantsLabels(['Ops'])).toBe(true);
    expect(grantsLabels(['Eng', 'Ops'])).toBe(true);
    expect(grantsLabels(['Ops', 'Sales'])).toBe(false);
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

describe("the app's json-rules string settings never reach permissions (R99)", () => {
  test('with case-insensitive strings on globally, a where and a kind leaf still match exactly', async () => {
    const { engineGlobals } = await import('@inixiative/json-rules');
    engineGlobals.set('string.caseInsensitive', true);
    try {
      const reader = createPermissions();
      await reader.setup({
        resource: 'db:space',
        id: 's1',
        actions: { read: true },
      } as PermissionEntry);
      const ops = {
        resource: 'db:integration',
        anchor: { resource: 'db:space', id: 's1', path: 'space' },
        where: { field: 'label', operator: 'equals', value: 'Ops' },
        actions: { label: true },
      } as EntitlementEntry;
      const placed = placeEntitlement(flat, ops, s1) ?? [];
      expect(placed.map((record) => record.label)).toEqual(['Ops']);
      const check = createRebacCheck(flat);
      expect(
        check(
          reader,
          schema,
          { resource: 'db:integration', record: { label: 'ops', spaceId: 's1', space: s1 } },
          'label',
        ),
      ).toBe(false);
      expect(
        check(
          reader,
          schema,
          { resource: 'db:integration', record: { label: 'Ops', spaceId: 's1', space: s1 } },
          'label',
        ),
      ).toBe(true);
    } finally {
      engineGlobals.reset();
    }
  });
});
