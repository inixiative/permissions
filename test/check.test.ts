import { describe, expect, test } from 'bun:test';
import { type Bridge, Operator } from '@inixiative/json-rules';
import type { ActionRule, Actor, PermixLike, RebacSchema } from '../index';
import { createRebacCheck } from '../index';
import { mapOf } from './schemaMaps';

// stub permix: no direct grants (forces schema evaluation); optional superadmin + actor id.
const stub = (
  opts: { userId?: string | null; superadmin?: boolean; grant?: string } = {},
): PermixLike => ({
  check: (_resource, action) => action === opts.grant,
  isSuperadmin: () => opts.superadmin ?? false,
  getActor: () => (opts.userId ? { model: 'User', record: { id: opts.userId } } : null),
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
        leave: { rel: 'user', action: 'operate' },
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
  membership: { organization: 'organization', user: 'user' },
};
const check = createRebacCheck(mapOf(relations));

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
    getActor: () => (userId ? { model: 'User', record: { id: userId } } : null),
  });
  const leave = (permix: PermixLike, userId: string) =>
    check(
      permix,
      schema,
      { resource: 'membership', record: { userId, user: { id: userId } } },
      'leave',
    );

  test('your own row is a walk to your own entry: the user relation, then the action there', () => {
    expect(leave(actor('u1', 'own'), 'u1')).toBe(true);
    expect(leave(actor('u1', 'own'), 'u2')).toBe(false);
    expect(leave(actor(null), 'u1')).toBe(false);
  });

  test('the walk follows the user entry’s delegation chain', () => {
    expect(leave(actor('u1', 'operate'), 'u1')).toBe(true);
    expect(leave(actor('u1', 'manage'), 'u1')).toBe(true);
  });

  test('a narrowed actor that lacks the action on itself is refused on its own row', () => {
    expect(leave(actor('u1', 'read'), 'u1')).toBe(false);
    expect(leave(actor('u1'), 'u1')).toBe(false);
  });

  test('any user action works there, custom ones included', () => {
    const s: RebacSchema = {
      permissions: {
        ...schema.permissions,
        membership: { actions: { export: { rel: 'user', action: 'report.export' } } },
      },
    };
    const run = (permix: PermixLike) =>
      check(
        permix,
        s,
        { resource: 'membership', record: { userId: 'u1', user: { id: 'u1' } } },
        'export',
      );
    expect(run(actor('u1', 'report.export'))).toBe(true);
    expect(run(actor('u1', 'own'))).toBe(false);
  });

  test('a row without its user loaded is denied, never guessed from the key', () => {
    expect(
      check(
        actor('u1', 'own'),
        schema,
        { resource: 'membership', record: { userId: 'u1' } },
        'leave',
      ),
    ).toBe(false);
  });

  test('a superadmin passes on anyone’s row', () => {
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
    const noRels = createRebacCheck(mapOf({}));
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

  test('rbac-terminal: walk the bridge to the far row → permix grant on the far resource', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'own' } } },
        'crm:Account': { actions: { own: null } }, // granted only via permix
      },
    };
    const c = createRebacCheck(mapOf({}));
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    const data = { 'crm:Account': [{ id: 'acc1' }, { id: 'other' }] };
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' }, data }, 'read'),
    ).toBe(true);
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', accountId: 'other' }, data },
        'read',
      ),
    ).toBe(false);
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: null }, data }, 'read'),
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
    const c = createRebacCheck(mapOf({}));
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
    const c = createRebacCheck(mapOf({}));
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
    const c = createRebacCheck(mapOf({}));
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
    const c = createRebacCheck(mapOf({}));
    const granted = grantStub({ 'billing:Subscription:own': ['sub1'] });
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', accountId: 'acc1' },
      data: {
        'crm:Account': [{ id: 'acc1', subscriptionId: 'sub1' }],
        'billing:Subscription': [{ id: 'sub1' }],
      },
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
    const c = createRebacCheck(mapOf({}));
    const granted = grantStub({ 'billing:Subscription:own': ['sub1'] });
    // No Account in data → the first hop finds no far row → denied.
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
    const c = createRebacCheck(mapOf({ 'crm:Account': { owner: 'crm:Contact' } }));
    const granted = grantStub({ 'crm:Contact:own': ['c1'] });
    // The far Account is supplied WITH its nested owner — the walk reads current['owner'].
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', accountId: 'acc1' },
      data: { 'crm:Account': [{ id: 'acc1', owner: { id: 'c1' } }] },
    };
    expect(c(granted, s, subject, 'read')).toBe(true);
  });

  test('a post-bridge intra-source rel fails closed when the far record is absent', () => {
    const s: RebacSchema = {
      bridges: oneBridge,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account.owner', action: 'own' } } },
        'crm:Contact': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(mapOf({ 'crm:Account': { owner: 'crm:Contact' } }));
    const granted = grantStub({ 'crm:Contact:own': ['c1'] });
    // No data → no far Account → walk aborts.
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
    const c = createRebacCheck(mapOf({}));
    // The grant is only on `own`; reaching it requires read → manage → own on the far resource.
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    const data = { 'crm:Account': [{ id: 'acc1' }, { id: 'other' }] };
    expect(
      c(granted, s, { resource: 'db:User', record: { id: 'u1', accountId: 'acc1' }, data }, 'read'),
    ).toBe(true);
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', accountId: 'other' }, data },
        'read',
      ),
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
    const c = createRebacCheck(mapOf({}));
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    const data = { 'crm:Account': [{ id: 'acc1' }, { id: 'other' }] };
    // Local rule fails (isAdmin false) but the bridge branch grants.
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', accountId: 'acc1', isAdmin: false }, data },
        'read',
      ),
    ).toBe(true);
    // Neither branch: local false AND the bridge id mismatches.
    expect(
      c(
        granted,
        s,
        { resource: 'db:User', record: { id: 'u1', accountId: 'other', isAdmin: false }, data },
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
    const c = createRebacCheck(mapOf({}));
    const granted = grantStub({ 'crm:Profile:own': ['p1'] });
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', profileId: 'p1' },
      data: { 'crm:Profile': [{ id: 'p1' }] },
    };
    expect(c(granted, s, subject, 'read')).toBe(true);
  });

  test('reverse: crm:Profile → db:User (allowed — oneToOne is to-one both ways)', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'crm:Profile': { actions: { read: { rel: 'db:User', action: 'own' } } },
        'db:User': { actions: { own: null } },
      },
    };
    const c = createRebacCheck(mapOf({}));
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

describe('a bridge on a non-id far key never matches an id-keyed grant by the join value', () => {
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
  const c = createRebacCheck(mapOf({}));
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

describe('an absent far row denies the bridge walk', () => {
  const bridges: Bridge[] = [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'Account', on: 'id' },
        { fieldMap: 'db', model: 'User', on: 'accountId' },
      ],
      cardinality: 'oneToMany',
    },
  ];
  const c = createRebacCheck(mapOf({}));
  const record = { id: 'u1', accountId: 'acc1' };

  test('a negative rule on the far row denies without the row, and judges the row when supplied', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'view' } } },
        'crm:Account': {
          actions: {
            view: { rule: { field: 'status', operator: Operator.notEquals, value: 'blocked' } },
          },
        },
      },
    };
    expect(c(stub(), s, { resource: 'db:User', record }, 'read')).toBe(false);
    const withStatus = (status: string) => ({
      resource: 'db:User',
      record,
      data: { 'crm:Account': [{ id: 'acc1', status }] },
    });
    expect(c(stub(), s, withStatus('active'), 'read')).toBe(true);
    expect(c(stub(), s, withStatus('blocked'), 'read')).toBe(false);
  });

  test('an id-keyed grant on the far record needs the far row, not just the join value', () => {
    const s: RebacSchema = {
      bridges,
      permissions: {
        'db:User': { actions: { read: { rel: 'crm:Account', action: 'own' } } },
        'crm:Account': { actions: { own: null } },
      },
    };
    const granted = grantStub({ 'crm:Account:own': ['acc1'] });
    expect(c(granted, s, { resource: 'db:User', record }, 'read')).toBe(false);
    const subject = { resource: 'db:User', record, data: { 'crm:Account': [{ id: 'acc1' }] } };
    expect(c(granted, s, subject, 'read')).toBe(true);
  });
});

describe('empty combinators follow boolean identity (all([]) = true, any([]) = false)', () => {
  test('an empty `all` is vacuously true (allow) — `true`/allow is a valid permission value', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: { all: [] } } } } };
    const c = createRebacCheck(mapOf({}));
    expect(c(stub(), s, { resource: 'm', record: { id: '1' } }, 'read')).toBe(true);
  });

  test('an empty `any` is false (deny)', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: { any: [] } } } } };
    const c = createRebacCheck(mapOf({}));
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
    const c = createRebacCheck(mapOf({}));
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
          actions: { leave: { rule: { field: 'userId', operator: Operator.equals, value: 'me' } } },
        },
      },
    };
    const c = createRebacCheck<string>(mapOf({}));
    // Duplicate "one"-side (Account.id) rows would make indexBridges throw — but this check
    // resolves on the record and never hops, so the dictionary must never be built.
    const subject = {
      resource: 'db:User',
      record: { id: 'u1', userId: 'me' },
      data: { 'crm:Account': [{ id: 'dup' }, { id: 'dup' }] },
    };
    expect(c(stub({ userId: 'me' }), s, subject, 'leave')).toBe(true);
  });
});

describe('raw boolean ActionRule (true = allow, false = deny; null stays a deny)', () => {
  const c = createRebacCheck(mapOf({}));
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
    const c = createRebacCheck(mapOf({}));
    expect(() => c(stub(), s, { resource: 'm', record: { id: '1' } }, 'read')).toThrow(
      /Cycle detected/,
    );
  });

  test('#2 mutual delegation throws', () => {
    const s: RebacSchema = { permissions: { m: { actions: { read: 'manage', manage: 'read' } } } };
    const c = createRebacCheck(mapOf({}));
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
    const c = createRebacCheck(mapOf({ node: { parent: 'node' } })); // parent → node
    const top = { isOwner: true };
    const mid = { isOwner: false, parent: top };
    const leaf = { isOwner: false, parent: mid };
    expect(c(stub(), s, { resource: 'node', record: leaf }, 'read')).toBe(true);
  });

  test('a genuine relation cycle still throws', () => {
    const s: RebacSchema = {
      permissions: { node: { actions: { read: { rel: 'parent', action: 'read' } } } },
    };
    const c = createRebacCheck(mapOf({ node: { parent: 'node' } }));
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', parent: a };
    a.parent = b;
    expect(() => c(stub(), s, { resource: 'node', record: a }, 'read')).toThrow(/Cycle detected/);
  });
});

describe('the actor is data: a { rule } reads it as __actor', () => {
  const check = createRebacCheck<string>(mapOf({}));
  const as = (actor: Actor | null): PermixLike => ({
    check: () => false,
    isSuperadmin: () => false,
    getActor: () => actor,
  });
  const person: Actor = { model: 'User', record: { id: 'u1' } };
  const token: Actor = { model: 'Token', record: { id: 't1', userId: 'u1' } };
  const schemaOf = (read: ActionRule): RebacSchema => ({
    permissions: { doc: { actions: { read } } },
  });
  const read = (rule: ActionRule, actor: Actor | null, record: Record<string, unknown> = {}) =>
    check(as(actor), schemaOf(rule), { resource: 'doc', record }, 'read');

  test("person-only is a rule on the actor's model", () => {
    const personOnly = {
      rule: { field: '__actor.model', operator: Operator.equals, value: 'User' },
    };
    expect(read(personOnly, person)).toBe(true);
    expect(read(personOnly, token)).toBe(false);
    expect(read(personOnly, null)).toBe(false);
  });

  test("a rule compares the record against the actor's row", () => {
    const mine = {
      rule: { field: 'ownerId', operator: Operator.equals, path: '__actor.record.userId' },
    };
    expect(read(mine, token, { ownerId: 'u1' })).toBe(true);
    expect(read(mine, token, { ownerId: 'u2' })).toBe(false);
  });

  test('with nobody acting, __actor is null and the rule runs as written', () => {
    const notMine = {
      rule: { field: 'ownerId', operator: Operator.notEquals, path: '__actor.record.id' },
    };
    expect(read(notMine, null, { ownerId: 'u1' })).toBe(true);
    const notMineAndActing = {
      rule: {
        all: [
          { field: '__actor', operator: Operator.notEmpty, value: true },
          { field: 'ownerId', operator: Operator.notEquals, path: '__actor.record.id' },
        ],
      },
    };
    expect(read(notMineAndActing, null, { ownerId: 'u1' })).toBe(false);
    expect(read(notMineAndActing, person, { ownerId: 'u2' })).toBe(true);
  });

  test('a superadmin passes', () => {
    const admin: PermixLike = { ...as(token), isSuperadmin: () => true };
    const personOnly = {
      rule: { field: '__actor.model', operator: Operator.equals, value: 'User' },
    };
    expect(check(admin, schemaOf(personOnly), { resource: 'doc', record: {} }, 'read')).toBe(true);
  });

  test('a row rule may read the actor, and only widens', () => {
    const record = {
      id: 'd1',
      permissionRules: {
        read: { rule: { field: '__actor.model', operator: Operator.equals, value: 'User' } },
      },
    };
    expect(read(false, person, record)).toBe(true);
    expect(read(false, token, record)).toBe(false);
  });
});
