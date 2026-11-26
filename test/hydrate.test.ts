import { describe, expect, test } from 'bun:test';
import { type Down, hydrationLimits, makeHydrator, type Row, type SchemaMap } from '../index';
import { dbFieldMapOf, mapOf } from './schemaMaps';

type Store = Record<string, Row[]>;
type BatchCall = { resource: string; wheres: readonly Row[]; down: Down };

const loaderOver =
  (store: Store, sink?: string[], calls?: BatchCall[]) =>
  async (resource: string, wheres: readonly Row[], down: Down) => {
    calls?.push({ resource, wheres, down });
    return wheres.map((where) => {
      sink?.push(`${resource}:${JSON.stringify(where)}`);
      return (
        store[resource]?.find((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ) ?? null
      );
    });
  };

const relation = (type: string, from: string[], to: string[], extra: Row = {}) => ({
  kind: 'object' as const,
  type,
  isList: false,
  fromFields: from,
  toFields: to,
  ...extra,
});

describe('makeHydrator: the to-one, foreign-key-owning closure from the schema map', () => {
  const schemaMap = mapOf({
    'db:membership': { space: 'db:space' },
    'db:space': { organization: 'db:organization' },
  });
  const store: Store = {
    'db:organization': [{ id: 'o1', name: 'Org' }],
    'db:space': [{ id: 's1', organizationId: 'o1' }],
  };

  test('attaches each parent, recursively, loading each once by its target columns', async () => {
    const loads: string[] = [];
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(schemaMap),
      loadMany: loaderOver(store, loads),
    });
    const record = await hydrate('db:membership', { id: 'm1', spaceId: 's1' });
    expect(((record.space as Row).organization as Row).name).toBe('Org');
    expect(loads).toEqual(['db:space:{"id":"s1"}', 'db:organization:{"id":"o1"}']);
  });

  test('a null foreign key stops the walk: a real deny, not a loading artifact', async () => {
    const loads: string[] = [];
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(schemaMap),
      loadMany: loaderOver(store, loads),
    });
    const record = await hydrate('db:membership', { id: 'm2', spaceId: null });
    expect(record.space).toBeUndefined();
    expect(loads).toEqual([]);
  });

  test('a relation whose parent is missing is left off', async () => {
    const { hydrate } = makeHydrator({ ...dbFieldMapOf(schemaMap), loadMany: loaderOver(store) });
    expect((await hydrate('db:membership', { id: 'm3', spaceId: 'gone' })).space).toBeUndefined();
  });
});

describe('composite and non-id foreign keys', () => {
  const schemaMap: SchemaMap = {
    permissions: {},
    fieldMaps: {
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
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(schemaMap),
      loadMany: loaderOver(store, loads),
    });
    const record = await hydrate('db:SpaceUser', { id: 'su1', organizationId: 'o1', userId: 'u1' });
    expect((record.organizationUser as Row).role).toBe('owner');
    expect(loads).toEqual(['db:OrganizationUser:{"organizationId":"o1","userId":"u1"}']);
  });

  test('a key with one column missing loads nothing', async () => {
    const loads: string[] = [];
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(schemaMap),
      loadMany: loaderOver(store, loads),
    });
    await hydrate('db:SpaceUser', { id: 'su2', organizationId: 'o1', userId: null });
    expect(loads).toEqual([]);
  });
});

describe('what the walk does not follow', () => {
  const schemaMap: SchemaMap = {
    permissions: {},
    fieldMaps: {
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
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(schemaMap),
      loadMany: loaderOver(store, loads),
    });
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
  const schemaMap: SchemaMap = {
    permissions: {},
    fieldMaps: {
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
    polymorphismRegistries: {
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
    const { hydrate } = makeHydrator({ ...dbFieldMapOf(schemaMap), loadMany: loaderOver(store) });
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
  const schemaMap = mapOf({ 'db:user': { manager: 'db:user' } });

  test('a self-referential key loads the stored row once, which then holds itself', async () => {
    const loads: string[] = [];
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(schemaMap),
      loadMany: loaderOver({ 'db:user': [{ id: 'u1', managerId: 'u1', name: 'Una' }] }, loads),
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
    const { hydrate } = makeHydrator({ ...dbFieldMapOf(schemaMap), loadMany: loaderOver(store) });
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
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(diamond),
      loadMany: loaderOver(store, loads),
    });
    const record = await hydrate('db:grant', { id: 'x', leftId: 'l', rightId: 'g' });
    expect(((record.left as Row).root as Row).name).toBe('Root');
    expect(((record.right as Row).root as Row).name).toBe('Root');
    expect((record.left as Row).root).toBe((record.right as Row).root);
    expect(loads.filter((load) => load.startsWith('db:root:'))).toHaveLength(1);
  });
});

describe('hydrateMany: breadth-first layer-by-layer batching', () => {
  const treeMap = mapOf({
    'db:placement': { container: 'db:artifact', artifact: 'db:artifact' },
    'db:artifact': { space: 'db:space' },
    'db:space': { organization: 'db:organization' },
  });
  const treeStore: Store = {
    'db:organization': [{ id: 'o1', name: 'Acme' }],
    'db:space': [{ id: 's1', organizationId: 'o1' }],
    'db:artifact': [
      { id: 'folder', spaceId: 's1', name: 'Folder' },
      { id: 'a1', spaceId: 's1', name: 'One' },
      { id: 'a2', spaceId: 's1', name: 'Two' },
      { id: 'a3', spaceId: 's1', name: 'Three' },
    ],
  };

  test('batches one loadMany call per resource per layer, sharing objects across all records', async () => {
    const calls: BatchCall[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: loaderOver(treeStore, undefined, calls),
    });
    const placements = [
      { id: 'p1', containerId: 'folder', artifactId: 'a1' },
      { id: 'p2', containerId: 'folder', artifactId: 'a2' },
      { id: 'p3', containerId: 'folder', artifactId: 'a3' },
    ];
    const hydrated = await hydrateMany('db:placement', placements);
    expect(hydrated).toHaveLength(3);
    expect(hydrated.map((row) => row.id)).toEqual(['p1', 'p2', 'p3']);
    // Layer 1: 1 call for all 4 unique artifacts; Layer 2: 1 call for shared space; Layer 3: 1 call for shared org.
    expect(calls.map(({ resource, wheres }) => ({ resource, wheres }))).toEqual([
      {
        resource: 'db:artifact',
        wheres: [{ id: 'folder' }, { id: 'a1' }, { id: 'a2' }, { id: 'a3' }],
      },
      { resource: 'db:space', wheres: [{ id: 's1' }] },
      { resource: 'db:organization', wheres: [{ id: 'o1' }] },
    ]);
    // Shared parents are the exact same JS objects across every hydrated record.
    expect(hydrated[0]?.container).toBe(hydrated[1]?.container);
    expect(hydrated[1]?.container).toBe(hydrated[2]?.container);
    expect((hydrated[0]?.artifact as Row).space).toBe((hydrated[2]?.artifact as Row).space);
    expect(((hydrated[0]?.artifact as Row).space as Row).organization).toBe(
      ((hydrated[2]?.container as Row).space as Row).organization,
    );
  });

  test('single-record hydrate also batches same-layer relations to the same resource into one call', async () => {
    const calls: BatchCall[] = [];
    const { hydrate } = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: loaderOver(treeStore, undefined, calls),
    });
    const hydrated = await hydrate('db:placement', {
      id: 'p1',
      containerId: 'folder',
      artifactId: 'a1',
    });
    expect((hydrated.container as Row).name).toBe('Folder');
    expect((hydrated.artifact as Row).name).toBe('One');
    expect(calls[0]?.resource).toBe('db:artifact');
    expect(calls[0]?.wheres).toEqual([{ id: 'folder' }, { id: 'a1' }]);
  });

  test('empty input returns [] without calling loadMany, and still validates the resource', async () => {
    const calls: BatchCall[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: loaderOver(treeStore, undefined, calls),
    });
    expect(await hydrateMany('db:placement', [])).toEqual([]);
    expect(calls).toEqual([]);
    await expect(hydrateMany('db:Unknown', [])).rejects.toThrow(
      /`db:Unknown` is not a model of the map `db` this hydrator was made for/,
    );
  });

  test('groups keys by column set so every loadMany call receives wheres sharing the same key columns', async () => {
    const mixedKeysMap: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Link: {
              fields: {
                byId: relation('Space', ['spaceId'], ['id']),
                bySlug: relation('Space', ['spaceSlug'], ['slug']),
              },
            },
            Space: { fields: {} },
          },
        },
      },
    };
    const store: Store = {
      'db:Space': [
        { id: 's1', slug: 'alpha' },
        { id: 's2', slug: 'beta' },
      ],
    };
    const calls: BatchCall[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(mixedKeysMap),
      loadMany: loaderOver(store, undefined, calls),
    });
    const rows = await hydrateMany('db:Link', [
      { id: 'l1', spaceId: 's1', spaceSlug: 'beta' },
      { id: 'l2', spaceId: 's2', spaceSlug: 'alpha' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls.map(({ wheres }) => wheres)).toEqual([
      [{ id: 's1' }, { id: 's2' }],
      [{ slug: 'beta' }, { slug: 'alpha' }],
    ]);
    expect((rows[0]?.byId as Row).id).toBe('s1');
    expect((rows[0]?.bySlug as Row).id).toBe('s2');
  });

  test('duplicate roots and cycles across a batch load each row once and never alias roots', async () => {
    const cycleMap = mapOf({ 'db:user': { manager: 'db:user' } });
    const store: Store = {
      'db:user': [
        { id: 'a', managerId: 'b', name: 'A' },
        { id: 'b', managerId: 'a', name: 'B' },
      ],
    };
    const loads: string[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(cycleMap),
      loadMany: loaderOver(store, loads),
    });
    const rootA = { id: 'a', managerId: 'b', callerTag: 1 };
    const [first, second, third] = await hydrateMany('db:user', [
      rootA,
      rootA,
      { id: 'b', managerId: 'a', callerTag: 2 },
    ]);
    expect(first).not.toBe(second);
    expect(first).not.toBe(rootA);
    expect(first?.manager).toBe(second?.manager);
    const storedB = first?.manager as Row;
    const storedA = storedB.manager as Row;
    expect(storedA).toBe(third?.manager as Row);
    expect(storedA).not.toBe(first);
    expect(storedA.manager).toBe(storedB);
    expect(loads.sort()).toEqual(['db:user:{"id":"a"}', 'db:user:{"id":"b"}']);
  });

  test('batches root declared lists with layer 1 to-ones without loading stale root FKs', async () => {
    const column = (extra: Row = {}) => ({
      kind: 'scalar',
      type: 'String',
      isList: false,
      ...extra,
    });
    const listMap = {
      fieldMaps: {
        db: {
          models: {
            Node: {
              fields: {
                id: column({ isId: true }),
                parentId: column(),
                parent: relation('Node', ['parentId'], ['id']),
                items: {
                  kind: 'object',
                  type: 'Item',
                  isList: true,
                  annotations: { permissions: { down: [] } },
                },
              },
            },
            Item: {
              fields: {
                id: column({ isId: true }),
                nodeId: column(),
                node: relation('Node', ['nodeId'], ['id']),
              },
            },
          },
        },
      },
    } as unknown as SchemaMap;
    const store: Store = {
      'db:Node': [
        { id: 'n1', parentId: 'stale-parent', items: [{ id: 'i1', nodeId: 'n1' }] },
        { id: 'n2', parentId: 'n1', items: [{ id: 'i2', nodeId: 'n2' }] },
        { id: 'stale-parent', parentId: null, items: [] },
      ],
    };
    const calls: BatchCall[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(listMap),
      loadMany: loaderOver(store, undefined, calls),
    });

    // Root n1 has caller-cleared parentId: null — its stored stale-parent must NOT be loaded.
    const [onlyN1] = await hydrateMany('db:Node', [
      { id: 'n1', parentId: null, parent: { forged: true }, items: [{ forged: true }] },
    ]);
    expect(onlyN1?.parent).toBeUndefined();
    expect(onlyN1?.items).toEqual([{ id: 'i1', nodeId: 'n1' }]);
    expect(calls.map(({ wheres }) => wheres)).toEqual([[{ id: 'n1' }]]);

    // When another root in the batch points to n1 as a to-one, n1 loads ONCE in layer 1 and is
    // hydrated as a to-one (which then walks stored n1's parent in layer 2).
    calls.length = 0;
    const [h1, h2, unsaved] = await hydrateMany('db:Node', [
      { id: 'n1', parentId: null },
      { id: 'n2', parentId: 'n1' },
      { parentId: null, items: [{ forged: true }] },
    ]);
    expect(calls.map(({ wheres }) => wheres)).toEqual([
      [{ id: 'n1' }, { id: 'n2' }],
      [{ id: 'stale-parent' }],
    ]);
    expect(h1?.items).toEqual([{ id: 'i1', nodeId: 'n1' }]);
    expect(h1?.parent).toBeUndefined();
    expect((h2?.parent as Row).id).toBe('n1');
    expect(((h2?.parent as Row).parent as Row).id).toBe('stale-parent');
    expect((h2?.parent as Row).items).toEqual([{ id: 'i1', nodeId: 'n1' }]);
    expect((h2?.parent as Row).items).not.toBe(h1?.items);
    expect(unsaved?.items).toEqual([]);
  });

  test('scales load budget by records.length and throws before calling loadMany when exceeded', async () => {
    const budget = hydrationLimits.loads;
    const calls: BatchCall[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: loaderOver(treeStore, undefined, calls),
    });
    hydrationLimits.loads = 2;
    try {
      // 3 placements -> budget 6; 4 unique artifacts + 1 space + 1 org = 6 loads -> succeeds.
      const rows = await hydrateMany('db:placement', [
        { id: 'p1', containerId: 'folder', artifactId: 'a1' },
        { id: 'p2', containerId: 'folder', artifactId: 'a2' },
        { id: 'p3', containerId: 'folder', artifactId: 'a3' },
      ]);
      expect(rows).toHaveLength(3);
    } finally {
      hydrationLimits.loads = budget;
    }

    calls.length = 0;
    hydrationLimits.loads = 1;
    try {
      // 2 placements -> budget 2; layer 1 has 3 unique artifacts -> throws before layer 1 calls loadMany.
      await expect(
        hydrateMany('db:placement', [
          { id: 'p1', containerId: 'folder', artifactId: 'a1' },
          { id: 'p2', containerId: 'folder', artifactId: 'a2' },
        ]),
      ).rejects.toThrow(/past 2 rows/);
      expect(calls).toEqual([]);
    } finally {
      hydrationLimits.loads = budget;
    }
  });

  test('throws loudly if loadMany returns the wrong length, a non-array, or a non-row item', async () => {
    const badLength = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: async () => [],
    });
    await expect(
      badLength.hydrate('db:placement', { id: 'p1', containerId: 'folder', artifactId: 'a1' }),
    ).rejects.toThrow(/must return an array matching `wheres`/);

    const nonArray = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: async () => null as unknown as readonly (Row | null)[],
    });
    await expect(
      nonArray.hydrate('db:placement', { id: 'p1', containerId: 'folder', artifactId: 'a1' }),
    ).rejects.toThrow(/must return an array matching `wheres`/);

    const badItem = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: async (_r, wheres) => wheres.map(() => undefined as unknown as Row | null),
    });
    await expect(
      badItem.hydrate('db:placement', { id: 'p1', containerId: 'folder', artifactId: 'a1' }),
    ).rejects.toThrow(/not a row or null/);

    const arrayItem = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: async (_r, wheres) => wheres.map(() => [] as unknown as Row),
    });
    await expect(
      arrayItem.hydrate('db:placement', { id: 'p1', containerId: 'folder', artifactId: 'a1' }),
    ).rejects.toThrow(/not a row or null/);
  });

  test('layer 1 root list hit reached again as a to-one in layer 2 reuses loaded row with separate list copy', async () => {
    const column = (extra: Row = {}) => ({
      kind: 'scalar',
      type: 'String',
      isList: false,
      ...extra,
    });
    const listMap = {
      fieldMaps: {
        db: {
          models: {
            Node: {
              fields: {
                id: column({ isId: true }),
                parentId: column(),
                parent: relation('Node', ['parentId'], ['id']),
                items: {
                  kind: 'object',
                  type: 'Item',
                  isList: true,
                  annotations: { permissions: { down: [] } },
                },
              },
            },
            Item: {
              fields: {
                id: column({ isId: true }),
                nodeId: column(),
                node: relation('Node', ['nodeId'], ['id']),
              },
            },
          },
        },
      },
    } as unknown as SchemaMap;
    const store: Store = {
      'db:Node': [
        { id: 'n1', parentId: 'n2', items: [{ id: 'i1', nodeId: 'n1' }] },
        { id: 'n2', parentId: 'n1', items: [] },
      ],
    };
    const calls: BatchCall[] = [];
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(listMap),
      loadMany: loaderOver(store, undefined, calls),
    });
    // Layer 1 loads n1 (isFollowedToOne: false for root list) and n2 (isFollowedToOne: true).
    // Layer 2 reaches n1 via n2.parent — n1 is already in loadedRows so NO second loadMany call happens.
    const [h1] = await hydrateMany('db:Node', [{ id: 'n1', parentId: 'n2' }]);
    expect(calls.map(({ wheres }) => wheres)).toEqual([[{ id: 'n1' }, { id: 'n2' }]]);
    const reachedN1 = (h1?.parent as Row).parent as Row;
    expect(reachedN1.id).toBe('n1');
    expect(reachedN1).not.toBe(h1 as Row);
    expect(reachedN1.items).toEqual([{ id: 'i1', nodeId: 'n1' }]);
    expect(reachedN1.items).not.toBe(h1?.items);

    // Same when the layer 1 root list row is missing (null) and layer 2 reaches it via a to-one.
    calls.length = 0;
    const missingStore: Store = {
      'db:Node': [{ id: 'n2', parentId: 'missing', items: [] }],
    };
    const { hydrateMany: hydrateMissing } = makeHydrator({
      ...dbFieldMapOf(listMap),
      loadMany: loaderOver(missingStore, undefined, calls),
    });
    const [m1] = await hydrateMissing('db:Node', [{ id: 'missing', parentId: 'n2' }]);
    expect(calls.map(({ wheres }) => wheres)).toEqual([[{ id: 'missing' }, { id: 'n2' }]]);
    expect(m1?.items).toEqual([]);
    expect((m1?.parent as Row).parent).toBeUndefined();

    // Truly empty layer still strips both forged to-ones and forged declared lists.
    calls.length = 0;
    const [emptyLayer] = await hydrateMany('db:Node', [
      { parentId: null, parent: { forged: true }, items: [{ forged: true }] },
    ]);
    expect(calls).toEqual([]);
    expect(emptyLayer?.parent).toBeUndefined();
    expect(emptyLayer?.items).toEqual([]);
  });

  test('mutating the input records array or a root record during loadMany does not corrupt linking', async () => {
    const records: Row[] = [
      { id: 'p1', containerId: 'folder', artifactId: 'a1' },
      { id: 'p2', containerId: 'folder', artifactId: 'a2' },
    ];
    const baseLoad = loaderOver(treeStore);
    const { hydrateMany } = makeHydrator({
      ...dbFieldMapOf(treeMap),
      loadMany: async (resource, wheres, down) => {
        // Mutate both the caller's record and the caller's array while loadMany is in flight.
        if (records[0]) records[0].artifactId = 'a2';
        records.length = 0;
        return baseLoad(resource, wheres, down);
      },
    });
    const [h1, h2] = await hydrateMany('db:placement', records);
    expect(h1?.artifactId).toBe('a1');
    expect((h1?.artifact as Row).id).toBe('a1');
    expect(h2?.artifactId).toBe('a2');
    expect((h2?.artifact as Row).id).toBe('a2');
  });
});
