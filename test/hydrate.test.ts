import { describe, expect, test } from 'bun:test';
import { createHydrator, type Row, type SchemaMap } from '../index';
import { mapOf } from './schemaMaps';

type Store = Record<string, Row[]>;

const loaderOver = (store: Store, sink?: string[]) => async (resource: string, where: Row) => {
  sink?.push(`${resource}:${JSON.stringify(where)}`);
  return (
    store[resource]?.find((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    ) ?? null
  );
};

const relation = (type: string, from: string[], to: string[], extra: Row = {}) => ({
  kind: 'object' as const,
  type,
  isList: false,
  fromFields: from,
  toFields: to,
  ...extra,
});

describe('createHydrator: the to-one, foreign-key-owning closure from the schema map', () => {
  const map = mapOf({
    'db:membership': { space: 'db:space' },
    'db:space': { organization: 'db:organization' },
  });
  const store: Store = {
    'db:organization': [{ id: 'o1', name: 'Org' }],
    'db:space': [{ id: 's1', organizationId: 'o1' }],
  };

  test('attaches each parent, recursively, loading each once by its target columns', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('db:membership', { id: 'm1', spaceId: 's1' });
    expect(((record.space as Row).organization as Row).name).toBe('Org');
    expect(loads).toEqual(['db:space:{"id":"s1"}', 'db:organization:{"id":"o1"}']);
  });

  test('a null foreign key stops the walk: a real deny, not a loading artifact', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('db:membership', { id: 'm2', spaceId: null });
    expect(record.space).toBeUndefined();
    expect(loads).toEqual([]);
  });

  test('a relation whose parent is missing is left off', async () => {
    const hydrate = createHydrator({ map, load: loaderOver(store) });
    expect((await hydrate('db:membership', { id: 'm3', spaceId: 'gone' })).space).toBeUndefined();
  });
});

describe('composite and non-id foreign keys', () => {
  const map: SchemaMap = {
    permissions: {},
    maps: {
      db: {
        models: {
          SpaceUser: {
            fields: {
              organizationUser: relation(
                'OrganizationUser',
                ['organizationId', 'userId'],
                ['organizationId', 'userId'],
              ),
            },
          },
          OrganizationUser: { fields: {} },
        },
      },
    },
  };
  const store: Store = {
    'db:OrganizationUser': [{ id: 'ou1', organizationId: 'o1', userId: 'u1', role: 'owner' }],
  };

  test('loads by every column of the key, named as the target names them', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('db:SpaceUser', { id: 'su1', organizationId: 'o1', userId: 'u1' });
    expect((record.organizationUser as Row).role).toBe('owner');
    expect(loads).toEqual(['db:OrganizationUser:{"organizationId":"o1","userId":"u1"}']);
  });

  test('a key with one column missing loads nothing', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    await hydrate('db:SpaceUser', { id: 'su2', organizationId: 'o1', userId: null });
    expect(loads).toEqual([]);
  });
});

describe('what the walk does not follow', () => {
  const map: SchemaMap = {
    permissions: {},
    maps: {
      db: {
        models: {
          Flag: {
            fields: {
              segment: relation('Segment', ['segmentId'], ['id'], {
                annotations: { permissions: { hydrate: false } },
              }),
              owner: relation('Owner', ['ownerId'], ['id']),
              variants: { kind: 'object', type: 'Segment', isList: true },
              unmapped: relation('Elsewhere', ['elsewhereId'], ['id']),
            },
          },
          Segment: { fields: { flags: { kind: 'object', type: 'Flag', isList: true } } },
          Owner: { fields: {} },
        },
      },
    },
  };
  const store: Store = {
    'db:Segment': [{ id: 'g1' }],
    'db:Owner': [{ id: 'w1' }],
  };

  test('a relation tagged @permissions(hydrate: false), a list, a back-relation, or a model outside the map', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('db:Flag', {
      id: 'f1',
      segmentId: 'g1',
      ownerId: 'w1',
      elsewhereId: 'e1',
    });
    expect(record.segment).toBeUndefined();
    expect((record.owner as Row).id).toBe('w1');
    expect(loads).toEqual(['db:Owner:{"id":"w1"}']);
  });
});

describe('polymorphic records: every relation whose columns are set, whatever the kind', () => {
  const map: SchemaMap = {
    permissions: {},
    maps: {
      db: {
        models: {
          Token: {
            fields: {
              user: relation('User', ['userId'], ['id']),
              organization: relation('Organization', ['organizationId'], ['id']),
            },
          },
          User: { fields: {} },
          Organization: { fields: {} },
        },
      },
    },
    polymorphism: {
      db: {
        Token: {
          axes: [
            { field: 'ownerModel', fkMap: { User: ['userId'], Organization: ['organizationId'] } },
          ],
        },
      },
    },
  };
  const store: Store = { 'db:User': [{ id: 'u1' }], 'db:Organization': [{ id: 'o1' }] };

  test('a User token that also carries an organization gets both', async () => {
    const hydrate = createHydrator({ map, load: loaderOver(store) });
    const record = await hydrate('db:Token', {
      id: 't1',
      ownerModel: 'User',
      userId: 'u1',
      organizationId: 'o1',
    });
    expect((record.user as Row).id).toBe('u1');
    expect((record.organization as Row).id).toBe('o1');
  });
});

describe('cycles and shared parents', () => {
  const map = mapOf({ 'db:user': { manager: 'db:user' } });

  test('a self-referential key loads the stored row once, which then holds itself', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({
      map,
      load: loaderOver({ 'db:user': [{ id: 'u1', managerId: 'u1', name: 'Una' }] }, loads),
    });
    const record = await hydrate('db:user', { id: 'u1', managerId: 'u1' });
    const stored = record.manager as Row;
    expect(stored.name).toBe('Una');
    expect(stored.manager).toBe(stored);
    expect(loads).toEqual(['db:user:{"id":"u1"}']);
  }, 5000);

  test('an A to B to A loop from a partial root loads A once and links on the next lap', async () => {
    const store = {
      'db:user': [
        { id: 'a', managerId: 'b' },
        { id: 'b', managerId: 'a' },
      ],
    };
    const hydrate = createHydrator({ map, load: loaderOver(store) });
    const record = await hydrate('db:user', { id: 'a', managerId: 'b' });
    const b = record.manager as Row;
    expect(b.id).toBe('b');
    const a = b.manager as Row;
    expect(a).not.toBe(record);
    expect(a.manager).toBe(b);
  }, 5000);

  test('a parent reached on two paths is hydrated on both and loaded once', async () => {
    const diamond = mapOf({
      'db:grant': { left: 'db:side', right: 'db:other' },
      'db:side': { root: 'db:root' },
      'db:other': { root: 'db:root' },
    });
    const loads: string[] = [];
    const store: Store = {
      'db:side': [{ id: 'l', rootId: 'r' }],
      'db:other': [{ id: 'g', rootId: 'r' }],
      'db:root': [{ id: 'r', name: 'Root' }],
    };
    const hydrate = createHydrator({ map: diamond, load: loaderOver(store, loads) });
    const record = await hydrate('db:grant', { id: 'x', leftId: 'l', rightId: 'g' });
    expect(((record.left as Row).root as Row).name).toBe('Root');
    expect(((record.right as Row).root as Row).name).toBe('Root');
    expect(loads.filter((load) => load.startsWith('db:root:'))).toHaveLength(1);
  });
});
