import { describe, expect, it } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { actionRuleSchema } from '../src/actionRuleSchema';

describe('actionRuleSchema', () => {
  it('accepts the rbac/rebac/self branches', () => {
    expect(actionRuleSchema.safeParse('manage').success).toBe(true);
    expect(actionRuleSchema.safeParse(null).success).toBe(true);
    expect(actionRuleSchema.safeParse({ rel: 'organization', action: 'read' }).success).toBe(true);
    expect(actionRuleSchema.safeParse({ self: 'userId' }).success).toBe(true);
  });

  it('composes any/all recursively', () => {
    const rule = { any: [{ self: 'userId' }, { all: [{ rel: 'org', action: 'read' }, 'manage'] }] };
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
});
