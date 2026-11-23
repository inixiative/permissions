import { describe, expect, test } from 'bun:test';
import { type FieldMap, fieldOf, modelOf } from '@inixiative/field-map';
import { type Condition, Operator } from '@inixiative/json-rules';
import {
  coversEntitlement,
  delegate,
  delegatedWhere,
  type EntitlementEntry,
  entitlementProblem,
  type Permissions,
  type Permix,
  type PermixLike,
  permixOf,
  placeEntitlement,
  type Row,
  type SchemaMapWithoutPermissions,
  wellFormedEntitlements,
  withoutRedundantEntitlements,
} from '../index';
import {
  actorData,
  canGrantWithRules,
  checkWithRules,
  mapOf,
  pathsWithRules,
  type Rules,
  stringColumn,
} from './schemaMaps';

// The grant check's first pass also counts an entitlement the writer holds when it is marked
// `grantsBelow`, has no `where`, and the walk meets it on a hydrated row above the granted record
// (never the granted record itself, never a placed one). It then counts as a role on that row
// would. Aron, 2026-11-14: "unconditional, unlensed… your specific delegation is just one step on
// the chain"; "we shouldn't pass lensed grants".

const eq = (field: string, value: unknown): Condition =>
  ({ field, operator: Operator.equals, value }) as Condition;
const isIn = (field: string, value: unknown[]): Condition =>
  ({ field, operator: Operator.in, value }) as Condition;
const acts = (names: string[]) => Object.fromEntries(names.map((name) => [name, true]));
const grant = (resource: string, id: string, actions: string[]) => ({
  resource,
  id,
  actions: acts(actions),
});
const entry = (
  resource: string,
  anchor: EntitlementEntry['anchor'],
  actions: string[],
  where?: Condition,
  ref?: string,
): EntitlementEntry => ({
  resource,
  anchor,
  actions: acts(actions),
  ...(where === undefined ? {} : { where }),
  ...(ref === undefined ? {} : { ref }),
});
// the app's mark on a row nothing narrows: it may grant below it
const below = (held: EntitlementEntry): EntitlementEntry => ({ ...held, grantsBelow: true });

// ───────────────────────── the member case, template's shape ─────────────────────────

describe('the member case: operate on M, anchored at M, no where, backed by the user', () => {
  const ownedBy = (model: string) => ({ rule: eq('ownerModel', model) });
  const onOwner = (model: string, rel: string, action: string) => ({
    all: [ownedBy(model), { rel, action }],
  });
  const standard = { own: null, manage: 'own', operate: 'manage', read: 'operate' };
  const schema: Rules = {
    permissions: {
      'db:user': { actions: standard },
      'db:organization': { actions: standard },
      'db:organizationUser': {
        actions: {
          own: { rel: 'organization', action: 'own' },
          manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
          operate: { rel: 'user', action: 'manage' },
          read: {
            any: [
              'operate',
              'manage',
              { rel: 'user', action: 'read' },
              { rel: 'organization', action: 'read' },
            ],
          },
        },
      },
      'db:integration': {
        actions: {
          manage: {
            any: [
              onOwner('User', 'user', 'manage'),
              onOwner('Organization', 'organization', 'manage'),
              onOwner('OrganizationUser', 'organizationUser', 'operate'),
            ],
          },
          operate: { any: ['manage', onOwner('Organization', 'organization', 'operate')] },
          read: { any: ['operate', onOwner('OrganizationUser', 'organizationUser', 'own')] },
        },
      },
      'db:integrationResource': {
        actions: {
          manage: { rel: 'integration', action: 'manage' },
          operate: { any: ['manage', { rel: 'integration', action: 'operate' }] },
          read: { any: ['operate', { rel: 'integration', action: 'read' }] },
        },
      },
      'db:kcpThread': {
        actions: {
          '*': {
            all: [
              { rel: 'integrationResource', action: 'operate' },
              { rule: eq('integrationResource.enabled', true) },
            ],
          },
          'thread.read': '*',
        },
      },
    },
  };
  const map = mapOf(
    {
      'db:organizationUser': { user: 'db:user', organization: 'db:organization' },
      'db:integration': {
        user: 'db:user',
        organization: 'db:organization',
        organizationUser: 'db:organizationUser',
      },
      'db:integrationResource': { integration: 'db:integration' },
      'db:kcpThread': { integrationResource: 'db:integrationResource' },
    },
    {
      'db:organizationUser': ['role'],
      'db:integration': ['ownerModel'],
      'db:integrationResource': ['enabled'],
    },
  );
  const rebac = checkWithRules(map);
  const canGrant = canGrantWithRules(map);

  const u1 = { id: 'u1' };
  const o1 = { id: 'o1' };
  const m1 = {
    id: 'm1',
    role: 'member',
    userId: 'u1',
    user: u1,
    organizationId: 'o1',
    organization: o1,
  };
  const i1 = {
    id: 'i1',
    ownerModel: 'OrganizationUser',
    organizationUserId: 'm1',
    organizationUser: m1,
    organizationId: 'o1',
    organization: o1,
    userId: 'u1',
    user: u1,
  };
  const r1 = { id: 'r1', enabled: true, integrationId: 'i1', integration: i1 };
  const thread = { id: 't1', integrationResourceId: 'r1', integrationResource: r1 };

  const surface = entry(
    'db:kcpThread',
    { resource: 'db:integrationResource', id: 'r1', path: 'integrationResource' },
    ['*'],
  );
  const manageI1 = entry('db:integration', { resource: 'db:integration', id: 'i1' }, ['manage']);
  // the self-grant rewritten for the rule
  const operateM1 = below(
    entry('db:organizationUser', { resource: 'db:organizationUser', id: 'm1' }, ['operate']),
  );
  // today's self-grant: anchored at the user, pinned to the member row by a `where`
  const selfGrantToday = entry(
    'db:organizationUser',
    { resource: 'db:user', id: 'u1', path: 'user' },
    ['operate'],
    eq('id', 'm1'),
  );

  const userOwn: Permissions = [{ entries: [grant('db:user', 'u1', ['own'])] }];
  const memberRole = grant('db:organization', 'o1', ['operate']);
  // M's permissions: its role at O1 and the self-grant. The user is not in the table.
  const memberP: Permissions = [
    { entries: [memberRole] },
    { entries: [operateM1], owner: userOwn },
  ];
  const memberToday: Permissions = [
    { entries: [memberRole] },
    { entries: [selfGrantToday], owner: userOwn },
  ];

  const grants = (permix: Permix, granted: EntitlementEntry, anchor: Row) => {
    const placed = placeEntitlement(map, granted, anchor);
    return placed?.every((record) => canGrant(permix, schema, granted, record)) === true;
  };
  const uses = (permix: Permix) =>
    rebac(permix, schema, { resource: 'db:kcpThread', record: thread }, '*');
  const outcome = async (permissions: Permissions) => {
    const permix = await permixOf(permissions);
    return {
      operatesM1: rebac(permix, schema, { resource: 'db:organizationUser', record: m1 }, 'operate'),
      uses: uses(permix),
      grantsSurface: grants(permix, surface, r1),
      grantsManageI1: grants(permix, manageI1, i1),
    };
  };
  const all = { operatesM1: true, uses: true, grantsSurface: true, grantsManageI1: true };
  const none = { operatesM1: false, uses: false, grantsSurface: false, grantsManageI1: false };

  test("M's own permissions grant a surface row over M's integration", async () => {
    expect(await outcome(memberP)).toEqual(all);
  });

  test("today's self-grant (anchored at the user, where id = M) still cannot grant: the rewrite is required", async () => {
    expect(await outcome(memberToday)).toEqual({
      operatesM1: true,
      uses: true,
      grantsSurface: false,
      grantsManageI1: false,
    });
  });

  test('a full delegate of M grants, and a full delegate of that one', async () => {
    const full = delegate(schema, memberP, { full: true });
    expect(await outcome(full)).toEqual(all);
    expect(await outcome(delegate(schema, full, { full: true }))).toEqual(all);
  });

  test.each([
    'read',
    'operate',
    'manage',
    'own',
  ])('a delegate of M capped at %s neither uses nor grants: a ceiling drops the self-grant', async (ceiling) => {
    expect(await outcome(delegate(schema, memberP, { ceiling }))).toEqual(none);
  });

  // The row is `operate` on M outright, backed by M's own permissions, so this delegate already
  // uses everything of M's and hands on what it can do: a role token plus that one marked row is
  // the member for granting. It is R103's input.
  test.each([
    'read',
    'operate',
    'manage',
    'own',
  ])('a delegate capped at %s and given operate on M by entitlement uses and grants', async (ceiling) => {
    const given = delegate(schema, memberP, { ceiling, entitlements: [operateM1] });
    expect(await outcome(given)).toEqual(all);
  });

  const usesOnly = { ...all, grantsSurface: false, grantsManageI1: false };
  const unmarkedM1 = entry('db:organizationUser', operateM1.anchor, ['operate']);

  test('the same delegate given operate on M with a where does not grant', async () => {
    const given = delegate(schema, memberP, {
      ceiling: 'read',
      entitlements: [{ ...unmarkedM1, where: eq('role', 'member') }],
    });
    expect(await outcome(given)).toEqual(usesOnly);
  });

  test('the same delegate given operate on M without the mark does not grant', async () => {
    const given = delegate(schema, memberP, { ceiling: 'read', entitlements: [unmarkedM1] });
    expect(await outcome(given)).toEqual(usesOnly);
  });

  test("M's own row without the mark uses and does not grant: an app that forgets the mark fails closed", async () => {
    const forgot: Permissions = [
      { entries: [memberRole] },
      { entries: [unmarkedM1], owner: userOwn },
    ];
    expect(await outcome(forgot)).toEqual(usesOnly);
  });

  test("an admin and an owner of O1 do not grant over M's integration", async () => {
    expect(await outcome([{ entries: [grant('db:organization', 'o1', ['manage'])] }])).toEqual(
      none,
    );
    expect(await outcome([{ entries: [grant('db:organization', 'o1', ['own'])] }])).toEqual(none);
  });

  test('the user gone from the backing: nothing is used or granted', async () => {
    const dead: Permissions = [{ entries: [memberRole] }, { entries: [operateM1], owner: [] }];
    expect(await outcome(dead)).toEqual(none);
  });

  // The "above" marker is the anchor row's own object and what it holds. A `where` never puts a
  // row on the placed record: only scalar values on fields that are not relations are pinned.
  test('a where cannot pin a look-alike of M onto the placed record', async () => {
    const forged = entry(
      'db:integration',
      { resource: 'db:organization', id: 'o1', path: 'organization' },
      ['manage'],
      { all: [eq('ownerModel', 'OrganizationUser'), eq('organizationUser', { id: 'm1' })] },
    );
    const placed = placeEntitlement(map, forged, o1);
    expect(placed?.[0]).not.toHaveProperty('organizationUser');
    expect(grants(await permixOf(memberP), forged, o1)).toBe(false);
    // the same pin under M itself, where the user is a row above
    const underM1 = entry(
      'db:integration',
      { resource: 'db:organizationUser', id: 'm1', path: 'organizationUser' },
      ['manage'],
      { all: [eq('ownerModel', 'User'), eq('user', { id: 'u1' })] },
    );
    const manageU1 = below(entry('db:user', { resource: 'db:user', id: 'u1' }, ['manage']));
    const userManager = await permixOf([{ entries: [manageU1], owner: userOwn }]);
    expect(grants(userManager, underM1, m1)).toBe(false);
    // not even the live row as the value: `equals` on an object admits no hydrated record at read
    const live = { ...underM1, where: { all: [eq('ownerModel', 'User'), eq('user', u1)] } };
    expect(grants(userManager, live, m1)).toBe(false);
    // nor for a writer whose table is keyed on the look-alike's id
    const keyed: Permissions = [
      { entries: [memberRole, grant('db:organizationUser', 'm1', ['operate'])] },
    ];
    expect(grants(await permixOf(keyed), forged, o1)).toBe(false);
  });
});

// ───────────────────────── organization → space → integration ─────────────────────────

const schema: Rules = {
  permissions: {
    'db:organization': {
      actions: {
        own: null,
        manage: 'own',
        read: 'manage',
        'token.create': {
          all: [{ rule: { field: 'actor:User.id', operator: Operator.exists } }, 'manage'],
        },
      },
    },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
        rename: { all: [{ rule: eq('label', 'draft') }, 'read'] },
      },
    },
    'db:integration': {
      actions: {
        own: { rel: 'space', action: 'own' },
        manage: { any: ['own', { rel: 'space', action: 'manage' }] },
        read: { any: ['manage', { rel: 'space', action: 'read' }] },
      },
    },
    'db:kcpThread': {
      actions: {
        read: { rel: 'integration', action: 'read' },
        post: { rel: 'integration', action: 'manage' },
      },
    },
  },
};
const map = mapOf(
  {
    'db:space': { organization: 'db:organization' },
    'db:integration': { space: 'db:space' },
    'db:kcpThread': { integration: 'db:integration' },
  },
  { 'db:space': ['label'], 'db:integration': ['provider'] },
);
const rebac = checkWithRules(map);
const paths = pathsWithRules(map);
const canGrant = canGrantWithRules(map);

const o1 = { id: 'o1' };
const spaceRow = (id: string, label: string) => ({
  id,
  label,
  organizationId: 'o1',
  organization: o1,
});
const s1 = spaceRow('s1', 'draft');
const s1Live = spaceRow('s1', 'live');
const s2 = spaceRow('s2', 'draft');
const integrationIn = (space: Row) => ({ id: 'i1', provider: 'slack', spaceId: space.id, space });

const atS1 = { resource: 'db:space', id: 's1' };
const underS1 = { resource: 'db:space', id: 's1', path: 'space' };
const underO1 = { resource: 'db:organization', id: 'o1', path: 'space.organization' };
const unmarkedS1 = entry('db:space', atS1, ['manage']);
const manageS1 = below(unmarkedS1);
const integrationsOfS1 = (actions: string[], where?: Condition, ref?: string) =>
  entry('db:integration', underS1, actions, where, ref);

const root: Permissions = [{ entries: [grant('db:organization', 'o1', ['own'])] }];
const holding = (entries: EntitlementEntry[], owner: Permissions = root): Permissions => [
  { entries, owner },
];
const grants = async (writer: Permissions, granted: EntitlementEntry, anchor: Row) => {
  const permix = await permixOf(writer);
  const placed = placeEntitlement(map, granted, anchor);
  return placed?.every((record) => canGrant(permix, schema, granted, record)) === true;
};
const manages = async (holder: Permissions, space: Row) =>
  rebac(
    await permixOf(holder),
    schema,
    { resource: 'db:integration', record: integrationIn(space) },
    'manage',
  );

describe("R103's case grants when the held row is marked grantsBelow", () => {
  test('manage on s1 held by entitlement, marked, no where, grants manage on its integrations, narrowed or not', async () => {
    const writer = holding([manageS1]);
    expect(await grants(writer, integrationsOfS1(['manage']), s1)).toBe(true);
    expect(await grants(writer, integrationsOfS1(['manage'], eq('provider', 'slack')), s1)).toBe(
      true,
    );
    expect(await grants(writer, integrationsOfS1(['read']), s1)).toBe(true);
  });

  test('two rows above: threads under the integrations of s1', async () => {
    const threads = entry(
      'db:kcpThread',
      { resource: 'db:space', id: 's1', path: 'integration.space' },
      ['read'],
    );
    expect(await grants(holding([manageS1]), threads, s1)).toBe(true);
  });

  test('an entitlement at the organization, above the anchor: manage on o1 grants under s1', async () => {
    const manageO1 = below(
      entry('db:organization', { resource: 'db:organization', id: 'o1' }, ['manage']),
    );
    expect(await grants(holding([manageO1]), integrationsOfS1(['manage']), s1)).toBe(true);
  });

  test('held on every space of o1, met at the real row s1: grants on the integrations of s1', async () => {
    const spacesOfO1 = below(
      entry('db:space', { resource: 'db:organization', id: 'o1', path: 'organization' }, [
        'manage',
      ]),
    );
    expect(await grants(holding([spacesOfO1]), integrationsOfS1(['manage']), s1)).toBe(true);
  });

  test('no actor: an outright manage on o1 held by entitlement never grants a person-only action', async () => {
    const atO1 = { resource: 'db:organization', id: 'o1' };
    const writer = await permixOf(holding([below(entry('db:organization', atO1, ['manage']))]));
    const mint = entry('db:organization', atO1, ['token.create']);
    expect(
      rebac(
        writer,
        schema,
        { resource: 'db:organization', record: o1, data: actorData('User', { id: 'w1' }) },
        'token.create',
      ),
    ).toBe(true);
    expect(canGrant(writer, schema, mint, o1)).toBe(false);
  });

  test('never more than the action its granter still allows (R111 holds here too)', async () => {
    const readOnly: Permissions = [{ entries: [grant('db:space', 's1', ['read'])] }];
    const writer = holding([manageS1], readOnly);
    expect(await grants(writer, integrationsOfS1(['manage']), s1)).toBe(false);
    expect(await grants(writer, integrationsOfS1(['read']), s1)).toBe(true);
  });

  test('a granter that lost everything grants nothing', async () => {
    expect(await grants(holding([manageS1], []), integrationsOfS1(['read']), s1)).toBe(false);
    expect(await grants(holding([manageS1], []), manageS1, s1)).toBe(false);
  });

  test('a chain of outright entitlements grants, and dies when its root does', async () => {
    const chain = (rootPermissions: Permissions) =>
      holding([manageS1], holding([manageS1], holding([manageS1], rootPermissions)));
    expect(await grants(chain(root), integrationsOfS1(['manage']), s1)).toBe(true);
    expect(await grants(chain([]), integrationsOfS1(['manage']), s1)).toBe(false);
  });

  test('two writers holding manage on s1 from each other grant nothing and do not throw', async () => {
    const a: Permissions = [];
    const b: Permissions = [{ entries: [manageS1], owner: a }];
    a.push({ entries: [manageS1], owner: b });
    expect(await grants(a, integrationsOfS1(['manage']), s1)).toBe(false);
  });

  test('a capped delegate given the marked row grants as its owner below it; nothing given, nothing', async () => {
    const owner = holding([manageS1]);
    const given = delegate(schema, owner, { ceiling: 'read', entitlements: [manageS1] });
    expect(await grants(given, integrationsOfS1(['manage']), s1)).toBe(true);
    for (const ceiling of ['read', 'manage', 'own', 'rename', 'nonsense'])
      expect(
        await grants(delegate(schema, owner, { ceiling }), integrationsOfS1(['manage']), s1),
      ).toBe(false);
  });

  test('after the grant: the row follows whoever backs it, live', async () => {
    const o2 = { id: 'o2' };
    const moved = { ...s1, organizationId: 'o2', organization: o2 };
    const manageO1 = below(
      entry('db:organization', { resource: 'db:organization', id: 'o1' }, ['manage']),
    );
    const w = holding([manageO1]);
    const row = integrationsOfS1(['manage']);
    expect(await grants(w, row, s1)).toBe(true);
    // s1 moves to o2: neither the writer nor o1's owner backs it; o2's owner does
    expect(await manages(holding([row], w), moved)).toBe(false);
    expect(await manages(holding([row], root), moved)).toBe(false);
    const o2Owner: Permissions = [{ entries: [grant('db:organization', 'o2', ['own'])] }];
    expect(await manages(holding([row], o2Owner), moved)).toBe(true);
    // the writer's own row is revoked: a row it backs dies, a row under o1's owner lives on
    expect(await manages(holding([row], holding([manageO1], [])), s1)).toBe(false);
    expect(await manages(holding([row], root), s1)).toBe(true);
  });
});

describe('the mark: a row without grantsBelow never counts in the first pass', () => {
  const row = integrationsOfS1(['manage']);

  test('manage on s1 held without the mark grants a copy of itself, and nothing below it (R103 as it was)', async () => {
    const writer = holding([unmarkedS1]);
    expect(await grants(writer, unmarkedS1, s1)).toBe(true);
    expect(await grants(writer, row, s1)).toBe(false);
    expect(await grants(writer, integrationsOfS1(['read']), s1)).toBe(false);
  });

  test('at every depth: a marked row backed by an unmarked one does not count', async () => {
    expect(await grants(holding([manageS1], holding([unmarkedS1])), row, s1)).toBe(false);
    expect(
      await grants(holding([manageS1], holding([manageS1], holding([unmarkedS1]))), row, s1),
    ).toBe(false);
    expect(
      await grants(
        holding([manageS1], holding([manageS1], holding([manageS1], holding([unmarkedS1])))),
        row,
        s1,
      ),
    ).toBe(false);
    expect(await grants(holding([unmarkedS1], holding([manageS1])), row, s1)).toBe(false);
  });

  test('the copy pass does not read the mark, on the held row or on the entry granted', async () => {
    expect(await grants(holding([manageS1]), unmarkedS1, s1)).toBe(true);
    expect(await grants(holding([unmarkedS1]), manageS1, s1)).toBe(true);
  });

  test('the mark is no part of a read: check and paths answer the same with and without it', async () => {
    for (const held of [manageS1, unmarkedS1]) {
      const holder = await permixOf(holding([{ ...held, ref: 'row' }]));
      const subject = { resource: 'db:integration', record: integrationIn(s1) };
      expect(rebac(holder, schema, subject, 'manage')).toBe(true);
      expect(paths(holder, schema, subject, 'manage')).toEqual([[['row']]]);
    }
  });

  test('setup keeps a marked row and its unmarked twin as two rows, and carries the mark', async () => {
    const permix = await permixOf(holding([unmarkedS1, manageS1, { ...manageS1 }]));
    const held = permix.entitlements('db:space', 'manage');
    expect(held.map((entitlement) => entitlement.grantsBelow)).toEqual([undefined, true]);
    expect(await grants(holding([unmarkedS1, manageS1]), row, s1)).toBe(true);
    expect(await grants(holding([manageS1, unmarkedS1]), row, s1)).toBe(true);
  });

  test('neither twin makes the other redundant', () => {
    expect(coversEntitlement(manageS1, unmarkedS1)).toBe(false);
    expect(coversEntitlement(unmarkedS1, manageS1)).toBe(false);
    expect(coversEntitlement(manageS1, { ...manageS1 })).toBe(true);
    const wider = below(entry('db:space', atS1, ['manage', 'own']));
    expect(withoutRedundantEntitlements([unmarkedS1, manageS1, wider])).toEqual([
      unmarkedS1,
      wider,
    ]);
    expect(wellFormedEntitlements([unmarkedS1, manageS1])).toEqual([unmarkedS1, manageS1]);
  });

  test('the mark is true or absent, and never beside a where', async () => {
    const draft = eq('label', 'draft');
    const wrong = [
      { ...unmarkedS1, grantsBelow: false },
      { ...unmarkedS1, grantsBelow: 'yes' },
      { ...unmarkedS1, grantsBelow: null },
    ] as unknown as EntitlementEntry[];
    for (const bad of wrong) {
      expect(entitlementProblem(bad)).toBe('`grantsBelow` is true or absent');
      expect(placeEntitlement(map, bad, s1)).toBeNull();
    }
    const conditional = { ...manageS1, where: draft };
    expect(entitlementProblem(conditional)).toBe(
      '`grantsBelow` with `where`: a conditional entitlement never grants below it',
    );
    await expect(permixOf(holding([conditional]))).rejects.toThrow('grantsBelow');
    expect(wellFormedEntitlements([conditional, ...wrong, manageS1])).toEqual([manageS1]);
    expect(entitlementProblem({ ...manageS1, where: undefined })).toBeNull();
    expect(await grants(holding([{ ...manageS1, where: undefined }]), row, s1)).toBe(true);
  });

  // An owner the app built itself may hand back anything: a mark beside a `where` still never counts.
  test.each([
    ['a rule', eq('label', 'draft')],
    ['an empty all', { all: [] }],
    ['null', null],
    ['true', true],
  ])('a hand-built owner returning the mark beside a where (%s) does not count', (_name, where) => {
    const backing: PermixLike = { check: () => true };
    const raw: PermixLike = {
      check: () => false,
      entitlements: (resource, action) =>
        resource === 'db:space' && action === 'manage'
          ? [
              {
                anchor: atS1,
                where: where as Condition,
                actions: { manage: true },
                owner: backing,
                grantsBelow: true,
              },
            ]
          : [],
    };
    const placed = { spaceId: 's1', space: s1 };
    expect(canGrant(raw, schema, row, placed)).toBe(false);
    const [held] = raw.entitlements?.('db:space', 'manage') ?? [];
    const bare: PermixLike = {
      ...raw,
      entitlements: () => (held ? [{ ...held, where: undefined }] : []),
    };
    expect(canGrant(bare, schema, row, placed)).toBe(true);
  });
});

describe('refused: an entitlement with a where never counts in the first pass', () => {
  const draft = eq('label', 'draft');
  const row = integrationsOfS1(['manage']);

  test('a marked row backed by a conditional one, at depth 1, 2 and 3', async () => {
    const conditional = holding([entry('db:space', atS1, ['manage'], draft)]);
    expect(await manages(holding([manageS1], conditional), s1)).toBe(true);
    expect(await grants(holding([manageS1], conditional), row, s1)).toBe(false);
    expect(await grants(holding([manageS1], holding([manageS1], conditional)), row, s1)).toBe(
      false,
    );
    expect(
      await grants(
        holding([manageS1], holding([manageS1], holding([manageS1], conditional))),
        row,
        s1,
      ),
    ).toBe(false);
  });

  test('a conditional owner met at the organization, above the anchor', async () => {
    const atO1 = { resource: 'db:organization', id: 'o1' };
    const conditional = holding([entry('db:organization', atO1, ['manage'], eq('id', 'o1'))]);
    expect(await grants(holding([manageS1], conditional), row, s1)).toBe(false);
  });

  test('a full delegate of a conditional holder, and a capped one given the marked row by it', async () => {
    const conditional = holding([entry('db:space', atS1, ['manage'], draft)]);
    expect(await grants(delegate(schema, conditional, { full: true }), row, s1)).toBe(false);
    const given = delegate(schema, conditional, { ceiling: 'read', entitlements: [manageS1] });
    expect(await grants(given, row, s1)).toBe(false);
  });

  test('U1 (3c): manage on s1 where label = draft, true today, does not grant manage on s1 without it', async () => {
    const writer = holding([entry('db:space', atS1, ['manage'], draft)]);
    expect(await grants(writer, manageS1, s1)).toBe(false);
    expect(await grants(writer, entry('db:space', atS1, ['manage'], draft), s1)).toBe(true);
  });

  test('U1 (3e): the same held where does not grant manage on the integrations of s1', async () => {
    const writer = holding([entry('db:space', atS1, ['manage'], draft)]);
    expect(await grants(writer, integrationsOfS1(['manage']), s1)).toBe(false);
    expect(await grants(writer, integrationsOfS1(['manage'], draft), s1)).toBe(false);
  });

  test('U1 (3d): held under s1 where space.label = draft does not grant under s1 without it', async () => {
    const held = integrationsOfS1(['manage'], eq('space.label', 'draft'));
    expect(await grants(holding([held]), integrationsOfS1(['manage']), s1)).toBe(false);
    expect(await grants(holding([held]), held, s1)).toBe(true);
  });

  test('U1: a where reading a parent of the anchor row (organization.id = o1) does not count either', async () => {
    const writer = holding([entry('db:space', atS1, ['manage'], eq('organization.id', 'o1'))]);
    expect(await grants(writer, integrationsOfS1(['manage']), s1)).toBe(false);
  });

  test('a where that is plainly true on the anchor row (id = s1) does not count', async () => {
    const writer = holding([entry('db:space', atS1, ['manage'], eq('id', 's1'))]);
    expect(await grants(writer, integrationsOfS1(['manage']), s1)).toBe(false);
  });
});

describe('refused: combining, sideways, another anchor, a rewritten where', () => {
  const slack = eq('provider', 'slack');
  const teams = eq('provider', 'teams');

  test('two held entitlements never combine (R101)', async () => {
    const writer = holding([integrationsOfS1(['read'], slack), integrationsOfS1(['read'], teams)]);
    const both = integrationsOfS1(['read'], isIn('provider', ['slack', 'teams']));
    expect(await grants(writer, both, s1)).toBe(false);
  });

  test('two outright entitlements on two spaces do not make one grant over both', async () => {
    const manageS2 = below(entry('db:space', { resource: 'db:space', id: 's2' }, ['manage']));
    const writer = holding([manageS1, manageS2]);
    const allOfO1 = entry('db:integration', underO1, ['manage']);
    expect(await grants(writer, allOfO1, o1)).toBe(false);
  });

  test('sideways: manage on s1 grants nothing under s2', async () => {
    const underS2 = entry('db:integration', { resource: 'db:space', id: 's2', path: 'space' }, [
      'manage',
    ]);
    expect(await grants(holding([manageS1]), underS2, s2)).toBe(false);
  });

  test('upwards: manage on s1 grants nothing at o1', async () => {
    const writer = holding([manageS1]);
    const manageO1 = entry('db:organization', { resource: 'db:organization', id: 'o1' }, [
      'manage',
    ]);
    expect(await grants(writer, manageO1, o1)).toBe(false);
    expect(await grants(writer, entry('db:integration', underO1, ['manage']), o1)).toBe(false);
  });

  test('re-anchoring on the same resource: held at o1, granted under s1 (R95)', async () => {
    const heldAtO1 = below(entry('db:integration', underO1, ['read']));
    expect(await grants(holding([heldAtO1]), integrationsOfS1(['read']), s1)).toBe(false);
    expect(await grants(holding([heldAtO1]), heldAtO1, o1)).toBe(true);
  });

  test('a where rewritten without delegatedWhere is refused; built with it, it passes', async () => {
    const held = integrationsOfS1(['read'], isIn('provider', ['slack', 'teams']));
    const writer = holding([held]);
    expect(await grants(writer, integrationsOfS1(['read'], slack), s1)).toBe(false);
    const narrowed = integrationsOfS1(['read'], delegatedWhere(held.where, slack));
    expect(await grants(writer, narrowed, s1)).toBe(true);
  });
});

// A self-anchored entry's placed record is the live granted row. An entitlement met on it is on
// the granted record, not above it, so it never counts: without this the rows below would be
// re-anchored and combined for one row, and R99 reversed (review F1). Every row here is hydrated
// as the database returns it, every held row is marked, and no `where` is involved.
describe('refused: an entitlement on the granted record itself (self-anchored entries)', () => {
  const i1 = integrationIn({ ...s1, label: null });
  const t1 = { id: 't1', integrationId: 'i1', integration: i1 };

  test('R99: holding read on s1 does not grant rename on s1, on a row whose label is draft', async () => {
    const hydrated = { ...s1, label: 'draft' };
    const readS1 = below(entry('db:space', atS1, ['read']));
    const rename = entry('db:space', atS1, ['rename']);
    const holder = await permixOf(holding([readS1]));
    expect(rebac(holder, schema, { resource: 'db:space', record: hydrated }, 'rename')).toBe(true);
    expect(await grants(holding([readS1]), rename, hydrated)).toBe(false);
    // the table holding the same read does grant it: a role is not an entitlement on the record
    const role: Permissions = [{ entries: [grant('db:space', 's1', ['read'])] }];
    expect(await grants(role, rename, hydrated)).toBe(true);
  });

  test('R95: integrations of o1 held outright are not re-anchored to the one row i1', async () => {
    const integrationsOfO1 = below(entry('db:integration', underO1, ['read']));
    const readI1 = entry('db:integration', { resource: 'db:integration', id: 'i1' }, ['read']);
    const holder = await permixOf(holding([integrationsOfO1]));
    expect(rebac(holder, schema, { resource: 'db:integration', record: i1 }, 'read')).toBe(true);
    expect(await grants(holding([integrationsOfO1]), readI1, i1)).toBe(false);
  });

  test('R95: spaces of o1 held outright are not re-anchored to the one row s1', async () => {
    const spacesOfO1 = below(
      entry('db:space', { resource: 'db:organization', id: 'o1', path: 'organization' }, [
        'manage',
      ]),
    );
    expect(await grants(holding([spacesOfO1]), unmarkedS1, s1)).toBe(false);
  });

  test('R101: read on the threads of i1 and post on the threads of s1 do not combine on t1', async () => {
    const readOfI1 = below(
      entry('db:kcpThread', { resource: 'db:integration', id: 'i1', path: 'integration' }, [
        'read',
      ]),
    );
    const postOfS1 = below(
      entry('db:kcpThread', { resource: 'db:space', id: 's1', path: 'integration.space' }, [
        'post',
      ]),
    );
    const both = entry('db:kcpThread', { resource: 'db:kcpThread', id: 't1' }, ['read', 'post']);
    const holder = await permixOf(holding([readOfI1, postOfS1]));
    for (const action of ['read', 'post'])
      expect(rebac(holder, schema, { resource: 'db:kcpThread', record: t1 }, action)).toBe(true);
    expect(await grants(holding([readOfI1, postOfS1]), both, t1)).toBe(false);
  });

  test('a self-anchored copy passes, and rows above the granted one count', async () => {
    expect(await grants(holding([manageS1]), manageS1, s1)).toBe(true);
    const manageI1 = entry('db:integration', { resource: 'db:integration', id: 'i1' }, ['manage']);
    expect(await grants(holding([manageS1]), manageI1, i1)).toBe(true);
  });
});

describe('refused: an entitlement met below the anchor, on a placed record', () => {
  test('held on the granted resource itself, at the placed record: only the copy pass applies', async () => {
    const writer = holding([below(integrationsOfS1(['manage']))]);
    const threads = entry(
      'db:kcpThread',
      { resource: 'db:space', id: 's1', path: 'integration.space' },
      ['read'],
    );
    // the walk meets the held entitlement at the placed integration, between the thread and s1
    expect(await grants(writer, threads, s1)).toBe(false);
  });

  test('held on every space of o1, met at the placed space between the integration and o1', async () => {
    const spacesOfO1 = below(
      entry('db:space', { resource: 'db:organization', id: 'o1', path: 'organization' }, [
        'manage',
      ]),
    );
    const writer = holding([spacesOfO1]);
    expect(await grants(writer, entry('db:integration', underO1, ['manage']), o1)).toBe(false);
    expect(await grants(writer, spacesOfO1, o1)).toBe(true);
  });

  test('held at integration i7 itself; the entry names id = i7, and the placed record still carries no key', async () => {
    const manageI7 = below(
      entry('db:integration', { resource: 'db:integration', id: 'i7' }, ['manage']),
    );
    const pinned = integrationsOfS1(['manage'], eq('id', 'i7'));
    expect(placeEntitlement(map, pinned, s1)?.[0]).not.toHaveProperty('id');
    expect(await grants(holding([manageI7]), pinned, s1)).toBe(false);
  });

  // The row at the end of the entry's path is taken as the anchor when its id is the entry's: the
  // caller hands in what `placeEntitlement` built, the same contract the table pass has on main.
  test('the anchor is the row the placed record holds at the end of the path, by resource and id', async () => {
    const permix = await permixOf(holding([manageS1]));
    const lookAlike = { spaceId: 's1', space: { ...s1 } };
    expect(canGrant(permix, schema, integrationsOfS1(['manage']), lookAlike)).toBe(true);
    const wrongAnchor = { spaceId: 's1', space: { ...s1, id: 's9' } };
    expect(canGrant(permix, schema, integrationsOfS1(['manage']), wrongAnchor)).toBe(false);
  });
});

describe('what counts as above: rows the anchor holds under a to-one relation that owns its key', () => {
  const eqKind = (kind: string) => ({ rule: eq('ownerModel', kind) });

  test('a row reached through a relation that does not own its key is not above', async () => {
    const profiled: Rules = {
      permissions: {
        'db:profile': { actions: { manage: null } },
        'db:space': { actions: { manage: { rel: 'profile', action: 'manage' } } },
        'db:integration': { actions: { manage: { rel: 'space', action: 'manage' } } },
      },
    };
    const owning = mapOf({
      'db:space': { profile: 'db:profile' },
      'db:integration': { space: 'db:space' },
    });
    const db = owning.maps.db as FieldMap;
    const profile = fieldOf(db, 'space', 'profile');
    if (profile?.kind !== 'object') throw new Error('db:space.profile is a relation');
    const inverse: SchemaMapWithoutPermissions = {
      ...owning,
      maps: {
        db: {
          models: {
            ...db.models,
            space: {
              fields: {
                ...modelOf(db, 'space')?.fields,
                profile: { ...profile, fromFields: [], toFields: [] },
              },
            },
          },
        },
      },
    };
    const p1 = { id: 'p1' };
    const space = { id: 's1', profile: p1 };
    const row = entry('db:integration', underS1, ['manage']);
    const manageP1 = below(entry('db:profile', { resource: 'db:profile', id: 'p1' }, ['manage']));
    const byEntitlement = await permixOf([
      { entries: [manageP1], owner: [{ entries: [grant('db:profile', 'p1', ['manage'])] }] },
    ]);
    const byRole = await permixOf([{ entries: [grant('db:profile', 'p1', ['manage'])] }]);
    const on = (lib: SchemaMapWithoutPermissions, permix: Permix) => {
      const check = canGrantWithRules(lib);
      const placed = placeEntitlement(lib, row, space);
      return placed?.every((record) => check(permix, profiled, row, record)) === true;
    };
    expect(on(owning, byEntitlement)).toBe(true);
    expect(on(owning, byRole)).toBe(true);
    // keyed on the other side, nothing hydrates it: no walk reads it, from above or by role
    expect(() => on(inverse, byEntitlement)).toThrow('keeps its foreign key on `db:profile`');
    expect(() => on(inverse, byRole)).toThrow('keeps its foreign key on `db:profile`');
  });

  test('a row reached across a bridge is not above: the first pass crosses no bridge', async () => {
    const bridged: Rules = {
      bridges: [
        {
          endpoints: [
            { fieldMap: 'crm', model: 'Account', on: 'id' },
            { fieldMap: 'db', model: 'space', on: 'accountId' },
          ],
          cardinality: 'oneToMany',
        },
      ],
      permissions: {
        'crm:Account': { actions: { manage: null } },
        'db:space': { actions: { manage: { rel: 'crm:Account', action: 'manage' } } },
        'db:integration': { actions: { manage: { rel: 'space', action: 'manage' } } },
      },
    };
    const lib = mapOf({ 'db:integration': { space: 'db:space' } }, { 'db:space': ['accountId'] });
    const space = { id: 's1', accountId: 'a1' };
    const subject = { resource: 'db:integration', record: { id: 'i1', spaceId: 's1', space } };
    const data = { 'crm:Account': [{ id: 'a1' }] };
    const manageA1 = below(entry('crm:Account', { resource: 'crm:Account', id: 'a1' }, ['manage']));
    const writer = await permixOf([
      { entries: [manageA1], owner: [{ entries: [grant('crm:Account', 'a1', ['manage'])] }] },
    ]);
    expect(checkWithRules(lib)(writer, bridged, { ...subject, data }, 'manage')).toBe(true);
    const row = entry('db:integration', underS1, ['manage']);
    const placed = placeEntitlement(lib, row, space);
    expect(placed).not.toBeNull();
    const check = canGrantWithRules(lib);
    expect(placed?.every((record) => check(writer, bridged, row, record))).toBe(false);
  });

  // The held entitlement's own path is tested on the real row, kinds included (`reaches`).
  test('a held entitlement whose path crosses a polymorphic step counts only for a row of that kind', async () => {
    const column = stringColumn;
    const toOne = (type: string, from: string) => ({
      kind: 'object' as const,
      type,
      isList: false,
      fromFields: [from],
      toFields: ['id'],
    });
    const lib: SchemaMapWithoutPermissions = {
      maps: {
        db: {
          models: {
            organization: { fields: { id: column } },
            user: { fields: { id: column } },
            integration: {
              fields: {
                id: column,
                ownerModel: column,
                organizationId: column,
                userId: column,
                organization: toOne('organization', 'organizationId'),
                user: toOne('user', 'userId'),
              },
            },
            kcpThread: {
              fields: {
                id: column,
                integrationId: column,
                integration: toOne('integration', 'integrationId'),
              },
            },
          },
        },
      },
      polymorphism: {
        db: {
          integration: {
            axes: [
              {
                field: 'ownerModel',
                fkMap: { Organization: ['organizationId'], User: ['userId'] },
              },
            ],
          },
        },
      },
    };
    const owned: Rules = {
      permissions: {
        'db:organization': { actions: { own: null, read: 'own' } },
        'db:user': { actions: { own: null } },
        'db:integration': {
          actions: {
            read: { all: [eqKind('Organization'), { rel: 'organization', action: 'read' }] },
          },
        },
        'db:kcpThread': { actions: { read: { rel: 'integration', action: 'read' } } },
      },
    };
    const integrationsOfO1 = below(
      entry('db:integration', { resource: 'db:organization', id: 'o1', path: 'organization' }, [
        'read',
      ]),
    );
    const writer = await permixOf(holding([integrationsOfO1]));
    const threads = entry(
      'db:kcpThread',
      { resource: 'db:integration', id: 'i1', path: 'integration' },
      ['read'],
    );
    const check = canGrantWithRules(lib);
    const on = (integration: Row) => {
      const placed = placeEntitlement(lib, threads, integration);
      return placed?.every((record) => check(writer, owned, threads, record)) === true;
    };
    const ofOrganization = {
      id: 'i1',
      ownerModel: 'Organization',
      organizationId: 'o1',
      organization: o1,
    };
    expect(on(ofOrganization)).toBe(true);
    expect(on({ ...ofOrganization, ownerModel: 'User', userId: 'u1', user: { id: 'u1' } })).toBe(
      false,
    );
  });
});

// ───────────────────────── upstream conditions ─────────────────────────
//
// W holds `manage` on s1 outright (no where). W's row is backed by G. W grants `manage` on the
// integrations of s1 to H. The new row lands (a) under W, or (b) under X, the organization's owner.

describe('upstream conditions', () => {
  const draft = eq('label', 'draft');
  const newRow = integrationsOfS1(['manage'], undefined, 'new-row');
  const wRow = below(entry('db:space', atS1, ['manage'], undefined, 'w-row'));
  const x = root;

  describe("the granter's own authority is an entitlement with a where (label = draft)", () => {
    const g = holding([entry('db:space', atS1, ['manage'], draft, 'g-row')]);
    const w = holding([wRow], g);

    test('the grant check refuses, though s1 is a draft today: a where is not counted at any depth', async () => {
      expect(await manages(w, s1)).toBe(true);
      expect(await grants(w, newRow, s1)).toBe(false);
    });

    test('W copies its own row: the copy pass ignores every where in liveness', async () => {
      expect(await grants(w, wRow, s1)).toBe(true);
    });

    // What a read would admit had the row been written anyway (it is not: the grant is refused).
    test('had the row landed under W: it admits while s1 is a draft and stops when it is not', async () => {
      const h = holding([newRow], w);
      expect(await manages(h, s1)).toBe(true);
      expect(await manages(h, s1Live)).toBe(false);
    });

    test('had the row landed under X: it admits whatever the label is. This is why the refusal matters', async () => {
      const h = holding([newRow], x);
      expect(await manages(h, s1)).toBe(true);
      expect(await manages(h, s1Live)).toBe(true);
    });
  });

  describe("the granter's condition is a schema rule, not an entitlement where", () => {
    test('a schema rule upstream is re-run on the placed record, as for a table grant: unknown label refuses', async () => {
      const ruled: Rules = {
        permissions: {
          ...schema.permissions,
          'db:space': {
            actions: {
              ...schema.permissions['db:space']?.actions,
              manage: {
                all: [{ rule: draft }, { any: ['own', { rel: 'organization', action: 'manage' }] }],
              },
            },
          },
        },
      };
      const permix = await permixOf(holding([wRow], root));
      const on = (space: Row) =>
        canGrant(permix, ruled, newRow, { spaceId: space.id, space } as Row);
      expect(on(s1)).toBe(true);
      expect(on(s1Live)).toBe(false);
    });
  });

  describe("the granter's row carries a lens", () => {
    // The library has no lens: an app keeps it on the stored row, applies the lenses of the rows
    // on the chain `paths` reports, and marks `grantsBelow` only a row with no lens. `g-row` is
    // G's lensed row, so it is unmarked.
    const g = holding([entry('db:space', atS1, ['manage'], undefined, 'g-row')]);
    const w = holding([wRow], g);
    const chains = async (holder: Permissions) =>
      paths(
        await permixOf(holder),
        schema,
        { resource: 'db:integration', record: integrationIn(s1) },
        'manage',
      );

    test('the grant check refuses: an unmarked row is not counted at any depth', async () => {
      expect(await manages(w, s1)).toBe(true);
      expect(await grants(w, newRow, s1)).toBe(false);
    });

    test('with no lens on G’s row (marked) it passes', async () => {
      const unlensed = holding([below(entry('db:space', atS1, ['manage'], undefined, 'g-row'))]);
      expect(await grants(holding([wRow], unlensed), newRow, s1)).toBe(true);
    });

    test('W copies its own row: a lensed chain is handed on by the copy pass', async () => {
      expect(await grants(w, wRow, s1)).toBe(true);
    });

    test('landed under W: the read stands on the new row, then W’s row, then G’s lensed row', async () => {
      expect(await chains(holding([newRow], w))).toEqual([[['new-row', 'w-row', 'g-row']]]);
    });

    test('had the row landed under X: the read stands on the new row alone, G’s lens off the chain. This is why the refusal matters', async () => {
      expect(await chains(holding([newRow], x))).toEqual([[['new-row']]]);
    });

    test('the same when the lens is on W’s own row: unmarked, it does not grant below it', async () => {
      const lensedW = holding([entry('db:space', atS1, ['manage'], undefined, 'w-row-lensed')]);
      expect(await grants(lensedW, newRow, s1)).toBe(false);
    });
  });
});

describe("list pins and delegatedWhere narrowing, as on main's copy pass", () => {
  const threadsOfS1 = (where?: Condition) =>
    entry(
      'db:kcpThread',
      { resource: 'db:space', id: 's1', path: 'integration.space' },
      ['read'],
      where,
    );
  const pin = isIn('id', ['A', 'B']);

  test('a list pin is copied at every depth of a chain', async () => {
    const g = holding([threadsOfS1(pin)]);
    const p = holding([threadsOfS1(pin)], g);
    const c = holding([threadsOfS1(pin)], p);
    for (const writer of [g, p, c]) expect(await grants(writer, threadsOfS1(pin), s1)).toBe(true);
  });

  test('narrowed beside the held pin at every depth; never with the held pin dropped', async () => {
    const onlyA = delegatedWhere(pin, isIn('id', ['A']));
    expect(onlyA).toEqual({ all: [isIn('id', ['A']), pin] });
    const g = holding([threadsOfS1(pin)]);
    const p = holding([threadsOfS1(onlyA)], g);
    expect(await grants(g, threadsOfS1(onlyA), s1)).toBe(true);
    expect(await grants(p, threadsOfS1(onlyA), s1)).toBe(true);
    expect(await grants(p, threadsOfS1(delegatedWhere(onlyA, eq('id', 'A'))), s1)).toBe(true);
    expect(await grants(g, threadsOfS1(isIn('id', ['A'])), s1)).toBe(false);
    expect(await grants(p, threadsOfS1(pin), s1)).toBe(false);
  });
});
