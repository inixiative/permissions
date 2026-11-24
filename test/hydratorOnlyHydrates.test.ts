import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import {
  makeHydrator,
  makeRebacCheck,
  type Row,
  type SchemaMap,
  validateSchemaMap,
} from '../index';

const id = { kind: 'scalar', type: 'String', isId: true } as const;
const column = { kind: 'scalar', type: 'String' } as const;

const fieldMap: FieldMap = {
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
};

const store: Record<string, Row[]> = { 'db:Organization': [{ id: 'o1', name: 'Org' }] };
const load = async (resource: string, where: Row) =>
  store[resource]?.find((row) => row.id === where.id) ?? null;
const space = { id: 's1', organizationId: 'o1' };
const nobody = { check: () => false };

describe('the hydrator only hydrates, one field map at a time', () => {
  test('it takes one field map and its name, and nothing else of the schema map', async () => {
    const hydrated = await makeHydrator({ mapName: 'db', fieldMap, load })('db:Space', space);
    expect((hydrated.organization as Row).name).toBe('Org');
  });

  test('the name it is given is the map half of every resource it reads and loads', async () => {
    const asked: string[] = [];
    const loadFromCrm = async (resource: string, where: Row) => {
      asked.push(resource);
      return store[resource.replace('crm:', 'db:')]?.find((row) => row.id === where.id) ?? null;
    };
    const hydrate = makeHydrator({ mapName: 'crm', fieldMap, load: loadFromCrm });
    expect(((await hydrate('crm:Space', space)).organization as Row).name).toBe('Org');
    expect(asked).toEqual(['crm:Organization']);
  });

  test('what is wrong with the map’s names is the validator’s and the check’s, never the hydrator’s', async () => {
    const schemaMap: SchemaMap = {
      fieldMaps: { db: fieldMap, 'bad:name': fieldMap },
      permissions: { 'db:Space': { actions: { read: true } } },
    };
    const hydrated = await makeHydrator({ mapName: 'db', fieldMap, load })('db:Space', space);
    expect((hydrated.organization as Row).name).toBe('Org');
    expect(validateSchemaMap(schemaMap).errors.map((issue) => issue.message)).toEqual([
      "a map is named `bad:name`: a map's name is the part of `map:Model` before the colon",
    ]);
    expect(() =>
      makeRebacCheck(schemaMap)(nobody, { resource: 'db:Space', record: hydrated }, 'read'),
    ).toThrow(/a map is named `bad:name`/);
  });
});
