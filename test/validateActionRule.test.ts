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
