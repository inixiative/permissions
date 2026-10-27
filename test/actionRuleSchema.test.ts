import { describe, expect, it } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { actionRuleSchema } from '../src/actionRuleSchema';

describe('actionRuleSchema', () => {
  it('accepts the rbac/rebac/actor branches', () => {
    expect(actionRuleSchema.safeParse('manage').success).toBe(true);
    expect(actionRuleSchema.safeParse(null).success).toBe(true);
    expect(actionRuleSchema.safeParse({ rel: 'organization', action: 'read' }).success).toBe(true);
  });

  it('composes any/all recursively', () => {
    const rule = {
      any: [{ rel: 'user', action: 'read' }, { all: [{ rel: 'org', action: 'read' }, 'manage'] }],
    };
    expect(actionRuleSchema.safeParse(rule).success).toBe(true);
  });

  it('validates the abac rule branch against json-rules, not a rubber stamp', () => {
    const valid = { rule: { field: 'isPublic', operator: Operator.equals, value: true } };
    expect(actionRuleSchema.safeParse(valid).success).toBe(true);

    // a malformed condition must be rejected — this is what z.unknown() used to wave through
    const garbage = { rule: { operator: 'not-a-real-operator', nonsense: 1 } };
    expect(actionRuleSchema.safeParse(garbage).success).toBe(false);
  });

  it('rejects unknown keys and unknown branch shapes', () => {
    expect(actionRuleSchema.safeParse({ rel: 'org', action: 'read', extra: 1 }).success).toBe(
      false,
    );
    expect(actionRuleSchema.safeParse({ bogus: true }).success).toBe(false);
  });

  it('has no actor arm: who acts is read by a rule, as __actor', () => {
    expect(
      actionRuleSchema.safeParse({ actor: { field: 'kind', operator: 'equals', value: 'person' } })
        .success,
    ).toBe(false);
    expect(
      actionRuleSchema.safeParse({
        rule: { field: '__actor.model', operator: 'equals', value: 'User' },
      }).success,
    ).toBe(true);
  });

  it('rejects a self arm: acting on your own row is a walk to your own entry', () => {
    expect(actionRuleSchema.safeParse({ self: 'userId', action: 'operate' }).success).toBe(false);
    expect(actionRuleSchema.safeParse({ self: 'userId' }).success).toBe(false);
  });

  it('takes positive rules only: a rule passes on what the record carries', () => {
    const leaf = { field: 'role', operator: Operator.equals, value: null };
    expect(actionRuleSchema.safeParse({ rule: leaf }).success).toBe(true);
    for (const rule of [
      { field: 'role', operator: Operator.isEmpty },
      { field: 'type', operator: Operator.notIn, value: ['a'] },
      { if: leaf, then: leaf, else: true },
      { field: 'tags', arrayOperator: 'any', condition: leaf },
    ])
      expect(actionRuleSchema.safeParse({ rule }).success).toBe(false);
  });
});
