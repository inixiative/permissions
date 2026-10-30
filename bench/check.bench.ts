import { createRebacCheck, type EntitlementEntry, type PermissionEntry } from '../index';
import { withExactStrings } from '../src/exactStrings';
import { entitlement, map, model, pool, rootOwner, schema, table } from './fixtures';
import { measure, report } from './harness';

const check = createRebacCheck(map);
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
  const nobody = await table({
    resource: 'elsewhere',
    id: 'x',
    actions: { own: true },
  } as PermissionEntry);
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
        resource: 'elsewhere',
        anchor: { resource: 'elsewhere', id: `e${k}` },
        actions: { read: true },
      }),
      'b: same resource, anchor missed': (k: number) =>
        entitlement(model(depth), `miss${k}`, depth),
      'c: same resource, match last': (k: number) =>
        entitlement(model(depth), k === n - 1 ? 'root' : `miss${k}`, depth),
    };
    for (const [variant, make] of Object.entries(variants)) {
      if (n === 0 && variant !== 'a: other resources') continue;
      const holder = await table({
        resource: 'elsewhere',
        id: 'x',
        actions: { own: true },
      } as PermissionEntry);
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

await s1();
await s2();
