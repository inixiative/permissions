import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { map as chainMap, schema as chainSchema, model, nobody, pool } from '../bench/fixtures';
import {
  type ActionRule,
  createHydrator,
  createPermissions,
  type EntitlementEntry,
  PathLimitError,
  type PermissionEntry,
  type PermixLike,
  pseudoRecordsOfEntitlement,
  type Row,
} from '../index';
import { outcomesOfWalkCase, type WalkCase, walkCase } from './fixtures/walkCases';
import { canGrantWithRules, checkWithRules, mapOf, pathsWithRules, type Rules } from './schemaMaps';

// One check answers each node reached after a hop once (src/core/evaluate.ts, `walkAction`): a
// node is its table, its row object, its resource and action, in one walk mode. An answer is kept
// only when no test in its walk found a node on the path, and reused only while no answer in its
// footprint is on the path. Tests that count `check` calls count node computations.

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
    entitlements: (resource, action) => permix.entitlements?.(resource, action) ?? [],
  };
  const total = () => [...calls.values()].reduce((sum, n) => sum + n, 0);
  return { counted, calls, total };
};

describe('a denial walks each node once', () => {
  test("on the bench chain at 0, 2, 4 and 6 hops: the starting row's 4 nodes once each, plus one computation per distinct node above it (8, 16, 24), and the answer is false", async () => {
    const check = checkWithRules(chainMap);
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
  // `own` is reached twice from `read`: through `view` and through `edit`.
  const diamondOnOneRow: Rules = {
    permissions: {
      'db:organization': {
        actions: { own: null, view: 'own', edit: 'own', read: { any: ['view', 'edit'] } },
      },
      'db:space': { actions: { read: { rel: 'organization', action: 'read' } } },
    },
  };
  const oneRowMap = mapOf({ 'db:space': { organization: 'db:organization' } });
  const o1 = { id: 'o1' };
  const ownCalls = async (resource: string, record: Row) => {
    const { counted, calls } = counting(await nobody());
    checkWithRules(oneRowMap)(counted, diamondOnOneRow, { resource, record }, 'read');
    return calls.get('db:organization:own:o1');
  };

  test('on the starting row a node met twice is walked twice; one hop away, once', async () => {
    expect(await ownCalls('db:organization', o1)).toBe(2);
    expect(await ownCalls('db:space', { id: 's1', organizationId: 'o1', organization: o1 })).toBe(
      1,
    );
  });
});

describe('a node reached while an ancestor of it is on the path is not kept', () => {
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
          const schema: Rules = {
            permissions: {
              'db:space': { actions: { read: { any: spaceRead }, q: { all: q } } },
              'db:organization': { actions: { read: { any: organizationRead } } },
            },
          };
          answers.push(
            checkWithRules(map)(
              createPermissions(),
              schema,
              { resource: 'db:space', record: loopRecord() },
              'q',
            ),
          );
        }
    expect(answers).toEqual(Array(8).fill(true));
  });

  test('with no hop, a rule naming itself throws, in every order', () => {
    for (const read of orders<ActionRule>([false, 'manage']))
      for (const manage of orders<ActionRule>(['read', false])) {
        const schema: Rules = {
          permissions: {
            'db:space': { actions: { read: { any: read }, manage: { any: manage } } },
          },
        };
        expect(() =>
          checkWithRules(map)(
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
const diamond: Rules = {
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

describe('createRebacPaths with a reused answer', () => {
  test('a node two arms reach is walked once and gives every path; a limit of one throws', async () => {
    const { holder } = await twoHeld();
    const subject = { resource: 'db:space', record: s1 };
    expect(
      paths(pathsWithRules(diamondMap, { limit: 2 })(holder.counted, diamond, subject, 'read')),
    ).toEqual([['e1'], ['e2']]);
    expect(holder.calls.get('db:organization:read:o1')).toBe(1);
    expect(() =>
      pathsWithRules(diamondMap, { limit: 1 })(holder.counted, diamond, subject, 'read'),
    ).toThrow(PathLimitError);
  });
});

describe("an entitlement owner's walk reuses the owner's answers, never the holder's", () => {
  test("the owner walks o1 once for both entitlements; the holder's own read on o1 denies", async () => {
    const { holder, owner } = await twoHeld();
    const subject = { resource: 'db:space', record: s1 };
    expect(paths(pathsWithRules(diamondMap)(holder.counted, diamond, subject, 'read'))).toEqual([
      ['e1'],
      ['e2'],
    ]);
    expect(owner.calls.get('db:organization:read:o1')).toBe(1);
    expect(checkWithRules(diamondMap)(createPermissions(), diamond, subject, 'read')).toBe(false);
  });
});

describe("the grant check's two passes share no answers", () => {
  // The writer holds read on o1 from O (grantsBelow) and read on o1's spaces from O; O holds read on
  // o1 from the root, under a `where`. The first pass walks O's read on o1 one hop up and counts no
  // `where`: it denies. The liveness pass walks the same node of O, counting every `where`: it admits.
  test('the first pass denies at o1 where the liveness pass admits, and the grant holds', async () => {
    const map = mapOf(
      { 'db:space': { organization: 'db:organization' } },
      { 'db:organization': ['name'] },
    );
    const schema: Rules = {
      permissions: {
        'db:organization': { actions: { own: null, read: 'own' } },
        'db:space': { actions: { read: { rel: 'organization', action: 'read' } } },
      },
    };
    const atO1 = { resource: 'db:organization', id: 'o1' };
    const root = createPermissions();
    await root.setup([
      { resource: 'db:organization', id: 'o1', actions: { own: true } } as PermissionEntry,
    ]);
    const owner = createPermissions();
    await owner.setup(
      [
        {
          resource: 'db:organization',
          anchor: atO1,
          where: { field: 'name', operator: Operator.equals, value: 'acme' },
          actions: { read: true },
        },
      ],
      { owner: root },
    );
    const spacesOfO1: EntitlementEntry = {
      resource: 'db:space',
      anchor: { ...atO1, path: 'organization' },
      actions: { read: true },
    };
    const writer = createPermissions();
    await writer.setup(
      [
        { resource: 'db:organization', anchor: atO1, actions: { read: true }, grantsBelow: true },
        spacesOfO1,
      ],
      { owner },
    );
    const [placed] = pseudoRecordsOfEntitlement(map, spacesOfO1, { id: 'o1', name: 'acme' }) ?? [];
    expect(canGrantWithRules(map)(writer, schema, spacesOfO1, placed as Row)).toBe(true);
  });
});

describe('walk modes', () => {
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
        1: { flagIsNull: { rule: { field: 'flag', operator: Operator.equals, value: 'on' } } },
      },
      objects: [
        { res: 0, id: 'o1', links: { primarySpace: 1 }, lists: { spaces: [1] } },
        { res: 1, id: 's1', links: {}, lists: {} },
      ],
      tables: [{ grants: [], ents: [], actor: null }],
      query: { object: 0, action: 'q' },
      grant: { ent: { resource: 0, path: [], anchorId: 'o1', actions: ['q'] }, placed: 0 },
    };
    const { check } = await outcomesOfWalkCase(underAndOutside);
    expect(check).toBe(false);
  });

  test('under a list item, one row reached at two lens positions is walked at each', async () => {
    const map = mapOf(
      {
        'db:member': { organization: 'db:organization', user: 'db:user', brand: 'db:brand' },
        'db:brand': { user: 'db:user' },
      },
      {},
      { 'db:organization': { members: { item: 'db:member', down: ['user', 'brand.user'] } } },
    );
    const schema: Rules = {
      permissions: {
        'db:organization': {
          actions: { read: { rel: 'members', arrayOperator: 'any', condition: 'read' } },
        },
        'db:member': {
          actions: {
            read: {
              any: [
                { rel: 'user', action: 'read' },
                { rel: 'brand.user', action: 'read' },
              ],
            },
          },
        },
        'db:brand': { actions: {} },
        'db:user': { actions: { read: null } },
      },
    };
    const user = { id: 'u1' };
    const member = {
      id: 'm1',
      organizationId: 'o1',
      userId: 'u1',
      user,
      brandId: 'b1',
      brand: { id: 'b1', userId: 'u1', user },
    };
    const { counted, calls } = counting(await nobody());
    expect(
      checkWithRules(map)(
        counted,
        schema,
        { resource: 'db:organization', record: { id: 'o1', members: [member] } },
        'read',
      ),
    ).toBe(false);
    expect(calls.get('db:user:read:u1')).toBe(2);
  });
});

describe('two objects of one row', () => {
  test('a plain check reads each copy as loaded (an include tree loads the organization twice)', async () => {
    const map = mapOf(
      {
        'db:space': { organization: 'db:organization', project: 'db:project' },
        'db:project': { organization: 'db:organization' },
      },
      { 'db:organization': ['public'] },
    );
    const schema: Rules = {
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
      checkWithRules(map)(
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
    const schema: Rules = {
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
    expect(pseudoRecordsOfEntitlement(loopMap, readOnO1, anchor)).toEqual([anchor]);
    expect(canGrantWithRules(loopMap)(await writerHolding('view'), schema, readOnO1, anchor)).toBe(
      false,
    );
  });

  test("the first pass's repeat of the granted row, met again while the granted row is on the path, denies", async () => {
    const schema: Rules = {
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
      canGrantWithRules(loopMap)(await writerHolding('y'), schema, readOnO1, await hydratedO1()),
    ).toBe(false);
  });
});

const FOOTPRINT_CASE = { check: false, paths: [], grant: false };

// Cases in the fuzzer's form (test/fixtures/walkCases), each with what every check answers.
describe('fuzzed walk cases', () => {
  const expected: Record<string, Awaited<ReturnType<typeof outcomesOfWalkCase>>> = {
    'plain-repeat-met-while-start-on-path': {
      check: false,
      paths: [],
      grant: false,
    },
    'under-mode-path-through-loop': {
      check: true,
      paths: ['accountRead'],
      grant: false,
    },
    'footprint-on-path-two-levels-down': FOOTPRINT_CASE,
    'reused-child-in-parent-footprint': FOOTPRINT_CASE,
    'finished-sibling-in-visited': {
      check: true,
      paths: ['holder1>owner0', 'holder1>owner0>third2>holder1>owner0'],
      grant: false,
    },
  };
  const named: Record<string, string> = {
    'plain-repeat-met-while-start-on-path':
      "a plain check meets the starting row's hydrated repeat while the start is on the path: it denies",
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
