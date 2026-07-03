import { node } from '@inixiative/config/tsup';

export default node({
  // actionRuleSchema is a separate entry so the root import never evaluates zod — zod is an
  // optional peer, only required when the validator subpath is imported.
  entry: ['index.ts', 'actionRuleSchema.ts'],
  minify: true,
  treeshake: true,
  // permix is ESM-only (no `require` condition) — bundle it so our CJS build works; it's small and
  // not part of our public type surface. The rest are CJS-safe and commonly shared, so keep external.
  external: ['@inixiative/json-rules', 'lodash-es', 'zod'],
});
