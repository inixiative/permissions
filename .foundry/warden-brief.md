# permissions, for its Wardens

permissions (`@inixiative/permissions`) is a small published Bun/TypeScript package and the
permission primitive behind template, Kingdom, Tribe and transitions. It is one synchronous check
over the app's own hydrated records: role grants, relation walks, json-rules conditions on the
record and the actor, and entitlements backed live by whoever granted them. There is no
authorization store and no database import; it depends only on json-rules and lodash-es.
Decisions about it are recorded in `docs/rules/permissions-and-signets.md` (the docs repo); a
change that contradicts one goes to Aron first.

## Shape of the repository

- One entry, `.` (`index.ts`), built by tsup to `dist/`.
- `src/core`: the algebra (`types.ts`, `algebra.ts`), the walk (`walker.ts`, `evaluate.ts`,
  `entitled.ts`), `check.ts` (`createRebacCheck`, `createRebacPaths`), `grant.ts`, `permix.ts`,
  `schemaMap.ts` (the map index and grant placement), validation, and small pieces (`identity`,
  `recordId`/`engineGlobals`, `exactStrings`, `bridgeHop`).
- `src/helpers`: `delegation/` and `hydration/`. The core never imports a helper
  (`test/layout.test.ts`).
- `test/`: bun tests, named for the behaviour they pin. `bench/`: `bun run bench`.
- Docs: `README.md` and `COMPARISON.md`; `CHANGELOG.md` is history.

## Systems other code depends on

- `createRebacCheck(map)` and `createRebacPaths(map, { limit })` (one walk; paths throws
  `PathLimitError` past 20 admissions by default). An app routes or charges a use by them.
- `createPermissions()`: the permix, its `setup(entries, { owner })` and `setActor`.
- Entitlements `{ resource, anchor: { resource, id, path? }, where?, actions, ref? }`, re-walked
  against their owner on every check.
- `createCanGrantEntitlement(map)` with `placeEntitlement`, and `delegatedWhere`, the one builder of
  a narrowed copy (flat `all`, the held conditions kept whole).
- Rules are positive everywhere: a schema with a negated rule throws on every check.
- `delegate`/`capAtRole`/`permixOf` and `createHydrator`, used by template and Kingdom.
- The engine setting `permissions.idField`.

## Words used here

resource, action, schema, ActionRule, row rule (`permissionRules`), grant, table, permix, actor
(`__actor`), superadmin, entitlement, anchor, path, `where`, owner, `ref`, admission, chain,
placed (pseudo) record, copy, narrowing, liveness, pure delegation, delegate, full, ceiling,
schema map, polymorphism, kind, bridge, hydration.
