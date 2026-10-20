import { type Condition, listBindings, validateRule } from '@inixiative/json-rules';
import { z } from 'zod';

// The engine evaluates conditions with no bindings, so a condition naming a bind can never pass.
const condition = z.custom<Condition>(
  (value) => validateRule(value).ok && listBindings(value as Condition).length === 0,
  'invalid json-rules condition (binds are not evaluated: compare against values or paths)',
);

/**
 * Recursive Zod validator for a serialized {@link ActionRule}. Use it to validate row-level
 * permission overrides and rule-valued grants on save. App adapters typically compose it into a
 * per-model schema keyed by the actions that model actually defines.
 *
 * The abac branches delegate to json-rules' own `validateRule` rather than re-modelling the
 * condition grammar in zod — the rule shape stays single-sourced in `@inixiative/json-rules`.
 */
export const actionRuleSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(), // delegate to another action on the same model
    z.boolean(), // terminal allow (true) / deny (false)
    z.null(),
    z.object({ rel: z.string(), action: z.string() }).strict(),
    z.object({ self: z.string(), action: z.string().optional() }).strict(),
    z.object({ rule: condition }).strict(),
    z.object({ actor: condition }).strict(),
    z.object({ any: z.array(actionRuleSchema) }).strict(),
    z.object({ all: z.array(actionRuleSchema) }).strict(),
  ]),
);
