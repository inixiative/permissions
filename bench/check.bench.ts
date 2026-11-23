import type { EntitlementEntry } from '../index';
import { withExactStrings } from '../src/core/exactStrings';
import { checkWithRules } from '../test/schemaMaps';
import {
  entitlement,
  map,
  model,
  nobody as nobodyTable,
  pool,
  rootOwner,
  schema,
} from './fixtures';
import { measure, report } from './harness';

const check = checkWithRules(map);
const on = (depth: number) => {
  const records = pool(depth);
  return (permix: Parameters<typeof check>[0], action: string) => (i: number) =>
    check(
      permix,
      schema,
      { resource: model(depth), record: records[i % records.length] as never },
      action,
    );
};

console.log(`bun ${Bun.version} · ${process.arch} · ${new Date().toISOString()}`);

const s1 = async () => {
  const owner = await rootOwner();
  const nobody = await nobodyTable();
  const results = [measure('engineGlobals.with alone', () => withExactStrings(() => 1))];
  for (const depth of [0, 1, 2, 4, 6]) {
    results.push(measure(`allow read, ${depth} hops`, on(depth)(owner, 'read')));
    results.push(measure(`deny read, ${depth} hops`, on(depth)(nobody, 'read')));
  }
  report('S1 floor and walk depth (table only)', results);
};

const s2 = async () => {
  const depth = 3;
  const results = [];
  for (const n of [0, 10, 100, 1_000, 10_000]) {
    const owner = await rootOwner();
    const variants: Record<string, (k: number) => EntitlementEntry> = {
      'a: other resources': (k: number) => ({
        resource: 'db:elsewhere',
        anchor: { resource: 'db:elsewhere', id: `e${k}` },
        actions: { read: true },
      }),
      'b: same resource, anchor missed': (k: number) =>
        entitlement(model(depth), `miss${k}`, depth),
      'c: same resource, match last': (k: number) =>
        entitlement(model(depth), k === n - 1 ? 'root' : `miss${k}`, depth),
    };
    for (const [variant, make] of Object.entries(variants)) {
      if (n === 0 && variant !== 'a: other resources') continue;
      const holder = await nobodyTable();
      if (n > 0)
        await holder.setup(
          Array.from({ length: n }, (_, k) => make(k)),
          { owner },
        );
      const samples = n >= 10_000 ? 500 : n >= 1_000 ? 3_000 : 20_000;
      results.push(measure(`${n} held, ${variant}`, on(depth)(holder, 'read'), samples));
    }
  }
  report('S2 entitlements held, read at 3 hops', results);
};

const s3 = async () => {
  const nobody = await nobodyTable();
  const results = [];
  for (const depth of [1, 3, 6]) {
    const records = pool(depth);
    const field = Array.from({ length: depth }, () => 'parent').join('.');
    const ruled: typeof schema = {
      permissions: {
        [model(depth)]: {
          actions: { see: { rule: { field: `${field}.id`, operator: 'equals', value: 'root' } } },
        },
      },
    };
    results.push(
      measure(`rule reads ${depth} hops up`, (i) =>
        check(
          nobody,
          ruled,
          { resource: model(depth), record: records[i % records.length] as never },
          'see',
        ),
      ),
    );
  }
  report('S3 a { rule } over the record (no table, no entitlements)', results);
};

await s1();
await s2();
await s3();
