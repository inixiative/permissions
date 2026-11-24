import { describe, expect, test } from 'bun:test';
import {
  createPermissions,
  type EntitlementEntry,
  entitlementProblem,
  PathLimitError,
  type Permissions,
  type PermixLike,
  permixOf,
} from '../index';
import { checkWithRules, mapOf, pathsWithRules, type Rules } from './schemaMaps';

const schema: Rules = {
  permissions: {
    'db:space': { actions: { own: null, read: 'own' } },
    'db:project': { actions: { own: null, read: 'own' } },
    'db:doc': {
      actions: {
        publish: {
          all: [
            { rel: 'space', action: 'read' },
            { rel: 'project', action: 'read' },
          ],
        },
      },
    },
  },
};
const schemaMap = mapOf({ 'db:doc': { space: 'db:space', project: 'db:project' } });
const check = checkWithRules(schemaMap);
const paths = pathsWithRules(schemaMap);

const s1 = { id: 's1' };
const p1 = { id: 'p1' };
const doc = { id: 'd1', spaceId: 's1', space: s1, projectId: 'p1', project: p1 };

const reads = (resource: string, id: string, ref: string): EntitlementEntry => ({
  resource,
  anchor: { resource, id },
  actions: { read: true },
  ref,
});

const owning = async (resource: string, id: string) => {
  const permix = createPermissions();
  await permix.setup({ resource, id, actions: { own: true } });
  return permix;
};

const holding = async (...groups: [EntitlementEntry, PermixLike][]) => {
  const permix = createPermissions();
  for (const [entry, owner] of groups) await permix.setup(entry, { owner });
  return permix;
};

const space = { resource: 'db:space', record: s1 } as const;

describe('paths', () => {
  test('every way a check is admitted, in the order the entitlements were set up', async () => {
    const top = await owning('db:space', 's1');
    const b = await holding([reads('db:space', 's1', 'B'), top]);
    const c = await holding([reads('db:space', 's1', 'C'), top]);
    const d = await holding(
      [reads('db:space', 's1', 'D-from-B'), b],
      [reads('db:space', 's1', 'D-from-C'), c],
    );

    expect(paths(d, schema, space, 'read')).toEqual([[['D-from-B', 'B']], [['D-from-C', 'C']]]);
    expect(check(d, schema, space, 'read')).toBe(true);
  });

  test('a path whose upstream no longer admits is gone, with nothing re-saved below it', async () => {
    const top = await owning('db:space', 's1');
    const b = await holding([reads('db:space', 's1', 'B'), createPermissions()]);
    const c = await holding([reads('db:space', 's1', 'C'), top]);
    const d = await holding(
      [reads('db:space', 's1', 'D-from-B'), b],
      [reads('db:space', 's1', 'D-from-C'), c],
    );

    expect(paths(d, schema, space, 'read')).toEqual([[['D-from-C', 'C']]]);
  });

  test('a grant held directly stands on no chain; nothing admitting is no admission', async () => {
    expect(paths(await owning('db:space', 's1'), schema, space, 'read')).toEqual([[]]);
    expect(paths(createPermissions(), schema, space, 'read')).toEqual([]);
  });

  test('an all that needs two delegated branches stands on both chains', async () => {
    const spaceOwner = await owning('db:space', 's1');
    const projectOwner = await owning('db:project', 'p1');
    const d = await holding(
      [reads('db:space', 's1', 'space-row'), spaceOwner],
      [reads('db:project', 'p1', 'project-row'), projectOwner],
    );

    expect(paths(d, schema, { resource: 'db:doc', record: doc }, 'publish')).toEqual([
      [['space-row'], ['project-row']],
    ]);
  });

  test('an all with a branch that admits nothing admits nothing', async () => {
    const d = await holding([reads('db:space', 's1', 'space-row'), await owning('db:space', 's1')]);
    expect(paths(d, schema, { resource: 'db:doc', record: doc }, 'publish')).toEqual([]);
  });

  test('more paths than the limit refuses; at the limit is fine', async () => {
    const top = await owning('db:space', 's1');
    const b = await holding([reads('db:space', 's1', 'B'), top]);
    const c = await holding([reads('db:space', 's1', 'C'), top]);
    const two = await holding([reads('db:space', 's1', 'x'), b], [reads('db:space', 's1', 'y'), c]);
    const three = await holding(
      [reads('db:space', 's1', 'x'), b],
      [reads('db:space', 's1', 'y'), c],
      [reads('db:space', 's1', 'z'), top],
    );
    const limited = pathsWithRules(schemaMap, { limit: 2 });

    expect(limited(two, schema, space, 'read')).toHaveLength(2);
    expect(() => limited(three, schema, space, 'read')).toThrow(PathLimitError);
  });

  test('stacked diamonds: each owner is built once, check stops early, paths hit the limit', async () => {
    const entry = (ref: string) => reads('db:space', 's1', ref);
    let node: Permissions = [
      { entries: [{ resource: 'db:space', id: 's1', actions: { own: true } }] },
    ];
    for (let level = 0; level < 10; level++) {
      const left: Permissions = [{ entries: [entry(`L${level}`)], owner: node }];
      const right: Permissions = [{ entries: [entry(`R${level}`)], owner: node }];
      node = [
        { entries: [entry(`via-L${level}`)], owner: left },
        { entries: [entry(`via-R${level}`)], owner: right },
      ];
    }
    const bottom = await permixOf(node);

    const [viaLeft, viaRight] = bottom.entitlements('db:space', 'read');
    const leftTop = viaLeft?.owner.entitlements?.('db:space', 'read')[0]?.owner;
    const rightTop = viaRight?.owner.entitlements?.('db:space', 'read')[0]?.owner;
    expect(leftTop).toBeDefined();
    expect(leftTop).toBe(rightTop);

    expect(check(bottom, schema, space, 'read')).toBe(true);
    expect(() => paths(bottom, schema, space, 'read')).toThrow(PathLimitError);
  });

  test('a ref is a non-empty string', () => {
    expect(entitlementProblem({ ...reads('db:space', 's1', 'r'), ref: '' })).toBe(
      '`ref` is a non-empty string',
    );
    expect(entitlementProblem(reads('db:space', 's1', 'r'))).toBeNull();
  });
});
