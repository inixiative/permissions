import { type Condition, validateRule } from '@inixiative/json-rules';
import { z } from 'zod';

/**
 * Recursive Zod validator for a serialized {@link ActionRule}. Use it to validate tenant/row-level
 * permission overrides on save. App adapters typically compose it into a per-model schema keyed by
 * the actions that model actually defines.
 *
 * The abac `rule` branch delegates to json-rules' own `validateRule` rather than re-modelling the
 * condition grammar in zod — the rule shape stays single-sourced in `@inixiative/json-rules`.
 */
export const actionRuleSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(), // delegate to another action on the same model
    z.null(),
    z.object({ rel: z.string(), action: z.string() }).strict(),
    z.object({ self: z.string() }).strict(),
    z
      .object({
        rule: z.custom<Condition>((v) => validateRule(v).ok, 'invalid json-rules condition'),
      })
      .strict(),
    z.object({ any: z.array(actionRuleSchema) }).strict(),
    z.object({ all: z.array(actionRuleSchema) }).strict(),
  ]),
);
