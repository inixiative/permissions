import { describe, expect, test } from 'bun:test';
import { type Bridge, Operator } from '@inixiative/json-rules';
import type { ActionRule, Actor, PermixLike, RebacSchema, ResolveRelation } from '../index';
import { createRebacCheck, defineActor } from '../index';

// stub permix: no direct grants (forces schema evaluation); optional superadmin + actor id.
const stub = (
  opts: { userId?: string | null; superadmin?: boolean; grant?: string } = {},
): PermixLike => ({
  check: (_resource, action) => action === opts.grant,
  isSuperadmin: () => opts.superadmin ?? false,
  getActor: () => (opts.userId ? defineActor({ id: opts.userId }) : null),
});

// stub permix that grants specific resource:action to specific ids — for rbac-terminal bridge walks.
const grantStub = (grants: Record<string, string[]>): PermixLike => ({
  check: (resource, action, id) => !!id && (grants[`${resource}:${action}`]?.includes(id) ?? false),
  isSuperadmin: () => false,
  getActor: () => null,
});

const schema: RebacSchema = {
  permissions: {
    organization: {
      actions: {
        own: { rule: { field: 'role', operator: Operator.equals, value: 'owner' } },
        manage: {
          any: ['own', { rule: { field: 'role', operator: Operator.equals, value: 'admin' } }],
        },
        read: 'manage',
      },
    },
    membership: {
      actions: {
        leave: { self: 'userId', action: 'operate' },
        manage: { rel: 'organization', action: 'manage' },
      },
    },
    user: {
      actions: {
        own: null,
        manage: 'own',
        operate: 'manage',
        read: 'operate',
        'user.identify': 'read',
      },
    },
  },
};

const relations: Record<string, Record<string, string>> = {
  membership: { organization: 'organization' },
};
const resolveRelation: ResolveRelation = (resource, seg) => relations[resource]?.[seg] ?? null;
const check = createRebacCheck(resolveRelation, { selfResource: 'user' });

describe('rebac check', () => {
  test('ABAC { rule } leaf', () => {
    expect(
      check(stub(), schema, { resource: 'organization', record: { role: 'owner' } }, 'own'),
    ).toBe(true);
    expect(
      check(stub(), schema, { resource: 'organization', record: { role: 'member' } }, 'own'),
    ).toBe(false);
  });

  test('string delegation (read → manage → own/admin)', () => {
    expect(
      check(stub(), schema, { resource: 'organization', record: { role: 'admin' } }, 'read'),
    ).toBe(true);
    expect(
      check(stub(), schema, { resource: 'organization', record: { role: 'member' } }, 'read'),
    ).toBe(false);
  });

  test('a direct permix grant short-circuits before schema', () => {
    expect(
      check(
        stub({ grant: 'own' }),
        schema,
        { resource: 'organization', record: { role: 'member' } },
        'own',
      ),
    ).toBe(true);
  });

  // grants: `user:<action>` → the actor holds that action on its own user entry
  const actor = (userId: string | null, ...userActions: string[]): PermixLike => ({
    check: (resource, action, id) =>
      resource === 'user' && id === userId && userActions.includes(action),
    isSuperadmin: () => false,
    getActor: () => (userId ? defineActor({ id: userId }) : null),
  });
  const leave = (permix: PermixLike, userId: string) =>
    check(permix, schema, { resource: 'membership', record: { userId } }, 'leave');

  test("{ self, action } needs the id to match AND the action on the actor's own entry", () => {
    expect(leave(actor('u1', 'own'), 'u1')).toBe(true);
    expect(leave(actor('u1', 'own'), 'u2')).toBe(false);
    expect(leave(actor(null), 'u1')).toBe(false);
  });

  test("{ self, action } walks the self resource's delegation chain", () => {
    expect(leave(actor('u1', 'operate'), 'u1')).toBe(true);
    expect(leave(actor('u1', 'manage'), 'u1')).toBe(true);
  });

  test('{ self, action } refuses a narrowed actor that lacks the action on itself', () => {
    expect(leave(actor('u1', 'read'), 'u1')).toBe(false);
    expect(leave(actor('u1'), 'u1')).toBe(false);
  });

  test('{ self, action } takes any user action, custom ones included', () => {
    const s: RebacSchema = {
      permissions: {
        ...schema.permissions,
        membership: { actions: { export: { self: 'userId', action: 'report.export' } } },
      },
    };
    const run = (permix: PermixLike) =>
      check(permix, s, { resource: 'membership', record: { userId: 'u1' } }, 'export');
    expect(run(actor('u1', 'report.export'))).toBe(true);
    expect(run(actor('u1', 'own'))).toBe(false);
  });

  test("a bare { self } is identity only: the record is the acting person's", () => {
    const s: RebacSchema = {
      permissions: { membership: { actions: { mine: { self: 'userId' } } } },
    };
    const mine = (permix: PermixLike, userId: string) =>
      check(permix, s, { resource: 'membership', record: { userId } }, 'mine');
    expect(mine(actor('u1'), 'u1')).toBe(true);
    expect(mine(actor('u1'), 'u2')).toBe(false);
    expect(mine(actor(null), 'u1')).toBe(false);
  });

  test('{ self } compares against the person behind the actor, not the actor id', () => {
    const s: RebacSchema = {
      permissions: { membership: { actions: { mine: { self: 'userId' } } } },
    };
    const as = (a: Actor): PermixLike => ({ check: () => false, getActor: () => a });
    const mine = (a: Actor) =>
      check(as(a), s, { resource: 'membership', record: { userId: 'u1' } }, 'mine');
    // a token acting for person u1
    expect(
      mine(defineActor({ id: 't1', model: 'Token', principal: { model: 'User', id: 'u1' } })),
    ).toBe(true);
    // a membership token of u1
    expect(
      mine(
        defineActor({
          id: 't2',
          model: 'Token',
          principal: { model: 'OrganizationUser', id: 'm1', userId: 'u1' },
        }),
      ),
    ).toBe(true);
    // an organization token has no person: every self arm fails closed
    expect(
      mine(
        defineActor({ id: 't3', model: 'Token', principal: { model: 'Organization', id: 'o1' } }),
      ),
    ).toBe(false);
  });

  test('selfId is injectable', () => {
    const s: RebacSchema = { permissions: { doc: { actions: { mine: { self: 'teamId' } } } } };
    const byTeam = createRebacCheck(resolveRelation, {
      selfId: (a) => (typeof a?.teamId === 'string' ? a.teamId : null),
    });
    const as: PermixLike = {
      check: () => false,
      getActor: () => defineActor({ id: 'u1', teamId: 'team1' }),
    };
    expect(byTeam(as, s, { resource: 'doc', record: { teamId: 'team1' } }, 'mine')).toBe(true);
    expect(byTeam(as, s, { resource: 'doc', record: { teamId: 'team2' } }, 'mine')).toBe(false);
  });

  test('a self arm without a configured selfResource is an error', () => {
    const noSelf = createRebacCheck(resolveRelation);
    expect(() =>
      noSelf(
        actor('u1', 'own'),
        schema,
        { resource: 'membership', record: { userId: 'u1' } },
        'leave',
      ),
    ).toThrow('selfResource');
  });

  test("a self arm that loops back through the actor's own entry is a cycle, not a hang", () => {
    const s: RebacSchema = {
      permissions: {
        user: { actions: { loop: { self: 'id', action: 'loop' } } },
      },
    };
    expect(() => check(actor('u1'), s, { resource: 'user', record: { id: 'u1' } }, 'loop')).toThrow(
      'Cycle detected',
    );
  });

  test('a superadmin passes a self arm', () => {
    expect(leave(stub({ superadmin: true }), 'someone-else')).toBe(true);
  });

  test('{ rel, action } walks an intra-map relation via resolveRelation', () => {
    expect(
      check(
        stub(),
        schema,
        { resource: 'membership', record: { organization: { role: 'admin' } } },
        'manage',
      ),
    ).toBe(true);
    expect(
      check(
        stub(),
        schema,
        { resource: 'membership', record: { organization: { role: 'member' } } },
        'manage',
      ),
    ).toBe(false);
    expect(
      check(stub(), schema, { resource: 'membership', record: { organization: null } }, 'manage'),
    ).toBe(false);
  });

  test('resolveRelation returning null aborts the walk', () => {
    const noRels = createRebacCheck(() => null);
    expect(
      noRels(
        stub(),
        schema,
        { resource: 'membership', record: { organization: { role: 'admin' } } },
        'manage',
      ),
    ).toBe(false);
  });

  test('null is a terminal deny; superadmin bypasses everything', () => {
    expect(
      check(stub(), schema, { resource: 'organization', record: { role: 'owner' } }, null),
    ).toBe(false);
    expect(
      check(
        stub({ superadmin: true }),
        schema,
        { resource: 'organization', record: { role: 'member' } },
        null,
      ),
    ).toBe(true);
  });

  test('per-row permissionRules override is additive (OR)', () => {
    const record = { role: 'member', permissionRules: { own: { rule: true } } };
    expect(check(stub(), schema, { resource: 'organization', record }, 'own')).toBe(true);
  });
});

describe('rebac check — bridge (cross-map) rel walks', () => {
  // crm:Account (the "one") ↔ db:User (the "many"); User.accountId joins Account.id.
  const bridges: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Account', on: 'id' },
        { fieldMap: 'db', model: 'User', on: 'accountId' },
      ],
      cardinality: 'oneToMany',
    },
  ];

  test('rbac-terminal: walk the bridge via the join-key scalar → permix grant on the far resource', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'own' } } },
        'crm:Account': { actions: { own: null } }, // granted only via permix
      },
    };
    const c = createRebacCheck(() => null);
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    // no subject.data needed — the far id is the scalar already on the record
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' } }, 'read'),
    ).toBe(true);
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: 'other' } }, 'read'),
    ).toBe(false);
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: null } }, 'read'),
    ).toBe(false);
  });

  test('abac-after-bridge: the far record’s fields come from subject.data via the dictionary', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'view' } } },
        'crm:Account': {
          actions: { view: { rule: { field: 'tier', operator: Operator.equals, value: 'gold' } } },
        },
      },
    };
    const c = createRebacCheck(() => null);
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', accountId: 'acc1' },
      data: { 'crm:Account': [{ id: 'acc1', tier: 'gold' }] },
    };
    expect(c(stub(), s, subject, 'read')).toBe(true);
    // same walk without supplemental data → the far record has no fields → abac fails
    expect(
      c(stub(), s, { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' } }, 'read'),
    ).toBe(false);
  });
});

describe('to-one constraint on bridge walks (adversarial: must not walk onto the "many" side)', () => {
  // crm:Account (the "one", endpoints[0]) ↔ db:User (the "many", endpoints[1]).
  const bridges: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Account', on: 'id' },
        { fieldMap: 'db', model: 'User', on: 'accountId' },
      ],
      cardinality: 'oneToMany',
    },
  ];

  test('walking from the "one" side onto the "many" side is denied — never collapsed to found[0]', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'crm:Account': { actions: { read: { rel: 'db:User', action: 'view' } } },
        'db:User': {
          actions: { view: { rule: { field: 'active', operator: Operator.equals, value: true } } },
        },
      },
    };
    const c = createRebacCheck(() => null);
    // Data ordered so a found[0] collapse would WRONGLY allow (first row is active). The hop onto the
    // many side must be refused regardless of row order — a single-record check can't span a list.
    const subject = {
      resource: 'crm:Account',
      record: { id: 'acc1' },
      data: {
        'db:User': [
          { id: 'u2', accountId: 'acc1', active: true },
          { id: 'u1', accountId: 'acc1', active: false },
        ],
      },
    };
    expect(c(stub(), s, subject, 'read')).toBe(false);
  });

  test('the "one" side is still reachable from the "many" side (unaffected)', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'view' } } },
        'crm:Account': {
          actions: { view: { rule: { field: 'tier', operator: Operator.equals, value: 'gold' } } },
        },
      },
    };
    const c = createRebacCheck(() => null);
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', accountId: 'acc1' },
      data: { 'crm:Account': [{ id: 'acc1', tier: 'gold' }] },
    };
    expect(c(stub(), s, subject, 'read')).toBe(true);
  });
});

describe('bridge — complex traversals (multi-hop, mixed-path, composition)', () => {
  // db:User --(accountId→id)--> crm:Account --(subscriptionId→id)--> billing:Subscription.
  // Both hops are many→one (walkable). The intermediate Account must be supplied so its
  // subscriptionId scalar is available for the second hop.
  const chainBridges: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Account', on: 'id' },
        { fieldMap: 'db', model: 'User', on: 'accountId' },
      ],
      cardinality: 'oneToMany',
    },
    {
      endpoints: [
        { fieldMap: 'billing', model: 'Subscription', on: 'id' },
        { fieldMap: 'crm', model: 'Account', on: 'subscriptionId' },
      ],
      cardinality: 'oneToMany',
    },
  ];

  test('chains two bridges (db:User → crm:Account → billing:Subscription) via successive join scalars', () => {
    const s: RebacSchema = {
      bridges: chainBridges,
      permissions: {
        'db:User': {
          actions: { read: { rel: 'crm:Account.billing:Subscription', action: 'own' } },
        },
        'billing:Subscription': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(() => null);
    const granted = grantStub({ 'billing:Subscription:own': ['sub1'] });
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', accountId: 'acc1' },
      data: { 'crm:Account': [{ id: 'acc1', subscriptionId: 'sub1' }] },
    };
    expect(c(granted, s, subject, 'read')).toBe(true);
  });

  test('a chained bridge fails closed when the intermediate record (and its next join scalar) is absent', () => {
    const s: RebacSchema = {
      bridges: chainBridges,
      permissions: {
        'db:User': {
          actions: { read: { rel: 'crm:Account.billing:Subscription', action: 'own' } },
        },
        'billing:Subscription': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(() => null);
    const granted = grantStub({ 'billing:Subscription:own': ['sub1'] });
    // No Account in data → synthetic { id: 'acc1' } carries no subscriptionId → second hop can't resolve.
    const subject = { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' } };
    expect(c(granted, s, subject, 'read')).toBe(false);
  });

  const oneBridge: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Account', on: 'id' },
        { fieldMap: 'db', model: 'User', on: 'accountId' },
      ],
      cardinality: 'oneToMany',
    },
  ];

  test('crosses a bridge then walks an intra-source relation on the far map (rbac-terminal)', () => {
    const s: RebacSchema = {
      bridges: oneBridge,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account.owner', action: 'own' } } },
        'crm:Contact': { actions: { own: null } },
      },
    };
    // The Account.owner segment is NOT a bridge — resolveRelation supplies the far-map hop.
    const resolve: ResolveRelation = (resource, seg) =>
      resource === 'crm:Account' && seg === 'owner' ? 'crm:Contact' : null;
    const c = createRebacCheck(resolve);
    const granted = grantStub({ 'crm:Contact:own': ['c1'] });
    // The far Account is supplied WITH its nested owner — the synthetic walk reads current['owner'].
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', accountId: 'acc1' },
      data: { 'crm:Account': [{ id: 'acc1', owner: { id: 'c1' } }] },
    };
    expect(c(granted, s, subject, 'read')).toBe(true);
  });

  test('a post-bridge intra-source rel fails closed when the far record is synthetic (no data → no relation fields)', () => {
    const s: RebacSchema = {
      bridges: oneBridge,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account.owner', action: 'own' } } },
        'crm:Contact': { actions: { own: null } },
      },
    };
    const resolve: ResolveRelation = (resource, seg) =>
      resource === 'crm:Account' && seg === 'owner' ? 'crm:Contact' : null;
    const c = createRebacCheck(resolve);
    const granted = grantStub({ 'crm:Contact:own': ['c1'] });
    // No data → far Account is synthetic { id: 'acc1' } with no `owner` field → walk aborts.
    const subject = { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' } };
    expect(c(granted, s, subject, 'read')).toBe(false);
  });

  test('after crossing a bridge, the far resource’s action delegates through a string chain', () => {
    const s: RebacSchema = {
      bridges: oneBridge,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'read' } } },
        'crm:Account': { actions: { own: null, manage: 'own', read: 'manage' } },
      },
    };
    const c = createRebacCheck(() => null);
    // The grant is only on `own`; reaching it requires read → manage → own on the far resource.
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' } }, 'read'),
    ).toBe(true);
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: 'other' } }, 'read'),
    ).toBe(false);
  });

  test('a bridge rel composes inside `any` alongside a local rule', () => {
    const s: RebacSchema = {
      bridges: oneBridge,
      permissions: {
        'db:User': {
          actions: {
            read: {
              any: [
                { rule: { field: 'isAdmin', operator: Operator.equals, value: true } },
                { rel: 'crm:Account', action: 'own' },
              ],
            },
          },
        },
        'crm:Account': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(() => null);
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    // Local rule fails (isAdmin false) but the bridge branch grants.
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', accountId: 'acc1', isAdmin: false } },
        'read',
      ),
    ).toBe(true);
    // Neither branch: local false AND the bridge id mismatches.
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', accountId: 'other', isAdmin: false } },
        'read',
      ),
    ).toBe(false);
  });
});

describe('oneToOne bridge is walkable from both endpoints (symmetric)', () => {
  // db:User.profileId ↔ crm:Profile.id — to-one in both directions.
  const bridges: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'db', model: 'User', on: 'profileId' },
        { fieldMap: 'crm', model: 'Profile', on: 'id' },
      ],
      cardinality: 'oneToOne',
    },
  ];

  test('forward: db:User → crm:Profile', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Profile', action: 'own' } } },
        'crm:Profile': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(() => null);
    const granted = grantStub({ 'crm:Profile:own': ['p1'] });
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', profileId: 'p1' } }, 'read'),
    ).toBe(true);
  });

  test('reverse: crm:Profile → db:User (allowed — oneToOne is to-one both ways)', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'crm:Profile': { actions: { read: { rel: 'db:User', action: 'own' } } },
        'db:User': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(() => null);
    const granted = grantStub({ 'db:User:own': ['u1'] });
    // Profile.id (record.id) joins User.profileId; the User row is supplied for the reverse index.
    const subject = {
      resource: 'crm:Profile',
      record: { id: 'p1' },
      data: { 'db:User': [{ id: 'u1', profileId: 'p1' }] },
    };
    expect(c(granted, s, subject, 'read')).toBe(true);
  });
});

describe('bridge synthetic far-record joins on the actual far key (not always `id`)', () => {
  // crm:Team (the "one", endpoints[0]) joins on a NON-id unique field `code`;
  // db:User (the "many", endpoints[1]) joins on `teamCode`. Walking db:User → crm:Team lands on a
  // far endpoint whose join key is `code`, NOT `id`.
  const bridges: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Team', on: 'code' },
        { fieldMap: 'db', model: 'User', on: 'teamCode' },
      ],
      cardinality: 'oneToMany',
    },
  ];

  const s: RebacSchema = {
    bridges,
    permissions: {
      'db:User': { actions: { read: { rel: 'crm:Team', action: 'own' } } },
      'crm:Team': { actions: { own: null } }, // granted only via permix (id-keyed grants)
    },
  };
  const c = createRebacCheck(() => null);
  // An actor holds an id-keyed grant on the Team whose *id* happens to equal the join value.
  const granted = grantStub({ 'crm:Team:own': ['collidingValue'] });

  test('an id-keyed grant colliding with a NON-id join value must NOT allow (no subject.data)', () => {
    // record.teamCode joins crm:Team.code — it is NOT a Team id. The colliding id-grant must not apply.
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', teamCode: 'collidingValue' } },
        'read',
      ),
    ).toBe(false);
  });

  test('monotonic: supplying the real far row (id ≠ join value) keeps the decision a deny', () => {
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', teamCode: 'collidingValue' },
      // The real Team joined by code has its own distinct id, on which the actor holds NO grant.
      data: { 'crm:Team': [{ id: 'realTeam', code: 'collidingValue' }] },
    };
    expect(c(granted, s, subject, 'read')).toBe(false);
  });
});

describe('empty combinators follow boolean identity (all([]) = true, any([]) = false)', () => {
  test('an empty `all` is vacuously true (allow) — `true`/allow is a valid permission value', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: { all: [] } } } } };
    const c = createRebacCheck(() => null);
    expect(c(stub(), s, { resource: 'm', record: { id: '1' } }, 'read')).toBe(true);
  });

  test('an empty `any` is false (deny)', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: { any: [] } } } } };
    const c = createRebacCheck(() => null);
    expect(c(stub(), s, { resource: 'm', record: { id: '1' } }, 'read')).toBe(false);
  });

  test('a non-empty `all` still requires every branch', () => {
    const s: RebacSchema = {
      permissions: {
        m: {
          actions: {
            read: {
              all: [
                { rule: { field: 'a', operator: Operator.equals, value: 1 } },
                { rule: { field: 'b', operator: Operator.equals, value: 2 } },
              ],
            },
          },
        },
      },
    };
    const c = createRebacCheck(() => null);
    expect(c(stub(), s, { resource: 'm', record: { a: 1, b: 2 } }, 'read')).toBe(true);
    expect(c(stub(), s, { resource: 'm', record: { a: 1, b: 9 } }, 'read')).toBe(false);
  });
});

describe('dictionary is built lazily (adversarial: malformed data must not crash a non-bridge check)', () => {
  test('a check that never takes a bridge hop does not build (or crash on) the dictionary', () => {
    const s: RebacSchema = {
      bridges: [
        {
          endpoints: [
            { fieldMap: 'crm', model: 'Account', on: 'id' },
            { fieldMap: 'db', model: 'User', on: 'accountId' },
          ],
          cardinality: 'oneToMany',
        },
      ],
      permissions: {
        'db:User': {
          actions: { own: true, leave: { self: 'userId', action: 'own' } },
        },
      },
    };
    const c = createRebacCheck<string>(() => null, { selfResource: 'db:User' });
    // Duplicate "one"-side (Account.id) rows would make indexBridges throw — but this check
    // resolves via { self } and never hops, so the dictionary must never be built.
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', userId: 'me' },
      data: { 'crm:Account': [{ id: 'dup' }, { id: 'dup' }] },
    };
    expect(c(stub({ userId: 'me' }), s, subject, 'leave')).toBe(true);
  });
});

describe('raw boolean ActionRule (true = allow, false = deny; null stays a deny)', () => {
  const c = createRebacCheck(() => null);
  const schemaFor = (rule: ActionRule): RebacSchema => ({
    permissions: { m: { actions: { read: rule } } },
  });
  const subject = { resource: 'm', record: { id: '1' } };

  test('a bare `true` allows and `false` denies', () => {
    expect(c(stub(), schemaFor(true), subject, 'read')).toBe(true);
    expect(c(stub(), schemaFor(false), subject, 'read')).toBe(false);
  });

  test('booleans compose inside any / all', () => {
    expect(c(stub(), schemaFor({ any: [false, true] }), subject, 'read')).toBe(true);
    expect(c(stub(), schemaFor({ all: [true, false] }), subject, 'read')).toBe(false);
  });

  test('a delegate resolving to `false` is a terminal deny (like null)', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: 'block', block: false } } } };
    expect(c(stub(), s, subject, 'read')).toBe(false);
  });
});

describe('cycle detection (regressions for the adversarial findings)', () => {
  test('#2 self-delegation throws instead of looping forever', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: 'read' } } } };
    const c = createRebacCheck(() => null);
    expect(() => c(stub(), s, { resource: 'm', record: { id: '1' } }, 'read')).toThrow(
      /Cycle detected/,
    );
  });

  test('#2 mutual delegation throws', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: 'manage', manage: 'read' } } } };
    const c = createRebacCheck(() => null);
    expect(() => c(stub(), s, { resource: 'm', record: { id: '1' } }, 'read')).toThrow(
      /Cycle detected/,
    );
  });

  test('#3 a legal chain of distinct id-LESS records does NOT false-positive a cycle', () => {
    const s: RebacSchema = {
      permissions: {
        node: {
          actions: {
            read: {
              any: [
                { rule: { field: 'isOwner', operator: Operator.equals, value: true } },
                { rel: 'parent', action: 'read' },
              ],
            },
          },
        },
      },
    };
    const c = createRebacCheck(() => 'node'); // parent → node
    const top = { isOwner: true };
    const mid = { isOwner: false, parent: top };
    const leaf = { isOwner: false, parent: mid };
    expect(c(stub(), s, { resource: 'node', record: leaf }, 'read')).toBe(true);
  });

  test('a genuine relation cycle still throws', () => {
    const s: RebacSchema = {
      permissions: { node: { actions: { read: { rel: 'parent', action: 'read' } } } },
    };
    const c = createRebacCheck(() => 'node');
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', parent: a };
    a.parent = b;
    expect(() => c(stub(), s, { resource: 'node', record: a }, 'read')).toThrow(/Cycle detected/);
  });
});

describe('actor: { actor } predicates over the nested actor', () => {
  const check = createRebacCheck<string>(() => null, { selfResource: 'user' });
  const as = (actor: Actor | null): PermixLike => ({
    check: () => false,
    isSuperadmin: () => false,
    getActor: () => actor,
  });
  const personOnly: ActionRule = {
    actor: { field: 'model', operator: Operator.equals, value: 'User' },
  };
  const schema: RebacSchema = {
    permissions: { user: { actions: { 'token.create': { all: [personOnly, true] } } } },
  };
  const create = (actor: Actor | null) =>
    check(as(actor), schema, { resource: 'user', record: { id: 'u1' } }, 'token.create');

  test('{ actor } evaluates a condition over the actor itself', () => {
    expect(create(defineActor({ id: 'u1' }))).toBe(true);
    expect(
      create(defineActor({ id: 't1', model: 'Token', principal: { model: 'User', id: 'u1' } })),
    ).toBe(false);
    expect(create(null)).toBe(false);
  });

  test('{ actor } reaches the principal through a dotted path', () => {
    const s: RebacSchema = {
      permissions: {
        doc: {
          actions: {
            read: {
              actor: { field: 'principal.model', operator: Operator.equals, value: 'Organization' },
            },
          },
        },
      },
    };
    const read = (a: Actor) => check(as(a), s, { resource: 'doc', record: {} }, 'read');
    expect(
      read(
        defineActor({ id: 't1', model: 'Token', principal: { model: 'Organization', id: 'o1' } }),
      ),
    ).toBe(true);
    expect(read(defineActor({ id: 'u1' }))).toBe(false);
  });

  test('defineActor defaults the model to User and the principal to the actor', () => {
    expect(defineActor({ id: 'u1' })).toEqual({
      id: 'u1',
      model: 'User',
      principal: { model: 'User', id: 'u1' },
    });
  });

  test('a rule reads only the record: no actor binds', () => {
    const s: RebacSchema = {
      permissions: {
        doc: {
          actions: {
            read: { rule: { field: 'isPublic', operator: Operator.equals, value: true } },
          },
        },
      },
    };
    expect(check(as(null), s, { resource: 'doc', record: { isPublic: true } }, 'read')).toBe(true);
  });

  test('a superadmin passes a person-only rule on any credential', () => {
    const admin: PermixLike = {
      ...as(defineActor({ id: 't1', model: 'Token', principal: { model: 'User', id: 'u1' } })),
      isSuperadmin: () => true,
    };
    expect(check(admin, schema, { resource: 'user', record: { id: 'u1' } }, 'token.create')).toBe(
      true,
    );
  });

  test('a row rule may read the actor, and only widens', () => {
    const closed: RebacSchema = { permissions: { doc: { actions: { read: false } } } };
    const record = {
      id: 'd1',
      permissionRules: {
        read: { actor: { field: 'reviewer', operator: Operator.equals, value: true } },
      },
    };
    const read = (actor: Actor) => check(as(actor), closed, { resource: 'doc', record }, 'read');
    expect(read(defineActor({ id: 'u1', reviewer: true }))).toBe(true);
    expect(read(defineActor({ id: 'u1', reviewer: false }))).toBe(false);
  });
});
