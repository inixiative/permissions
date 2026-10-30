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
  const map = mapOf({ membership: { space: 'space' }, space: { organization: 'organization' } });
  const store: Store = {
    organization: [{ id: 'o1', name: 'Org' }],
    space: [{ id: 's1', organizationId: 'o1' }],
  };

  test('attaches each parent, recursively, loading each once by its target columns', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('membership', { id: 'm1', spaceId: 's1' });
    expect(((record.space as Row).organization as Row).name).toBe('Org');
    expect(loads).toEqual(['space:{"id":"s1"}', 'organization:{"id":"o1"}']);
  });

  test('a null foreign key stops the walk: a real deny, not a loading artifact', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('membership', { id: 'm2', spaceId: null });
    expect(record.space).toBeUndefined();
    expect(loads).toEqual([]);
  });

  test('a relation whose parent is missing is left off', async () => {
    const hydrate = createHydrator({ map, load: loaderOver(store) });
    expect((await hydrate('membership', { id: 'm3', spaceId: 'gone' })).space).toBeUndefined();
  });
});

describe('composite and non-id foreign keys', () => {
  const map: SchemaMap = {
    resources: { spaceUser: 'SpaceUser', organizationUser: 'OrganizationUser' },
    fieldMap: {
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
  };
  const store: Store = {
    organizationUser: [{ id: 'ou1', organizationId: 'o1', userId: 'u1', role: 'owner' }],
  };

  test('loads by every column of the key, named as the target names them', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('spaceUser', { id: 'su1', organizationId: 'o1', userId: 'u1' });
    expect((record.organizationUser as Row).role).toBe('owner');
    expect(loads).toEqual(['organizationUser:{"organizationId":"o1","userId":"u1"}']);
  });

  test('a key with one column missing loads nothing', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    await hydrate('spaceUser', { id: 'su2', organizationId: 'o1', userId: null });
    expect(loads).toEqual([]);
  });
});

describe('what the walk does not follow', () => {
  const map: SchemaMap = {
    resources: { flag: 'Flag', segment: 'Segment', owner: 'Owner' },
    fieldMap: {
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
  };
  const store: Store = {
    segment: [{ id: 'g1' }],
    owner: [{ id: 'w1' }],
  };

  test('a relation tagged @permissions(hydrate: false), a list, a back-relation, or a model outside the map', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(store, loads) });
    const record = await hydrate('flag', {
      id: 'f1',
      segmentId: 'g1',
      ownerId: 'w1',
      elsewhereId: 'e1',
    });
    expect(record.segment).toBeUndefined();
    expect((record.owner as Row).id).toBe('w1');
    expect(loads).toEqual(['owner:{"id":"w1"}']);
  });
});

describe('polymorphic records: every relation whose columns are set, whatever the kind', () => {
  const map: SchemaMap = {
    resources: { token: 'Token', user: 'User', organization: 'Organization' },
    fieldMap: {
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
    polymorphism: {
      Token: {
        axes: [
          { field: 'ownerModel', fkMap: { User: ['userId'], Organization: ['organizationId'] } },
        ],
      },
    },
  };
  const store: Store = { user: [{ id: 'u1' }], organization: [{ id: 'o1' }] };

  test('a User token that also carries an organization gets both', async () => {
    const hydrate = createHydrator({ map, load: loaderOver(store) });
    const record = await hydrate('token', {
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
  const map = mapOf({ user: { manager: 'user' } });

  test('a self-referential key is followed once, then cut', async () => {
    const hydrate = createHydrator({
      map,
      load: loaderOver({ user: [{ id: 'u1', managerId: 'u1' }] }),
    });
    const record = await hydrate('user', { id: 'u1', managerId: 'u1' });
    expect((record.manager as Row).id).toBe('u1');
    expect((record.manager as Row).manager).toBeUndefined();
  }, 5000);

  test('an A to B to A loop terminates', async () => {
    const store = {
      user: [
        { id: 'a', managerId: 'b' },
        { id: 'b', managerId: 'a' },
      ],
    };
    const hydrate = createHydrator({ map, load: loaderOver(store) });
    const record = await hydrate('user', store.user[0] as Row);
    const b = record.manager as Row;
    expect(b.id).toBe('b');
    expect((b.manager as Row).id).toBe('a');
    expect((b.manager as Row).manager).toBeUndefined();
  }, 5000);

  test('a parent reached on two paths is hydrated on both and loaded once', async () => {
    const diamond = mapOf({
      grant: { left: 'side', right: 'other' },
      side: { root: 'root' },
      other: { root: 'root' },
    });
    const loads: string[] = [];
    const store: Store = {
      side: [{ id: 'l', rootId: 'r' }],
      other: [{ id: 'g', rootId: 'r' }],
      root: [{ id: 'r', name: 'Root' }],
    };
    const hydrate = createHydrator({ map: diamond, load: loaderOver(store, loads) });
    const record = await hydrate('grant', { id: 'x', leftId: 'l', rightId: 'g' });
    expect(((record.left as Row).root as Row).name).toBe('Root');
    expect(((record.right as Row).root as Row).name).toBe('Root');
    expect(loads.filter((load) => load.startsWith('root:'))).toHaveLength(1);
  });
});
