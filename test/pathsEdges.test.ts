import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  type Admission,
  createPermissions,
  type EntitlementEntry,
  PathLimitError,
  type Permissions,
  type PermixLike,
  permixOf,
  type Row,
} from '../index';
import { checkWithRules, mapOf, pathsWithRules, type Rules } from './schemaMaps';

const spaceSchema: Rules = {
  permissions: { 'db:space': { actions: { own: null, read: 'own' } } },
};
const spaceMap = mapOf({ 'db:space': {} });
const s1 = { id: 's1' };
const space = { resource: 'db:space', record: s1 } as const;

const onSpace = (ref: string | undefined, actions: EntitlementEntry['actions']) => ({
  resource: 'db:space',
  anchor: { resource: 'db:space', id: 's1' },
  actions,
  ...(ref === undefined ? {} : { ref }),
});

const owning = async () => {
  const permix = createPermissions();
  await permix.setup({ resource: 'db:space', id: 's1', actions: { own: true } });
  return permix;
};

const holding = async (...groups: [EntitlementEntry, PermixLike][]) => {
  const permix = createPermissions();
  for (const [entry, owner] of groups) await permix.setup(entry, { owner });
  return permix;
};

const refsOf = (admissions: Admission[]) => admissions.flatMap((admission) => admission.flat());

describe('paths and check agree on what admits', () => {
  test('a loop through the data past a direct grant adds nothing; it never throws', async () => {
    const schema: Rules = {
      permissions: {
        'db:space': { actions: { read: { rel: 'org', action: 'read' } } },
        'db:org': { actions: { read: { rel: 'defaultSpace', action: 'read' } } },
      },
    };
    const schemaMap = mapOf({
      'db:space': { org: 'db:org' },
      'db:org': { defaultSpace: 'db:space' },
    });
    const org: Row = { id: 'o1' };
    const looped = { id: 's1', orgId: 'o1', org };
    org.defaultSpace = looped;
    const permix = createPermissions();
    await permix.setup({ resource: 'db:org', actions: { read: true } });
    const subject = { resource: 'db:space', record: looped } as const;

    expect(checkWithRules(schemaMap)(permix, schema, subject, 'read')).toBe(true);
    expect(pathsWithRules(schemaMap)(permix, schema, subject, 'read')).toEqual([[]]);
  });

  test('a loop in an any arm check never reached adds nothing', () => {
    const schema: Rules = {
      permissions: {
        'db:a': { actions: { read: { any: [true, { rel: 'b', action: 'read' }] } } },
        'db:b': { actions: { read: { rel: 'a', action: 'read' } } },
      },
    };
    const schemaMap = mapOf({ 'db:a': { b: 'db:b' }, 'db:b': { a: 'db:a' } });
    const a1: Row = { id: 'a1', bId: 'b1' };
    a1.b = { id: 'b1', aId: 'a1', a: a1 };
    const subject = { resource: 'db:a', record: a1 } as const;

    expect(checkWithRules(schemaMap)(createPermissions(), schema, subject, 'read')).toBe(true);
    expect(pathsWithRules(schemaMap)(createPermissions(), schema, subject, 'read')).toEqual([[]]);
  });

  test('empty all admits, empty any does not, in both', () => {
    const schema: Rules = {
      permissions: { 'db:space': { actions: { a: { all: [] }, b: { any: [] } } } },
    };
    const permix = createPermissions();
    expect(checkWithRules(spaceMap)(permix, schema, space, 'a')).toBe(true);
    expect(pathsWithRules(spaceMap)(permix, schema, space, 'a')).toEqual([[]]);
    expect(checkWithRules(spaceMap)(permix, schema, space, 'b')).toBe(false);
    expect(pathsWithRules(spaceMap)(permix, schema, space, 'b')).toEqual([]);
  });
});

describe('each way in is reported once', () => {
  test('an entitlement holding an action and one implying it is one admission', async () => {
    const holder = await holding([onSpace('R', { read: true, own: true }), await owning()]);
    expect(pathsWithRules(spaceMap)(holder, spaceSchema, space, 'read')).toEqual([[['R']]]);
  });

  test('a direct grant reached by the grant and the schema is one admission, within limit 1', async () => {
    const schema: Rules = {
      permissions: {
        'db:space': {
          actions: {
            own: null,
            read: {
              any: ['own', { rule: { field: 'id', operator: Operator.equals, value: 's1' } }],
            },
          },
        },
      },
    };
    const permix = createPermissions();
    await permix.setup({ resource: 'db:space', actions: { read: true, own: true } });
    expect(pathsWithRules(spaceMap, { limit: 1 })(permix, schema, space, 'read')).toEqual([[]]);
  });

  test("a record's own permissionRules admitting beside the schema is one admission", async () => {
    const schema: Rules = { permissions: { 'db:space': { actions: { read: true } } } };
    const record = { id: 's1', permissionRules: { read: true } };
    expect(
      pathsWithRules(spaceMap)(
        createPermissions(),
        schema,
        { resource: 'db:space', record },
        'read',
      ),
    ).toEqual([[]]);
  });

  test('two rows alike but for their ref are both reported; the caller orders them', async () => {
    const top = await owning();
    const holder = createPermissions();
    await holder.setup(onSpace('older', { read: true }), { owner: top });
    await holder.setup(onSpace('newer', { read: true }), { owner: top });
    await holder.setup(onSpace('owning', { own: true }), { owner: top });

    const admissions = pathsWithRules(spaceMap)(holder, spaceSchema, space, 'read');
    expect(refsOf(admissions).sort()).toEqual(['newer', 'older', 'owning']);
  });
});

describe('chains', () => {
  test('an entitlement without a ref is null in its chain, never a grant held directly', async () => {
    const top = await owning();
    const middle = await holding([onSpace(undefined, { read: true }), top]);
    const holder = await holding([onSpace('leaf', { read: true }), middle]);
    const unnamedLeaf = await holding([onSpace(undefined, { read: true }), top]);

    expect(pathsWithRules(spaceMap)(holder, spaceSchema, space, 'read')).toEqual([
      [['leaf', null]],
    ]);
    expect(pathsWithRules(spaceMap)(unnamedLeaf, spaceSchema, space, 'read')).toEqual([[[null]]]);
  });

  test('a superadmin owner backs its entitlement', async () => {
    const top = createPermissions();
    top.setSuperadmin(true);
    const holder = await holding([onSpace('R', { read: true }), top]);
    expect(pathsWithRules(spaceMap)(holder, spaceSchema, space, 'read')).toEqual([[['R']]]);
  });

  test('an all whose branches admit two ways and one way is two admissions', async () => {
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
    const projectOwner = createPermissions();
    await projectOwner.setup({ resource: 'db:project', id: 'p1', actions: { own: true } });
    const spaceOwner = await owning();
    const holder = await holding(
      [onSpace('space-a', { read: true }), spaceOwner],
      [onSpace('space-b', { read: true }), spaceOwner],
      [
        {
          resource: 'db:project',
          anchor: { resource: 'db:project', id: 'p1' },
          actions: { read: true },
          ref: 'project',
        },
        projectOwner,
      ],
    );
    const doc = { id: 'd1', spaceId: 's1', space: s1, projectId: 'p1', project: { id: 'p1' } };

    expect(
      pathsWithRules(schemaMap)(holder, schema, { resource: 'db:doc', record: doc }, 'publish'),
    ).toEqual([
      [['space-a'], ['project']],
      [['space-b'], ['project']],
    ]);
    expect(() =>
      pathsWithRules(schemaMap, { limit: 1 })(
        holder,
        schema,
        { resource: 'db:doc', record: doc },
        'publish',
      ),
    ).toThrow(PathLimitError);
  });
});

describe('owners built once', () => {
  test('a loop in the permissions data settles, and the edge back backs nothing', async () => {
    const a: Permissions = [{ entries: [] }];
    const b: Permissions = [{ entries: [onSpace('b', { read: true })], owner: a }];
    a.push({ entries: [onSpace('a', { read: true })], owner: b });

    const permix = await permixOf(a);
    expect(checkWithRules(spaceMap)(permix, spaceSchema, space, 'read')).toBe(false);
    expect(pathsWithRules(spaceMap)(permix, spaceSchema, space, 'read')).toEqual([]);
  });
});
