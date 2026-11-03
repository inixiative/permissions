import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');

describe('the published types', () => {
  it("carry the engineGlobals augmentation, so a consumer's set('permissions.idField') typechecks", () => {
    const outDir = mkdtempSync(join(tmpdir(), 'permissions-dts-'));
    try {
      const build = Bun.spawnSync(['bunx', 'tsup', '--out-dir', outDir], { cwd: root });
      expect(build.exitCode).toBe(0);
      for (const file of ['index.d.ts', 'index.d.cts']) {
        const dts = readFileSync(join(outDir, file), 'utf8');
        expect(dts).toContain("declare module '@inixiative/json-rules'");
        expect(dts).toContain("'permissions.idField': string");
      }
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
