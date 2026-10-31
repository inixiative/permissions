import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = join(import.meta.dir, '..', 'src');
const filesUnder = (dir: string): string[] =>
  readdirSync(join(src, dir), { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts'))
    .map((file) => join(dir, file));

describe('the core stands alone; helpers are built on it', () => {
  it('no core file imports a helper', () => {
    const importingHelpers = filesUnder('core').filter((file) =>
      /from '\.\.\/helpers\//.test(readFileSync(join(src, file), 'utf8')),
    );
    expect(importingHelpers).toEqual([]);
  });

  it('delegation and hydration are the helpers', () => {
    expect(filesUnder('helpers').sort()).toEqual([
      'helpers/delegation/capAtRole.ts',
      'helpers/delegation/delegate.ts',
      'helpers/delegation/permissions.ts',
      'helpers/delegation/wellFormedEntitlements.ts',
      'helpers/hydration/hydrate.ts',
    ]);
  });
});
