import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import type { PermixLike, RebacSchema, ResolveModel } from '../index';
import { createRebacCheck } from '../index';

// stub permix: no direct grants (forces schema evaluation); optional superadmin + actor id.
const stub = (
  opts: { userId?: string | null; superadmin?: boolean; grant?: string } = {},
): PermixLike => ({
  check: (_resource, action) => action === opts.grant,
  isSuperadmin: () => opts.superadmin ?? false,
  getUserId: () => opts.userId ?? null,
});

const schema: RebacSchema = {
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
};

const relations: Record<string, Record<string, string>> = {
  membership: { organization: 'organization' },
};
const resolveModel: ResolveModel = (model, seg) => relations[model]?.[seg] ?? null;
const check = createRebacCheck(resolveModel);

describe('rebac check', () => {
  test('ABAC { rule } leaf', () => {
    expect(check(stub(), schema, 'organization', { role: 'owner' }, 'own')).toBe(true);
    expect(check(stub(), schema, 'organization', { role: 'member' }, 'own')).toBe(false);
  });

  test('string delegation (read → manage → own/admin)', () => {
    expect(check(stub(), schema, 'organization', { role: 'admin' }, 'read')).toBe(true);
    expect(check(stub(), schema, 'organization', { role: 'member' }, 'read')).toBe(false);
  });

  test('a direct permix grant short-circuits before schema', () => {
    // member would fail the schema rule, but a direct `own` grant from permix wins
    expect(check(stub({ grant: 'own' }), schema, 'organization', { role: 'member' }, 'own')).toBe(
      true,
    );
  });

  test('{ self } matches the actor id', () => {
    expect(check(stub({ userId: 'u1' }), schema, 'membership', { userId: 'u1' }, 'leave')).toBe(
      true,
    );
    expect(check(stub({ userId: 'u1' }), schema, 'membership', { userId: 'u2' }, 'leave')).toBe(
      false,
    );
    expect(check(stub(), schema, 'membership', { userId: 'u1' }, 'leave')).toBe(false);
  });

  test('{ rel, action } walks the relation via resolveModel', () => {
    expect(check(stub(), schema, 'membership', { organization: { role: 'admin' } }, 'manage')).toBe(
      true,
    );
    expect(
      check(stub(), schema, 'membership', { organization: { role: 'member' } }, 'manage'),
    ).toBe(false);
    expect(check(stub(), schema, 'membership', { organization: null }, 'manage')).toBe(false);
  });

  test('resolveModel returning null aborts the walk', () => {
    const noRels = createRebacCheck(() => null);
    expect(
      noRels(stub(), schema, 'membership', { organization: { role: 'admin' } }, 'manage'),
    ).toBe(false);
  });

  test('null is a terminal deny; superadmin bypasses everything', () => {
    expect(check(stub(), schema, 'organization', { role: 'owner' }, null)).toBe(false);
    expect(
      check(stub({ superadmin: true }), schema, 'organization', { role: 'member' }, null),
    ).toBe(true);
  });

  test('per-row permissionRules override is additive (OR)', () => {
    const record = { role: 'member', permissionRules: { own: { rule: true } } };
    expect(check(stub(), schema, 'organization', record, 'own')).toBe(true);
  });
});

describe('cycle detection (regressions for the adversarial findings)', () => {
  test('#2 self-delegation throws instead of looping forever', () => {
    const s: RebacSchema = { m: { actions: { read: 'read' } } };
    const c = createRebacCheck(() => null);
    expect(() => c(stub(), s, 'm', { id: '1' }, 'read')).toThrow(/Cycle detected/);
  });

  test('#2 mutual delegation throws', () => {
    const s: RebacSchema = { m: { actions: { read: 'manage', manage: 'read' } } };
    const c = createRebacCheck(() => null);
    expect(() => c(stub(), s, 'm', { id: '1' }, 'read')).toThrow(/Cycle detected/);
  });

  test('#3 a legal chain of distinct id-LESS records does NOT false-positive a cycle', () => {
    const s: RebacSchema = {
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
    };
    const c = createRebacCheck(() => 'node'); // parent → node
    const top = { isOwner: true }; // no id
    const mid = { isOwner: false, parent: top }; // no id
    const leaf = { isOwner: false, parent: mid }; // no id
    expect(c(stub(), s, 'node', leaf, 'read')).toBe(true);
  });

  test('a genuine relation cycle still throws', () => {
    const s: RebacSchema = { node: { actions: { read: { rel: 'parent', action: 'read' } } } };
    const c = createRebacCheck(() => 'node');
    const a: Record<string, unknown> = { id: 'a' };
    const b: Record<string, unknown> = { id: 'b', parent: a };
    a.parent = b; // a ↔ b, no terminating grant
    expect(() => c(stub(), s, 'node', a, 'read')).toThrow(/Cycle detected/);
  });
});
