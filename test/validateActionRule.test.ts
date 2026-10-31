import { describe, expect, it } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { validateActionRule } from '../index';

const ok = (rule: unknown) => validateActionRule(rule).ok;

describe('validateActionRule: an action rule, checked like json-rules checks a condition', () => {
  it('takes the rbac, rebac and terminal branches', () => {
    expect(ok('manage')).toBe(true);
    expect(ok(null)).toBe(true);
    expect(ok(true)).toBe(true);
    expect(ok({ rel: 'organization', action: 'read' })).toBe(true);
  });

  it('composes any/all recursively', () => {
    expect(
      ok({
        any: [{ rel: 'user', action: 'read' }, { all: [{ rel: 'org', action: 'read' }, 'manage'] }],
      }),
    ).toBe(true);
  });

  it('checks a rule branch with json-rules: positive rules only', () => {
    expect(ok({ rule: { field: 'role', operator: Operator.equals, value: null } })).toBe(true);
    expect(ok({ rule: true })).toBe(true);
    expect(ok({ rule: { operator: 'not-a-real-operator' } })).toBe(false);
    expect(ok({ rule: { field: 'role', operator: Operator.isEmpty } })).toBe(false);
    expect(ok({ rule: { field: 'type', operator: Operator.notIn, value: ['a'] } })).toBe(false);
  });

  it('refuses unknown keys and shapes: no actor arm, no self arm', () => {
    expect(ok({ rel: 'org', action: 'read', extra: 1 })).toBe(false);
    expect(ok({ bogus: true })).toBe(false);
    expect(ok({ actor: { field: 'kind', operator: 'equals', value: 'person' } })).toBe(false);
    expect(ok({ self: 'userId', action: 'operate' })).toBe(false);
    expect(ok(3)).toBe(false);
  });

  it('says where each problem is, as json-rules does', () => {
    const result = validateActionRule({
      any: ['manage', { rule: { field: 'role', operator: Operator.isEmpty } }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.path).toBe('$.any[1].rule');
  });
});

describe('validateActionRule: a rule that delegates back to its own action is a cycle', () => {
  const schema = {
    permissions: {
      doc: { actions: { own: null, manage: 'own', operate: 'manage', read: 'operate' } },
    },
  };
  const at = (action: string, rule: unknown, rowRules?: Record<string, unknown>) =>
    validateActionRule(rule, { schema, resource: 'doc', action, rowRules });

  it('refuses a rule for read that is read', () => {
    expect(at('read', 'read').errors.map((issue) => issue.code)).toEqual(['cycle']);
  });

  it("refuses a cycle through the schema and the record's other rules", () => {
    expect(at('read', { any: ['operate'] }, { operate: 'read' }).ok).toBe(false);
    expect(at('own', { all: ['manage', { rule: true }] }).ok).toBe(false);
  });

  it('accepts delegation that never comes back, and a relation walk, which leaves the record', () => {
    expect(at('read', 'manage').ok).toBe(true);
    expect(at('read', { rel: 'parent', action: 'read' }).ok).toBe(true);
  });
});
