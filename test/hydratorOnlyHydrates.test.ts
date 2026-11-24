import { describe, expect, test } from 'bun:test';
import {
  makeHydrator,
  makeRebacCheck,
  type RecordFieldMaps,
  type Row,
  type SchemaMap,
  validateSchema,
} from '../index';

const id = { kind: 'scalar', type: 'String', isId: true } as const;
const column = { kind: 'scalar', type: 'String' } as const;

const records: RecordFieldMaps = {
  maps: {
    db: {
      models: {
        Space: {
          fields: {
            id,
            organizationId: column,
            organization: {
              kind: 'object',
              type: 'Organization',
              isList: false,
              fromFields: ['organizationId'],
              toFields: ['id'],
            },
          },
        },
        Organization: { fields: { id, name: column } },
      },
    },
  },
};

const store: Record<string, Row[]> = { 'db:Organization': [{ id: 'o1', name: 'Org' }] };
const load = async (resource: string, where: Row) =>
  store[resource]?.find((row) => row.id === where.id) ?? null;
const space = { id: 's1', organizationId: 'o1' };
const nobody = { check: () => false };

describe('the hydrator only hydrates', () => {
  test('it takes the record field maps and their polymorphism, and nothing else', async () => {
    const hydrated = await makeHydrator({ map: records, load })('db:Space', space);
    expect((hydrated.organization as Row).name).toBe('Org');
  });

  test('a whole schema map is record field maps too', async () => {
    const map: SchemaMap = { ...records, permissions: {} };
    const hydrated = await makeHydrator({ map, load })('db:Space', space);
    expect((hydrated.organization as Row).name).toBe('Org');
  });

  test('what is wrong with the map’s names is the validator’s and the check’s, never the hydrator’s', async () => {
    const actor = { models: { User: { fields: { id } } } };
    const map: SchemaMap = {
      ...records,
      supplied: { db: actor },
      permissions: { 'db:Space': { actions: { read: true } } },
    };
    const hydrated = await makeHydrator({ map, load })('db:Space', space);
    expect((hydrated.organization as Row).name).toBe('Org');
    expect(validateSchema(map).errors.map((issue) => issue.message)).toEqual([
      '`db` is in both `maps` and `supplied`: a map is one or the other',
    ]);
    expect(() =>
      makeRebacCheck(map)(nobody, { resource: 'db:Space', record: hydrated }, 'read'),
    ).toThrow(/`db` is in both `maps` and `supplied`/);
  });
});
