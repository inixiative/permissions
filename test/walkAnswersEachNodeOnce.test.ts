import { describe, expect, spyOn, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { map as chainMap, schema as chainSchema, model, pool, table } from '../bench/fixtures';
import {
  type ActionRule,
  createCanGrantEntitlement,
  createHydrator,
  createPermissions,
  createRebacCheck,
  createRebacPaths,
  type EntitlementEntry,
  PathLimitError,
  type PermissionEntry,
  type PermixLike,
  placeEntitlement,
  type RebacSchema,
  type Row,
} from '../index';
import * as evaluateModule from '../src/core/evaluate';
import { outcomesOfWalkCase, type WalkCase, walkCase } from './fixtures/walkCases';
import { mapOf } from './schemaMaps';

// One check answers each node once (src/core/evaluate.ts, `walkAction`): a node is its table, its
// row object, its resource and action, in one walk mode. An answer is kept only when no test in
// its walk found a node on the path, with every node key its walk tested; it is reused only while
// none of those keys is on the path. Every test below passes identically on the walk without the
// memo (commit "A row's own rules are judged once per row per check"), except the ones that count
// computations (1, and "3 and 5, counted").

/** A permix that counts its `check` calls by resource, action and id: one per node computed. */
const counting = (permix: PermixLike) => {
  const calls = new Map<string, number>();
  const counted: PermixLike = {
    check: (resource, action, id, data) => {
      const node = `${resource}:${action}:${id}`;
      calls.set(node, (calls.get(node) ?? 0) + 1);
      return permix.check(resource, action, id, data);
    },
    isSuperadmin: () => permix.isSuperadmin?.() ?? false,
    getActor: () => permix.getActor(),
    entitlements: (resource, action) => permix.entitlements?.(resource, action) ?? [],
  };
  const total = () => [...calls.values()].reduce((sum, n) => sum + n, 0);
  return { counted, calls, total };
};

const nobody = () =>
  table({ resource: 'elsewhere', id: 'x', actions: { own: true } } as PermissionEntry);

describe('1. a denial walks each node once', () => {
  test("on the bench chain at 0, 2, 4 and 6 hops: the starting row's 4 nodes once each, plus one computation per distinct node above it (8, 16, 24), and the answer is false", async () => {
    const check = createRebacCheck(chainMap);
    const permix = await nobody();
    const walked = [];
    for (const depth of [0, 2, 4, 6]) {
      const { counted, calls, total } = counting(permix);
      const record = pool(depth)[0] as Row;
      expect(check(counted, chainSchema, { resource: model(depth), record }, 'read')).toBe(false);
      expect([...calls.values()].every((n) => n === 1)).toBe(true);
      walked.push([total(), calls.size]);
    }
    expect(walked).toEqual([
      [4, 4],
      [12, 12],
      [20, 20],
      [28, 28],
    ]);
  });
});

describe('only a node reached after a hop is remembered', () => {
  test('a check that never leaves its starting row does no memo work; one that hops does', async () => {
    const started = spyOn(evaluateModule, 'startOneCheck');
    try {
      const check = createRebacCheck(chainMap);
      const permix = await nobody();
      expect(
        check(permix, chainSchema, { resource: model(0), record: pool(0)[0] as Row }, 'read'),
      ).toBe(false);
      const atStart = started.mock.results[0]?.value as evaluateModule.WhatOneCheckRemembers;
      expect([atStart.answers, atStart.footprintOfThisNode, atStart.footprintChecks]).toEqual([
        undefined,
        null,
        0,
      ]);
      expect(
        check(permix, chainSchema, { resource: model(2), record: pool(2)[0] as Row }, 'read'),
      ).toBe(false);
      const hopped = started.mock.results[1]?.value as evaluateModule.WhatOneCheckRemembers;
      expect(hopped.answers).toBeInstanceOf(WeakMap);
    } finally {
      started.mockRestore();
    }
  });
});

describe('2. a node reached while an ancestor of it is on the path is not kept', () => {
  const map = mapOf(
    { 'db:space': { organization: 'db:organization' }, 'db:organization': { space: 'db:space' } },
    { 'db:space': ['flag'], 'db:organization': ['flag'] },
  );
  const flagged = (value: string) => ({
    rule: { field: 'flag', operator: Operator.equals, value },
  });
  const loopRecord = () => {
    const space: Row = { id: 's1', flag: 'y', organizationId: 'o1' };
    const organization: Row = { id: 'o1', flag: 'x', spaceId: 's1', space };
    space.organization = organization;
    return space;
  };
  const orders = <X>(pair: [X, X]): [X, X][] => [pair, [pair[1], pair[0]]];

  test('through a relation hop: the organization denied inside the loop admits outside it, in every order', async () => {
    const answers = [];
    for (const spaceRead of orders<ActionRule>([
      { rel: 'organization', action: 'read' },
      flagged('y'),
    ]))
      for (const organizationRead of orders<ActionRule>([
        { rel: 'space', action: 'read' },
        flagged('y'),
      ]))
        for (const q of orders<ActionRule>(['read', { rel: 'organization', action: 'read' }])) {
          const schema: RebacSchema = {
            permissions: {
              'db:space': { actions: { read: { any: spaceRead }, q: { all: q } } },
              'db:organization': { actions: { read: { any: organizationRead } } },
            },
          };
          answers.push(
            createRebacCheck(map)(
              createPermissions(),
              schema,
              { resource: 'db:space', record: loopRecord() },
              'q',
            ),
          );
        }
    expect(answers).toEqual(Array(8).fill(true));
  });

  test('with no hop: a rule naming itself throws, in every order', () => {
    for (const read of orders<ActionRule>([false, 'manage']))
      for (const manage of orders<ActionRule>(['read', false])) {
        const schema: RebacSchema = {
          permissions: {
            'db:space': { actions: { read: { any: read }, manage: { any: manage } } },
          },
        };
        expect(() =>
          createRebacCheck(map)(
            createPermissions(),
            schema,
            { resource: 'db:space', record: loopRecord() },
            'read',
          ),
        ).toThrow('Cycle detected in permission graph');
      }
  });
});

// Two entitlements on o1 back a space's read; the organization's read is reached twice (directly,
// and through `view`).
const twoHeld = async () => {
  const owner = createPermissions();
  await owner.setup([
    { resource: 'db:organization', id: 'o1', actions: { own: true } } as PermissionEntry,
  ]);
  const ownerCounted = counting(owner);
  const holder = createPermissions();
  const onO1 = (ref: string): EntitlementEntry => ({
    resource: 'db:organization',
    anchor: { resource: 'db:organization', id: 'o1' },
    actions: { read: true },
    ref,
  });
  await holder.setup([onO1('e1'), onO1('e2')], { owner: ownerCounted.counted });
  return { holder: counting(holder), owner: ownerCounted };
};
const diamondMap = mapOf({ 'db:space': { organization: 'db:organization' } });
const diamond: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, read: 'own', view: 'read' } },
    'db:space': {
      actions: {
        read: {
          any: [
            { rel: 'organization', action: 'read' },
            { rel: 'organization', action: 'view' },
          ],
        },
      },
    },
  },
};
const s1 = { id: 's1', organizationId: 'o1', organization: { id: 'o1' } };
const paths = (admissions: readonly (readonly (readonly (string | null)[])[])[]) =>
  admissions.map((admission) => admission.map((chain) => chain.join('>')));

describe('3. createRebacPaths with a reused answer', () => {
  test('a node reached twice still gives every path, and the limit throws where it did', async () => {
    const { holder } = await twoHeld();
    const subject = { resource: 'db:space', record: s1 };
    expect(
      paths(createRebacPaths(diamondMap, { limit: 2 })(holder.counted, diamond, subject, 'read')),
    ).toEqual([['e1'], ['e2']]);
    expect(() =>
      createRebacPaths(diamondMap, { limit: 1 })(holder.counted, diamond, subject, 'read'),
    ).toThrow(PathLimitError);
  });
});

describe('3 and 5, counted: the memo computes a reused node once', () => {
  test('the holder walks o1 once though two arms reach it, and the owner walks it once for both entitlements', async () => {
    const { holder, owner } = await twoHeld();
    createRebacPaths(diamondMap)(
      holder.counted,
      diamond,
      { resource: 'db:space', record: s1 },
      'read',
    );
    expect(holder.calls.get('db:organization:read:o1')).toBe(1);
    expect(owner.calls.get('db:organization:read:o1')).toBe(1);
  });
});

describe("4. the grant check's two passes and a plain check share no answers", () => {
  test('the first pass denies at a row the liveness walk admits, and the grant holds', async () => {
    const owner = createPermissions();
    await owner.setup([
      { resource: 'db:organization', id: 'o1', actions: { own: true } } as PermissionEntry,
    ]);
    const writer = createPermissions();
    const named: EntitlementEntry = {
      resource: 'db:space',
      anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
      where: { field: 'name', operator: Operator.equals, value: 'a' },
      actions: { read: true },
    };
    await writer.setup([named], { owner });
    const map = mapOf(
      { 'db:space': { organization: 'db:organization' } },
      { 'db:space': ['name'] },
    );
    const schema: RebacSchema = {
      permissions: {
        'db:organization': { actions: { own: null, read: 'own' } },
        'db:space': { actions: { read: { rel: 'organization', action: 'read' } } },
      },
    };
    const anchor = { id: 'o1' };
    const [placed] = placeEntitlement(map, named, anchor) ?? [];
    expect(createCanGrantEntitlement(map)(writer, schema, named, placed as Row)).toBe(true);
    const check = createRebacCheck(map);
    const space = (name: string) => ({
      id: 's1',
      name,
      organizationId: 'o1',
      organization: anchor,
    });
    expect(check(writer, schema, { resource: 'db:space', record: space('a') }, 'read')).toBe(true);
    expect(check(writer, schema, { resource: 'db:space', record: space('b') }, 'read')).toBe(false);
  });
});

describe("5. an entitlement owner's walk reuses the owner's answers, never the holder's", () => {
  test("the holder's own read on o1 denies and the owner's admits: each entitlement admits through the owner", async () => {
    const { holder } = await twoHeld();
    const subject = { resource: 'db:space', record: s1 };
    expect(paths(createRebacPaths(diamondMap)(holder.counted, diamond, subject, 'read'))).toEqual([
      ['e1'],
      ['e2'],
    ]);
    expect(createRebacCheck(diamondMap)(createPermissions(), diamond, subject, 'read')).toBe(false);
  });
});

describe('6. walk modes', () => {
  test('one row met outside a list and under its item is answered in each mode', async () => {
    const underAndOutside: WalkCase = {
      resources: [
        {
          rels: [{ name: 'primarySpace', target: 1 }],
          lists: [{ name: 'spaces', item: 1, inverse: 'organization', down: [] }],
        },
        { rels: [{ name: 'organization', target: 0 }], lists: [] },
      ],
      schema: {
        0: {
          q: {
            all: [
              { rel: 'primarySpace', action: 'flagIsNull' },
              { rel: 'spaces', arrayOperator: 'any', condition: 'flagIsNull' },
            ],
          },
        },
        1: { flagIsNull: { rule: { field: 'flag', operator: Operator.equals, value: null } } },
      },
      objects: [
        { res: 0, id: 'o1', links: { primarySpace: 1 }, lists: { spaces: [1] } },
        { res: 1, id: 's1', links: {}, lists: {} },
      ],
      tables: [{ grants: [], ents: [], actor: null }],
      query: { object: 0, action: 'q' },
      grant: { ent: { resource: 0, path: [], anchorId: 'o1', actions: ['q'] }, placed: 0 },
    };
    const { check, checkUnknown } = await outcomesOfWalkCase(underAndOutside);
    expect({ check, checkUnknown }).toEqual({ check: false, checkUnknown: false });
  });

  test('under a list item, one row at two lens positions is computed at each', async () => {
    const twoPositions: WalkCase = {
      resources: [
        {
          rels: [],
          lists: [
            { name: 'members', item: 1, inverse: 'organization', down: ['user', 'brand.user'] },
          ],
        },
        {
          rels: [
            { name: 'organization', target: 0 },
            { name: 'user', target: 2 },
            { name: 'brand', target: 3 },
          ],
          lists: [],
        },
        { rels: [], lists: [] },
        { rels: [{ name: 'user', target: 2 }], lists: [] },
      ],
      schema: {
        0: { read: { rel: 'members', arrayOperator: 'any', condition: 'read' } },
        1: {
          read: {
            any: [
              { rel: 'user', action: 'read' },
              { rel: 'brand.user', action: 'read' },
            ],
          },
        },
        2: { read: null },
      },
      objects: [
        { res: 0, id: 'o1', links: {}, lists: { members: [1] } },
        { res: 1, id: 'm1', links: { user: 2, brand: 3 }, lists: {} },
        { res: 2, id: 'u1', links: {}, lists: {} },
        { res: 3, id: 'b1', links: { user: 2 }, lists: {} },
      ],
      tables: [{ grants: [], ents: [], actor: null }],
      query: { object: 0, action: 'read' },
      grant: { ent: { resource: 0, path: [], anchorId: 'o1', actions: ['read'] }, placed: 0 },
    };
    expect((await outcomesOfWalkCase(twoPositions)).check).toBe(false);
  });
});

describe('two objects of one row (found against the first reading of the memo)', () => {
  test('a plain check reads each copy as loaded (an include tree loads the organization twice)', async () => {
    const map = mapOf(
      {
        'db:space': { organization: 'db:organization', project: 'db:project' },
        'db:project': { organization: 'db:organization' },
      },
      { 'db:organization': ['public'] },
    );
    const schema: RebacSchema = {
      permissions: {
        'db:organization': {
          actions: { read: { rule: { field: 'public', operator: Operator.equals, value: true } } },
        },
        'db:project': { actions: { read: { rel: 'organization', action: 'read' } } },
        'db:space': {
          actions: {
            read: {
              any: [
                { rel: 'project', action: 'read' },
                { rel: 'organization', action: 'read' },
              ],
            },
          },
        },
      },
    };
    const space = {
      id: 's1',
      organizationId: 'o1',
      organization: { id: 'o1', public: true },
      projectId: 'p1',
      project: { id: 'p1', organizationId: 'o1', organization: { id: 'o1' } },
    };
    expect(
      createRebacCheck(map)(
        createPermissions(),
        schema,
        { resource: 'db:space', record: space },
        'read',
      ),
    ).toBe(true);
  });

  // The hydrator never reuses the caller's starting record at a repeat, and `rowsAbove` leaves out
  // only the starting object: the repeat of the granted row is in `above`.
  const loopMap = mapOf({
    'db:organization': { primarySpace: 'db:space' },
    'db:space': { organization: 'db:organization' },
  });
  const stored: Record<string, Row> = {
    'db:organization': { id: 'o1', primarySpaceId: 's1' },
    'db:space': { id: 's1', organizationId: 'o1' },
  };
  const hydratedO1 = () =>
    createHydrator({ map: loopMap, load: async (resource: string) => stored[resource] ?? null })(
      'db:organization',
      { id: 'o1', primarySpaceId: 's1' },
    );
  const self = { resource: 'db:organization', id: 'o1' };
  const writerHolding = async (action: string) => {
    const owner = createPermissions();
    await owner.setup([
      { resource: 'db:organization', id: 'o1', actions: { own: true } } as PermissionEntry,
    ]);
    const writer = createPermissions();
    const held: EntitlementEntry = {
      resource: 'db:organization',
      anchor: self,
      actions: { [action]: true },
      grantsBelow: true,
    };
    await writer.setup([held], { owner });
    return writer;
  };
  const readOnO1: EntitlementEntry = {
    resource: 'db:organization',
    anchor: self,
    actions: { read: true },
  };

  test("the grant check's first pass never counts a grantsBelow entitlement at the granted row, even at its hydrated repeat", async () => {
    const schema: RebacSchema = {
      permissions: {
        'db:organization': {
          actions: {
            own: null,
            view: 'own',
            read: { all: [{ rel: 'primarySpace', action: 'viaOrganization' }, 'view'] },
          },
        },
        'db:space': { actions: { viaOrganization: { rel: 'organization', action: 'view' } } },
      },
    };
    const anchor = await hydratedO1();
    expect(placeEntitlement(loopMap, readOnO1, anchor)).toEqual([anchor]);
    expect(
      createCanGrantEntitlement(loopMap)(await writerHolding('view'), schema, readOnO1, anchor),
    ).toBe(false);
  });

  test("the first pass's repeat of the granted row, met again while the granted row is on the path, still denies", async () => {
    const schema: RebacSchema = {
      permissions: {
        'db:organization': {
          actions: {
            own: null,
            y: 'own',
            x: { any: ['y', { rel: 'primarySpace', action: 'n' }] },
            read: { all: [{ rel: 'primarySpace', action: 'n' }, 'x'] },
          },
        },
        'db:space': { actions: { n: { rel: 'organization', action: 'x' } } },
      },
    };
    expect(
      createCanGrantEntitlement(loopMap)(
        await writerHolding('y'),
        schema,
        readOnO1,
        await hydratedO1(),
      ),
    ).toBe(false);
  });
});

const FOOTPRINT_CASE = { check: false, checkUnknown: false, paths: [], grant: false };

// Cases found by fuzzing this build against the walk without the memo (test/fixtures/walkCases):
// rows, schemas and tables in the fuzzer's form, each with what every check answers.
describe('cases found against the memo', () => {
  const expected: Record<string, Awaited<ReturnType<typeof outcomesOfWalkCase>>> = {
    'two-copies-loaded-differently': { check: true, checkUnknown: true, paths: [''], grant: true },
    'first-pass-hydrated-repeat': { check: true, checkUnknown: true, paths: ['e'], grant: false },
    'repeat-met-while-start-on-path': {
      check: true,
      checkUnknown: true,
      paths: ['e'],
      grant: false,
    },
    'plain-repeat-met-while-start-on-path': {
      check: false,
      checkUnknown: false,
      paths: [],
      grant: false,
    },
    'under-mode-path-through-loop': {
      check: true,
      checkUnknown: true,
      paths: ['Er'],
      grant: false,
    },
    'footprint-on-path-two-levels-down': FOOTPRINT_CASE,
    'reused-child-in-parent-footprint': FOOTPRINT_CASE,
    'finished-sibling-in-visited': {
      check: true,
      checkUnknown: true,
      paths: ['t0e1>t1e0', 't0e1>t1e0>t2e2>t0e1>t1e0'],
      grant: false,
    },
  };
  const named: Record<string, string> = {
    'two-copies-loaded-differently':
      'two objects of one row with different flags: each is judged on its own object',
    'first-pass-hydrated-repeat':
      "the grant check's first pass meets the hydrated repeat of the granted row in `above`: it never counts as the granted row",
    'repeat-met-while-start-on-path':
      'that repeat answered once, then met again while the granted row is on the path: the grant check denies, as recomputing does',
    'plain-repeat-met-while-start-on-path':
      'the same in a plain check: the repeat met while the start row is on the path denies',
    'under-mode-path-through-loop':
      'a node whose walk reaches an ancestor only under a list item is answered again outside it',
    'footprint-on-path-two-levels-down':
      "o1 → s1 → o1's repeat → s1's repeat: an answer kept for s1 whose footprint meets the start two levels down is not reused while the start is on the path; read denies",
    'reused-child-in-parent-footprint':
      "the same loop, with s1's two actions reaching the repeat: an answer reused inside another stays in that one's footprint; read denies",
    'finished-sibling-in-visited':
      'a node a finished sibling walked is not on the path: paths reports the longer chain through it',
  };
  for (const [name, title] of Object.entries(named))
    test(title, async () => {
      expect(await outcomesOfWalkCase(await walkCase(name))).toEqual(expected[name] as never);
    });
});
