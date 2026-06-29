import { describe, expect, test } from 'bun:test';
import { type Bridge, Operator } from '@inixiative/json-rules';
import type { PermixLike, RebacSchema, ResolveRelation } from '../index';
import { createRebacCheck } from '../index';

// stub permix: no direct grants (forces schema evaluation); optional superadmin + actor id.
const stub = (
  opts: { userId?: string | null; superadmin?: boolean; grant?: string } = {},
): PermixLike => ({
  check: (_resource, action) => action === opts.grant,
  isSuperadmin: () => opts.superadmin ?? false,
  getUserId: () => opts.userId ?? null,
});

// stub permix that grants specific resource:action to specific ids — for rbac-terminal bridge walks.
const grantStub = (grants: Record<string, string[]>): PermixLike => ({
  check: (resource, action, id) => !!id && (grants[`${resource}:${action}`]?.includes(id) ?? false),
  isSuperadmin: () => false,
  getUserId: () => null,
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
        leave: { self: 'userId' },
        manage: { rel: 'organization', action: 'manage' },
      },
    },
  },
};

const relations: Record<string, Record<string, string>> = {
  membership: { organization: 'organization' },
};
const resolveRelation: ResolveRelation = (resource, seg) => relations[resource]?.[seg] ?? null;
const check = createRebacCheck(resolveRelation);

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

  test('{ self } matches the actor id', () => {
    expect(
      check(
        stub({ userId: 'u1' }),
        schema,
        { resource: 'membership', record: { userId: 'u1' } },
        'leave',
      ),
    ).toBe(true);
    expect(
      check(
        stub({ userId: 'u1' }),
        schema,
        { resource: 'membership', record: { userId: 'u2' } },
        'leave',
      ),
    ).toBe(false);
    expect(
      check(stub(), schema, { resource: 'membership', record: { userId: 'u1' } }, 'leave'),
    ).toBe(false);
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
