import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: true,
  treeshake: true,
  outDir: 'dist',
  // permix is ESM-only (no `require` condition) — bundle it so our CJS build works; it's small and
  // not part of our public type surface. The rest are CJS-safe and commonly shared, so keep external.
  external: ['@inixiative/json-rules', 'lodash-es', 'zod'],
});
