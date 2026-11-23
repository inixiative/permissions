import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as api from '../index';

// One implementation per verb (docs/VERBS.md): each rule names a pattern that is a verb's
// implementation and the only modules allowed to contain it.

const ROOT = join(import.meta.dir, '..');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [relative(ROOT, path)] : [];
  });

const code = (file: string): string =>
  readFileSync(join(ROOT, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const SOURCES = walk(join(ROOT, 'src')).map((file) => ({ file, code: code(file) }));

const RULES: { verb: string; pattern: RegExp; owners: string[] }[] = [
  {
    verb: 'read a model or a field of the schema map (field-map)',
    pattern: /\.(models|fields)\??\.?\[/,
    owners: [],
  },
  {
    verb: 'decide which relations hydration follows',
    pattern: /\.fromFields/,
    owners: ['src/core/relations.ts'],
  },
  {
    verb: 'read a @permissions(...) annotation',
    pattern: /annotations\??\.permissions/,
    owners: ['src/core/relations.ts'],
  },
  {
    verb: 'build a json-rules lens and judge a path against it',
    pattern: /validateRuleInLens\(|walkLensPath\(/,
    owners: ['src/core/lens.ts'],
  },
  {
    verb: 'name a model across maps (json-rules endpointKey)',
    pattern: /`\$\{[^}`]*([mM]ap|fieldMap)[^}`]*\}:\$\{[^}`]+\}`/,
    owners: [],
  },
  {
    verb: 'say which bridges a rule reads and which a rel crosses',
    pattern: /\.bridges\b/,
    owners: ['src/core/supplied.ts', 'src/core/validateSchemaMap.ts', 'src/core/walker.ts'],
  },
  {
    verb: 'freeze, then judge once',
    pattern: /Object\.freeze\(/,
    owners: ['src/core/freezeThenJudgeOnce.ts'],
  },
];

describe('one implementation per verb (docs/VERBS.md)', () => {
  for (const { verb, pattern, owners } of RULES)
    test(`${verb}: only in ${owners.join(', ') || '@inixiative/field-map'}`, () => {
      const elsewhere = SOURCES.filter(
        (source) => !owners.includes(source.file) && pattern.test(source.code),
      ).map((source) => source.file);
      expect(elsewhere).toEqual([]);
    });

  const doc = readFileSync(join(ROOT, 'docs/VERBS.md'), 'utf8');

  test('every exported function is in the verb catalog', () => {
    const exported = Object.keys(api).filter(
      (name) => typeof (api as Record<string, unknown>)[name] === 'function',
    );
    expect(exported.filter((name) => !doc.includes(`\`${name}\``))).toEqual([]);
  });

  test('every name the catalog gives the lens exists in src/core/lens.ts', () => {
    const lens = code('src/core/lens.ts');
    const named = [...doc.split('## The lens, in this library')[1].matchAll(/`(\w+)`/g)]
      .map((match) => match[1])
      .filter((name) => /^(spell|lens|count|issues|why)/.test(name));
    expect(named.filter((name) => !lens.includes(name))).toEqual([]);
  });
});
