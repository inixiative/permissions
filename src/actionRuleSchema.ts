import { z } from 'zod';

/**
 * Recursive Zod validator for a serialized {@link ActionRule}. Use it to validate tenant/row-level
 * permission overrides on save. App adapters typically compose it into a per-model schema keyed by
 * the actions that model actually defines.
 */
export const actionRuleSchema: z.ZodType = z.lazy(() =>
  z.union([
    z.string(), // delegate to another action on the same model
    z.null(),
    z.object({ rel: z.string(), action: z.string() }).strict(),
    z.object({ self: z.string() }).strict(),
    z.object({ rule: z.unknown() }).strict(),
    z.object({ any: z.array(actionRuleSchema) }).strict(),
    z.object({ all: z.array(actionRuleSchema) }).strict(),
  ]),
);
