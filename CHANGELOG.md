## 0.29.0 — `make…` for everything that hands you a function; `bridgeData`; supplied maps are field maps a supplied bridge ends in; a hydrator per field map

Breaking, with no compatibility path (no users).

Why: Aron, 2026-11-23, standardising call sites across the library, transitions, rules-builder
and template: "`make hydrator` gives you a hydrator, and then you run the hydrator. `make check`
gives you a check… If all these things are giving you a thing, then they should be made." And:
"the hydrator shouldn't be doing these checks inside of it… It should just hydrate. The validator
should be doing the validate." And: "The hydrator needs… one field map." On the separate group of
supplied maps: "why is the supplied field map different than field maps?… For me, they're just
field maps… I was hoping that we would make some sort of pseudo-bridge that just lets you jump to
them", and of where such a bridge starts: "it could be from any prefix, so any map… a decoration or
helper for one individual map."

- **`make…`**: `createRebacCheck`, `createRebacPaths`, `createCanGrantEntitlement` and
  `createHydrator` are `makeRebacCheck`, `makeRebacPaths`, `makeCanGrantEntitlement` and
  `makeHydrator`: each returns the function you then call. `createPermissions` keeps its name: it
  builds a permix, not a function.
- **`bridgeData`**: a subject's `data` is `bridgeData` (`{ resource, record, bridgeData? }`): the
  rows of every bridge by `map:Model`, a joined bridge's far rows and each supplied model's row
  (`actor:User`), as json-rules' `recordWithBridgeData` takes them.
- **`schemaMap`, never bare `map`**: the whole object is `schemaMap` in every signature and option
  (`validateActionRule(rule, { schemaMap, resource, action?, rowRules?, additionalRules? })`).
- **Renamed keys**: `maps` is `fieldMaps`, `polymorphism` is `polymorphismRegistries` (keyed by map
  name, each value one map's registry by model name; the type `Polymorphism` is
  `PolymorphismRegistry`), and `validateSchema` is `validateSchemaMap`. `SchemaMapWithoutPermissions`
  and `RecordFieldMaps` are gone.
- **The schema map is `{ fieldMaps, polymorphismRegistries?, bridges?, permissions }`.** `supplied`
  is gone: every field map is in `fieldMaps`. A map is supplied because a declared json-rules
  supplied bridge (one with no `on`) ends in it: its far model's row is given to each check in
  `bridgeData`. The bridge's first endpoint may name only a map (`{ fieldMap: 'db' }`, json-rules
  4.7), meaning every model of that map. A supplied map is a field map a supplied bridge ends in, or
  one joined by key from a supplied map (`actor:User` joined to `sec:Device`). A map that starts a
  supplied bridge or is named in `permissions` holds records and is never taken as supplied. An app
  writes:

  ```ts
  const schemaMap: SchemaMap = {
    fieldMaps: { db: prismaMap, actor: actorMap },
    polymorphismRegistries: { db: polymorphismRegistry },
    bridges: ['Acting', 'User', 'Token'].map((model) => ({
      endpoints: [{ fieldMap: 'db' }, { fieldMap: 'actor', model }],
      cardinality: 'oneToOne',
    })),
    permissions,
  };
  ```

  Each rule has a test in `test/suppliedBridges.test.ts`:
  - a rule on a model reads a supplied model only if a supplied bridge starts from that model or
    from its map; declare another bridge for another map;
  - a supplied bridge may not end in a map of records ("has no join, so its far end is supplied,
    but `actor` holds records (it has rules, or starts a supplied bridge)");
  - a supplied map is not joined to a map of records ("has one end supplied: no chain leads from a
    supplied row into the records");
  - a supplied bridge ends in a declared field map ("ends in the map `nope`, which is not in
    `fieldMaps`");
  - a supplied row is read only by a `{ rule }` at the row the rule is on, never under a relation,
    never by a `where`; a row not given is absent; a record cannot bring its own supplied row; a
    supplied bridge is never crossed by `rel`.

  The library no longer makes a bridge from every resource to every supplied model: a rule reads
  only what a declared supplied bridge gives it. Inside the library the schema map is resolved once
  (`resolvedSchemaMap.ts`) into its record maps, supplied maps, joined bridges and supplied bridges;
  `problemsOfMapNames` and `problemsOfBridges` are in `schemaMapProblems.ts`.
- **The hydrator only hydrates, one field map at a time.** `makeHydrator({ mapName, fieldMap, load })`
  takes one field map and its name; an app with several maps of records makes one hydrator per
  field map. It does not check the schema map's names (a map name that is no name, a polymorphism
  registry naming a missing map or model, a supplied bridge into a map of records):
  `validateSchemaMap` reports those, and building a check (`makeRebacCheck`, `makeRebacPaths`,
  `makeCanGrantEntitlement`) throws the first. It still reads `@permissions` annotations strictly,
  since a `down` it cannot read is a list it cannot load.
- **`makeKindRules({ fieldMaps, polymorphismRegistries, bridges })`** takes the three tables it
  reads; a whole schema map is fine to pass.
- **A hydrator refuses what is not its own.** Asked for a resource of another map, or a model its
  field map does not have, it throws; it used to pass the record through holding whatever rows
  the caller put on it. A `mapName` that is no name throws when the hydrator is made.
- **What `validateSchemaMap` reports of a supplied bridge**: a far end that names no model of its
  map, a first end that names a model its map does not have, and a model both given by a supplied
  bridge and found by key through a joined one. A rule that reads a supplied model where no bridge
  gives it is told so ("no supplied bridge gives `actor:User` at `crm:Account`").
- **A schema map whose key is replaced after a first use is read again.** Replacing
  `schemaMap.permissions`, `bridges`, `fieldMaps` or `polymorphismRegistries` is followed by every
  later call, and by a check made before the replacement.
- **`validateActionRule` reports a resource the schema map does not have**: a name with no map, a
  model its map does not have (an old lowercase `db:inquiry`), or a name that is neither a model
  of a field map nor the far end of a bridge. It used to judge no read there and pass.
- **`suppliedMapNamesOf(schemaMap)`** is exported: the names of the supplied maps, for an editor
  that offers only maps of records as resources.
- Requires `@inixiative/json-rules` ^4.7.0.

## 0.28.0 — one schema map; a resource is `map:Model`; one call validates a stored rule

Breaking, with no compatibility path (no users).

Why: an app held two objects, the schema map and the rebac schema, and the library needed both for
almost anything, so they could be mismatched and every entry point took both. Aron, 2026-11-23,
reviewing template #324: "I don't like having to pass these as separate objects. They should all
just be part of the schema map." The map also carried a `resources` table whose only job was to
rename `db:inquiry` to the model `Inquiry` ("That seems like an absolutely useless thing… make the
whole system use the same casing… whatever we're using in relations"), its supplied maps sat in a
second set beside a lone `fieldMap`, and bridges lived in two lists. A stored rule took two calls to
validate (`validateActionRule`, then `issuesForRuleReadsOutsideLens`), a pairing the check itself
repeated and template wrapped.

- **One object.** `SchemaMap = { maps, supplied?, bridges?, polymorphism?, permissions }`: the field
  maps of the records the app loads (`maps`), the field maps whose rows a check is given
  (`supplied`), both by map name; one list of json-rules `bridges`; `polymorphism` by map name then
  model; and the rules (`permissions`). `RebacSchema`, `resources`, `fieldMap` and the nested
  `supplied: { maps, bridges }` are gone. `SchemaMapWithoutPermissions` is the map before it has
  rules, which `makeKindRules` and every reader of the data shape take.
- **A resource is named `map:Model`**, json-rules' endpoint key, the model spelled as its field map
  spells it (`db:Inquiry`, `actor:User`): in `permissions` keys, `subject.resource`, anchors,
  entries, `data` keys and bridge endpoints. No renaming table. A name with no `map:` throws; a
  name whose map has no such model is a `validateSchema` error (it used to pass as a resource with
  no lens), and as a check's `subject.resource` it throws. A relation leads to the model of its own
  map.
- **Every model of a map in `maps` is a resource.** With the table gone, a model is no longer left
  out by not listing it: a relation to it is followed, loaded and inside the lens. A relation the
  app does not want loaded says so on the field, `/// @permissions(hydrate: false)`, as before.
- `polymorphism` naming a map not in `maps`, or a model its map does not have, throws when the map
  is first used (an entry keyed the old way, by model alone, is caught by this).
- **Every entry point takes the one map**: `createRebacCheck(map)(permix, subject, action)`,
  `createRebacPaths`, `createCanGrantEntitlement(map)(permix, entry, pseudoRecord)`, `validateSchema(map)`,
  `schemaRuleIssues(map)`, `relationHopsFrom(map, at, walked?)`, `reachableFrom`, `capAtRole` and
  `delegate` (each `map` first).
- **`validateActionRule(rule, { map, resource, action?, rowRules?, additionalRules? })` answers what
  a check refuses in one call**: shape and positivity, a delegation back to its own action, and
  every read outside the lens at the resource. `issuesForRuleReadsOutsideLens` is no longer
  exported: a rule kept outside the map (a transition's permission side, a draft) is the same call
  with no `action`. `validateSchema` still reports more than a check refuses (a rule naming an
  action that does not exist, an operator that does not fit its field), each once.
- **One list of bridges, classified by its ends.** Both ends in supplied maps: read by a `{ rule }`
  from a supplied row. Neither end supplied: crossed by a `rel` from a record, and joined. One end
  supplied: refused on first use and by `validateSchema`, joined or not, so no chain leads from a
  supplied row into the records (before, only the stitch refused it).
- A supplied map goes by any name (the reserved `app` is gone); a map name in both `maps` and
  `supplied` throws.
- **Every function takes the whole map.** No function takes a part of it (`Pick<…, 'permissions'>`,
  a field map beside the map it came from). The one exception is `makeKindRules`, which builds rules
  and so takes the map before it has them (`SchemaMapWithoutPermissions`).
- What is wrong with the map's names and bridges is in `validateSchemaMap.ts` (`problemsOfMapNames`,
  `problemsOfBridges`), in the words of `errors.ts`. The index throws the first name problem and the
  check the first bridge problem; `validateSchema` reports them all, where it used to throw on a
  name problem (or pass, when no rule made it index the map).
- `schemaMap.ts` holds the types only. Its jobs moved to `resourceNames.ts`, `relations.ts`,
  `permissionsAnnotation.ts`, `rowKeys.ts`, `pseudoRecords.ts`, `anchorPath.ts` and `whereConjuncts.ts`; cycle detection
  is `issuesOfDelegationBackToOwnAction.ts`.
- `placeEntitlement` and `placeUnder` are `pseudoRecordsOfEntitlement` and `pseudoRecordsBelowAnchor`,
  named for what they return (the README's pseudo record), in `pseudoRecords.ts`; walking a real
  record to its anchor is `anchorPath.ts`. Behaviour unchanged.
- The annotation `/// @permissions(place: true)` is `/// @permissions(pseudoField: true)`: a field a
  grant's `where` may set on a stand-in below the anchor. An app's Prisma schema changes its key.
- The first check freezes `permissions` and `bridges`, not the field maps, which are the app's.
- A stored rule's refusal now reads "stored outside the map is refused".

## 0.27.0 — a null check beside its row's key

Why: 0.26.0 refused every null check, so a schema could not say "a token with no role" or "a
participant who has not left", and apps began testing that in code beside the schema. Aron,
2026-11-22: "If you can't check your roles in the permissions system natively, we've done something
terribly wrong", then "`row exists and key is null` is another valid check." A bare null check
stays refused because it holds on a missing value: a grant's stand-in record, a relation that is not
loaded, a supplied row the call did not give (each a test in `test/nullCheckBesideRowKey.test.ts`).

- **`equals null` and `in` with null are accepted beside an `exists` on the key of the row they
  read**, in the same `{ rule }`: `id` for a column of the record, `org.id` for `org.deletedAt`,
  `actor:Token.id` for a supplied row, the item's key in a list arm's condition. The key is
  `permissions.idField`. One gate (json-rules 4.6 `validateRule(rule, { positive, rowKey })`) for
  the schema's rules, a row's `permissionRules`, `additionalRules` and an entitlement's `where`.
- **It never grants over many records.** `placeEntitlement` leaves the record's own key off every
  stand-in (a `where` that pinned `id`, or a foreign key that is the key, put one there), so the
  grant check denies an action whose rule rests on an empty column unless the entry anchors at the
  record itself.
- Requires `@inixiative/json-rules` ^4.6.0.

## 0.26.0 — supplied maps (who is acting is data the call gives); `load` brings declared lists; `additionalRules`

### Supplied maps: the library supports maps, not actors

Breaking, with no compatibility path (no users).

Why: a `{ rule }` read who is acting as untyped Json under `__actor`, so a typo or a field of the
wrong kind of actor passed and read null. Aron 2026-11-19 asked for an `actor:` prefix over a
json-rules bridge with no join; on 11-21 (R-2026-11-21-07): "The permissions library should just
support maps, and you put a map. If you have actors, you have actors", the engine bridges the data
sent in the call, and "write an existence check for everything that needs to exist". So the actor
is an app's map, not a library concept.

- **`SchemaMap.supplied`**: a json-rules `FieldMapSet` (`{ maps, bridges }`), maps by prefix, whose
  rows each check is given in `subject.data`, keyed `<prefix>:<Model>` beside the joined bridges' far
  rows. A `{ rule }` reads them as `<prefix>:<Model>.<column>` and on along their relations and
  to-one bridges, every chain spelled as a resource's are (no model twice, depth 20). Each model
  is given one row, but the far end of a joined bridge, found by key. Template's `actor` map
  (`Acting.model`, each kind's columns) is one; an app may declare several, or none. Aron 11-21:
  "any sort of part of the map can have bridges to other parts of the map, and they can be
  supplied maps"; "things that are not part of specific bridges need to be supplied, or bridges with
  joins".
- **A list on a supplied row is crossed with the list arm** (`{ rel: 'actor:User.sec:Device',
  arrayOperator: 'any', condition }`), its condition holding rules only; a supplied bridge into the
  map of resources has no endpoint and throws. The joined rows are indexed once per check.
- **The engine fills them** with json-rules 4.4's `recordWithBridgeData` before each `{ rule }`:
  any key naming a supplied model is dropped from every row, and the rows from `data` are put on. `permix.setActor` / `getActor`, `PermixLike.getActor` and the `Actor` type are gone.
- **A match needs `exists` on its field** (json-rules 4.4's positive gate): a field compared with a
  path or bind (`ownerId` with `actor:User.id`), since two missing values match. A comparison with
  a literal needs none; a missing supplied row fails it on its own. `ruleFieldEqualsPath(field,
  path)` writes the match.
- **`makeKindRules(map)`**: the standard polymorphic rules (R-2026-11-19-15), kinds read from the map
  (a resource's polymorphic axis, or a supplied model's enum field): `ruleForEachKind`,
  `ruleKindIsOneOf`, `ruleActionThroughEachKind`, every kind checked by its literal value. A kind the
  map does not have throws when the rule is built.
- **A stored or additional rule the gate refuses throws** (a row's `permissionRules`, an
  `additionalRules` entry), as the schema's does; before, it was dropped without a word.
- **The positive gate refuses a null check** (json-rules 4.3, R-2026-11-19-16). Name the value
  that is there.
- **Typed, at the root.** A model or column a supplied map lacks, a read into its relations, a
  supplied path in a `where`, `org.actor:User`, an enum value outside its enum, and every `__actor.*`
  are refused.
- **The `absent` option is gone.** Under the positive gate, with `exists` beside every match, a
  missing value and a null one give the same answer, so the setting changed
  nothing (the 11-21 review checked every operator); the check uses json-rules' default.
- **`RebacSchema.bridges` is `JoinedBridge[]`** (json-rules 4.3): a supplied bridge is never a
  `{ rel }` hop.
- Peer `@inixiative/json-rules` ^4.4.0.

### `load` brings the lists a resource declares; `loadMany` is gone

**Breaking.** `createHydrator({ map, load })`: `loadMany` is removed, and `load` takes a third
argument, `down`: what the resource being loaded declares with `/// @permissions(down: [...])`,
as its declared lists by list field name, each with the paths under an item as nested relation
names (`{}` when it declares none). `load` returns the row holding every item under each list's
field name, each item holding the row on every declared path. The hydrator knows no ORM;
`prismaIncludeOfDown` turns `down` into a Prisma `include`. `Down`, `DownPaths` and
`PrismaIncludeOfDown` are exported.

- **A list is part of its parent's row.** Wherever the row is reached it carries the same list,
  in the one read of that row. The hydrator reads nothing under an item; it copies each item,
  keeping only its columns and the declared paths, and never changes what `load` returned.
- **The record you pass cannot bring its own list.** The hydrator reads that record's own stored
  row once, by its identity with the values as the record holds them (a to-one that joins on those
  columns shares the read), and takes the lists from it. A record
  with no key yet, **or one `load` does not return, has `[]`**: before, its
  items were read by its key whether or not it was stored.
- **Rows under an item are what `load` returns for the list**, where before each came through
  `load` by itself.
- **A row without a declared list throws** (a `load` that ignores the argument, or a row cached
  before the list was declared), as does an item that is not a row.
- **`hydrationLimits.loads` counts rows**: each `load`, each item and each row under it, wherever
  it appears. The error reads "past N rows".
- **A cache behind `load`** clears the parent's entry when an item or a row under one changes.
- **A bigint key no longer throws** when a row's key is built (`keyFromResourceAndColumns`); before, a
  bigint foreign key on any to-one threw.
- **Why.** A declared list is one jump to explicit leaves, so the tree under it is a finite
  include the declaration already spells (Aron, 2026-11-19: "things that have `down`, the `down`
  should become an include", "load should just also include down"). The per-row reads cost, in
  Zealot, one query plus two cache reads per participant on every check that reached a
  conversation (102 reads at 50 participants, measured 2026-11-19). Zealot is the only app that
  declares a list; template, Kingdom and Tribe declare none and their two-parameter `load` is
  unaffected.

### An app can hand the check more rules for a record

- **`additionalRules`** on `createRebacCheck`, `createRebacPaths` and `createCanGrantEntitlement`: a
  function from a resource and a record to more rule sets (`action → ActionRule`). `check` ORs each
  with the schema rule and the record's own `permissionRules`, where the row rule is merged today.
  It only widens, cannot name an action the schema lacks, and a rule that is not positive, loops or
  reads outside the lens is dropped. `validateActionRule`'s context takes `additionalRules`, so a
  loop through one is a cycle.
- **Why.** A row rule shares one record, and the schema is the same for every tenant. An app that
  lets a tenant open every record it owns needs to pass those rules in. The library still has no
  notion of a tenant: the app decides which rows a record's extra rules come from.

## 0.25.0 — the lenses a rule is judged in are exported

- **`lensesAtRow(map, resource)`** and **`lensesAtListItem(map, resource, field)`** (with the types
  `LensesAtRow`, `PositionUnderListItem`): the json-rules lenses a read is judged in, at a row or at
  an item of a declared list (null when the list is not declared). `validateSchema`'s list arm
  reads `lensesAtListItem`, so there is one way to place a walk under an item.
- **`relationHopsFrom(map, schema, at, walked?)`**, **`declaredListsOf(map, resource)`** and
  **`issuesForRuleReadsOutsideLens`** are exported: the hops a `{ rel }` may take next (to-one
  relations and bridges, each with where it lands), the lists a list arm may cross, and the lens
  issues of a rule outside the schema. `validateSchema` and `relationHopsFrom` share one walk of a
  `{ rel }` path (`walkRelationPath`), so what is offered is what is accepted.
- **Why.** rules-builder's permission builder built its own views of a resource (every column and
  relation, `__actor` on every model, its own `@permissions(down)` parse), which offered paths this
  library refuses (a path back to a model, an undeclared list's item, `__actor` past the row a rule
  is read on). An editor that reads these lenses offers what `validateSchema` accepts and nothing
  else (plan `rules-builder/docs/plans/0.34-computation-and-evaluation.md`).

## 0.24.0 — the schema map is `@inixiative/field-map`'s, on json-rules 4.2

**The change.** `SchemaMap.fieldMap` is a [`@inixiative/field-map`](https://github.com/inixiative/field-map)
`FieldMap`, and every read of it goes through field-map's own-property readers (`modelOf`,
`fieldOf`) and kind tests (`hasColumn`, `isScalarField`). json-rules is `^4.2.0`, which reads the same map as its
`LensFieldMap` with no cast. Pass the map `field-map generate` writes: `fieldMap: prismaMap`.

**Why.** One schema package for every building block (Aron, 2026-11-18; plan
`docs/plans/field-map-package.md` in the inixiative workspace). The map's shape was declared three
times here (json-rules' `FieldMap`, a local `Annotated` for `annotations`, a local `Keyed` for
`isId` and `indexes`) and read by index, so a model or field named after an `Object.prototype`
key resolved. field-map's types carry `isId`, `annotations` and `indexes`, strictly and readonly.

- **`SchemaMap.fieldMap: FieldMap` from field-map**, not json-rules' `LensFieldMap`: the map
  permissions walks is the app's schema. Bridges reach the walk through `schema.bridges`, never as
  fields of the map, so the two branches that looked for a `bridge` field in it are gone.
- **Gone:** the local `fieldOf(map, resource, segment)`, `isColumn` (field-map's `hasColumn`), `Annotated`, `Keyed` and the
  `isId` casts. `docs/VERBS.md` and `test/verbs.test.ts` add the rule: no `.models[...]` or
  `.fields[...]` index read in `src`.
- **A stricter map type.** A scalar's `type` is one of field-map's `SCALAR_TYPES`, and every entry
  is readonly. A generated map passes as is; a hand-written one with a free-form scalar `type`
  stops compiling.
- **json-rules 4.0's lens gate** (a plain path past a to-many relation is refused) changes nothing
  here: the relation lens already spells only to-one chains, and a list is crossed only by the
  list arm. The full check passes unchanged.
- Tests build their maps with field-map's types; `test/fixtures/load.ts` returns a new map instead
  of writing into a readonly entry.
- New dependency: `@inixiative/field-map` `^0.1.0`.

## 0.23.0 — rules are judged in json-rules' own lens, spelled in the root

**The change.** Every path a stored rule reads (a schema rule on first use, a row's
`permissionRules` on each walk, an entitlement `where` when consulted) is judged with json-rules'
`validateRuleInLens` and `walkLensPath`, against an ordinary json-rules `LensNarrowing` per
resource whose `root.relations` spell every chain of to-one relations the hydrator follows. Under
a list item the lens is the rest of the declared `down` paths at each landing. The hydrator loads
every to-one of every row, one object per stored row, so a loop is the real cyclic graph. `check()`
reads the hydrated row itself. README: [What a rule may read](README.md#what-a-rule-may-read-the-relation-lens).

**Why.** Every leak the reviews found was a rule reading something hydration never loaded: a
request body's list read by index or in brackets, a relation keyed on the other side read as null,
a path past the hydrator's cycle cut, a `where` read on a list or on `__actor`, a computed key on a
row reached by `{ rel }`, a schema or a `where` edited after it was judged. json-rules' lens
already judges paths; its own documentation says a model reached another way is spelled under
`root`, and spelled, it holds siblings, refuses lists, made-up keys and unspelled revisits, and
fits Kingdom's 313 rule reads and 368 rel hops.

- **`docs/VERBS.md`**: every operation has one verb, a name that says the action and one owner
  module, enforced by `test/verbs.test.ts` (every exported function is listed; the lens calls, the
  annotation read, the owning-key classification and the freeze each live in one module). Why:
  the lens work's first names (`built`, `anchored`, `explain`, `refuses`, `judgeOnce`) said nothing,
  and unreadable names hide parallel machinery from review. The public name is
  `whyEntitlementWhereLeavesLens`.
- **Limits that throw, never cut.** Chains of at most 20 relations; a row's lens counted one kind
  per false-polymorphic model (Kingdom's largest: 444): `validateSchema` warns over 1,000
  (`warnings`, `countRelationsOneRowHydrates`), building throws over 10,000. A hydration throws past 10,000 loads.
- **A loop made by data denies; it never throws.** Back at the same row and action after a
  relation hop, that branch counts as nothing; with no hop between, it is a schema naming itself
  and throws. The stored copy of the starting record is that record, so a forged root does not
  pass by reaching itself.
- **The caller's record is never registered**: a loop back to it loads the stored row. Under a list
  item only the declared `down` tree exists: every relation field the declaration does not load
  (to-one or list, `hydrate: false` or keyed on the other side) is dropped from an item, whatever
  `loadMany` returned; a declared path is loaded as written, never linked; and a list arm met
  under an item denies, wherever its rule came from.
- **Stored rules are judged at their own resource.** A row's `permissionRules` and an entitlement
  `where` are general rules, valid where the row is reached directly; on a list item what they
  read outside the declaration is unknown, so that arm fails and siblings still decide. The list
  arm's own `condition` keeps the strict check against `down`.
- **The grant check's first pass is main's**: a data loop can place a row above itself (u1 created
  its own org), and the writer holds the action there by the schema.
- **Rows are known by their key**: the engine id field when the model has it and the row a value
  (it is what the app loads by), else the model's id columns (`isId`, or a composite `@@id`), else
  the object (a stand-in). One encoder, `keyFromResourceAndColumns`, keys rows for the hydrator and for identity (a `paths` admission is keyed by its own `JSON.stringify`).
- `validateSchema` reports json-rules' `operator_kind_mismatch` (a check never refuses on it).
  `invalid_value` is left off: it would fail 64 of this repo's tests only because the fixture
  helper types every column `String` (`test/schemaMaps.ts`); the owner decides later.
- The freeze costs about 15% in json-rules' evaluator; it stays.
- The list arm's `arrayOperator === 'any'` guard is gone (a frozen, judged schema cannot carry
  another). The bridge guard and `absent: 'unknown'` under an item stay.
- One anchor-path walk (`rowsAlongAnchorPath`) under `chainOf`, placement and `anchorRowReachedFrom`, the one test that a record's path reaches its anchor (`entitled` and `rowsAbove`);
  one delegation walker (`delegationReach`, with `pureDelegates` or `allDelegates`) replaces the
  cycle test's and `reachableFrom`'s, which is cached per frozen schema.

### Breaking

- `RebacCheck` takes four arguments: the `visited` set is gone (no caller seeded it). An app wrapper that passes it through (Kingdom's and template's `check.ts`) drops the argument.
- A schema that reads outside the lens is refused on first use, `{ rel }` hops included. Kingdom,
  template and Tribe carry one such arm, `integration.integration` in `db:token.create`.
- A rule reads only fields the model has, wherever it came from, a rule passed to `check`
  included (the owner: "we should be using real models and real maps"); declare a computed value
  in the map to read it.
- A path back to a model is refused (`org.creator.org.name`, `rel: 'org.creator'` from a user):
  read it in two hops. An index into a scalar list (`mentions.0`) is refused; use `contains`.
- A schema resource missing from `resources`, and not a bridge's far end, is refused.
- The schema is frozen on first use, an entitlement's `where` when first judged.
- A hydrated record with a cycle is cyclic (`JSON.stringify` throws on it).
- `createHydrator` no longer deletes values under relations it does not follow; it takes
  `(resource, record)`. `ListRelation.paths` is `down` (json-rules' spelling).
  `declarationIssues` and `resolveField` are gone; `whyEntitlementWhereLeavesLens` is new; `validateSchema`
  also returns `warnings`. A `hydrate: false` relation is no anchor-path, `rel` or `rowsAbove` step.
- **`paths` reports the admissions through a node a finished sibling walked.** `visited` holds only
  the nodes on the current path; a finished node used to stay in the map its siblings shared, and
  `entitled` skipped the owner walk that met it again. `paths` may now return more admissions, and
  may reach its limit (`PathLimitError`) where it did not. `check` and the grant check answer as
  before (no difference in 48,000 fuzzed cases).
- **One check answers each node once, past its starting row.** A node reached after a hop (its
  table, row object, resource and action, in its walk mode) is kept when no test in its walk found
  a node on the path, with its footprint, and reused while nothing in the footprint is on the path.
  A denial 6 hops down walks 28 nodes instead of 329. Row keys and a row's own rule verdicts are
  also computed once per row per check. No answer changes.

### Options rejected

- **A second lens in permissions** (the first build: a node graph, a record view, a path walk):
  about 175 lines parallel to json-rules' lens, and each reason given against json-rules failed
  when run.
- **A by-model mode in json-rules** (a model's relations at every visit): not needed; spelling the
  tree in the root does it with json-rules as it is.
- **A projection of the record** (json-rules `projectRows`): with every read judged, no admitted
  read changes under it; it turns Decimals
  into numbers, and costs about 22 ms on Kingdom's largest tree against 0.014 ms for `check`.
- **The actor in a lens field of every model**: it admits `org.__actor.record.id`, which reads
  nothing and passes `equals null`; it is a field of the rule's own row only.
- **Counting every polymorphic arm** in the size limit: a row hydrates one kind; all arms would put
  four Kingdom resources over 1,000.

## 0.22.0 — grants below a held row; a list arm; marks that join a stand-in

Three additions to what a schema and a grant can say, with the adversarial reviews' findings
applied. Each is off until an app uses it; the breaking changes are listed last.

### An entitlement held outright on a record above grants below it

- **The grant check's first pass counts some entitlements.** Before, it was the writer's table
  alone. It now also counts an entitlement the writer holds when the entitlement is marked
  `grantsBelow: true`, has no `where`, and the walk meets it on a real row above the granted
  record: the entry's anchor row (when the entry sits under it by a path) or a row that anchor
  holds under to-one relations that own their key. It then counts as a role on that row would,
  and whoever granted it is judged the same way at every depth. A member holding `operate` on its
  own member row can now grant over its own integrations.
- **Why only an unconditional, unlensed row above the record.** A held `where` would
  be read on today's anchor row and left out of the grant, so the new row would outlive the
  condition under another owner (`manage` on s1 `where label = draft` granting `manage` on the
  integrations of s1). Counting every held entitlement in the first pass reproduced that class;
  this rule excludes anything with a `where`. An entitlement on the granted record itself, or on
  a placed record, never counts, so held entitlements still never combine (R101), are never
  re-anchored to one row (R95), and never stretch to an action that needs more than they hold
  (R99).
- **R103 reversed, for a marked row only.** Holding `manage` on s1 as an entitlement marked
  `grantsBelow` grants `manage` on the integrations of s1. Unmarked, it grants a copy of itself
  and nothing below, as before.
- **`grantsBelow?: true` on an entitlement entry**: the app's statement that nothing narrows the
  row (no lens, in template and Kingdom). Absent, the row never counts in the first pass, so an
  app that does not set it behaves as before: it fails closed. `entitlementProblem` refuses any
  value but `true`, and refuses it beside a `where`. `setup` carries it; a marked row and its
  unmarked twin are two rows and neither covers the other (`coversEntitlement`). No check and no
  `paths` reads it; the second (copy) pass ignores it.
- **Options rejected** for the member case: a plain id-keyed grant (a role-capped token would
  keep it); the user's grant in the member's table (reaches the personal account and other
  memberships); an `id equals id` rule (true for every holder); an actor rule (the grant check
  has no actor); the first pass counting every held entitlement, the wide walk of #28 (unsound
  with a `where`, above).

### A list the walk may cross: `{ rel, arrayOperator: 'any', condition }`

- **The list arm.** A rule passes when `condition`, an action rule judged on each item as the
  item's own resource, passes on some item of a declared list relation. It is json-rules' array
  condition with `field` renamed `rel`; the third key is `condition` because `rule` already means
  a json-rules condition here. Why: a chat rule ("you are one of the participants") had been
  written as a json-rules array condition inside `{ rule }`, which "no negative rules" refuses
  and which judges whoever is asking, never an entitlement's grantor.
- **`/// @permissions(down: [a.b, a.c])` on the list field** declares it: the dotted to-one paths
  loaded under each item, leaves by their full path. A list that is not declared is never
  crossed. `createHydrator` takes `loadMany` and loads a declared list wherever its model is
  hydrated: one read of the items, then only the declared paths under each. Nothing else loads
  from an item, so loading never backtracks.
- **Only `any`.** Every other array operator holds on a list with no rows or counts them; they
  are refused by name (`arrayOperator`).
- **Never on a stand-in.** A placed record has no lists and a `where` cannot pin one, so a grant
  that rests on a list is anchored where a real list is.
- **Declared leaves: the declaration carries what the rule walks.** Every relation a rule walks or
  reads under an item, followed through the actions it lands on, must be inside a declared path.
  `validateSchema` reports it (code `down`) and a check now refuses such a schema on first use,
  so the two agree. Why this way round: with a shorter declaration an action answers for a person
  whose table holds an id-keyed grant on the landing row and denies for one who has it through
  the rule, though the same action on the same row passes when hydrated from above. An action
  the table alone answers needs only the row it is granted on. `declarationIssues(map, schema)`
  is exported.
- **From the review** (each with a test that fails without it):
  - *A-1.* The hydrator owns every to-one relation and declared list: the result holds the row it loaded, or
    nothing. Before, a value already on the record survived when the key was missing or loaded
    nothing, so a request body's `conversation: { participants: [...] }` was walked as a
    membership claim.
  - *A-2.* Under an item the check reads with `absent: 'unknown'`: a field the item does not
    carry never passes `equals null`. Before, a member who left, loaded without `leftAt`, counted
    as present, and a read through a relation nothing loaded passed.
  - *A-3.* The engine denies a second list, and a bridge, under an item, whatever the record
    holds. Before, only `validateSchema` and the hydrator kept "one jump".
  - *A-4.* In the grant check's first pass nothing met under an item counts. Before, a row that
    was both above the record and under an item counted or not by object identity.
  - *A-5.* A `where` pins scalar values only, on fields that are not relations or lists. Before,
    `conversation equals { participants: [...] }` put a list on a stand-in inside a to-one.
- `validateSchema`: a `{ rel }` segment that is a list is an error, declared or not (it used to
  validate and deny forever); a `{ rule }` under an item that reads through a relation outside
  the map is reported; a bridge under an item is refused with its own message.
- **Options rejected:** a plain `rel` through a list (one spelling for "the parent" and "some
  item"); the json-rules array condition inside `{ rule }` (above); deriving what to load from
  the rules (rules also live on rows and entitlements; a written declaration is explicit).

### Marks: `/// @permissions(place: true)`

- **A marked scalar joins the stand-in.** When an entry's `where` has a root leaf `<path to the
  stand-in>.<field> equals <literal>`, `placeUnder` builds that stand-in with the value, at any
  depth below the anchor. Why: a rule that reads a type field one level down
  (`integrationResource.kind`) found it unknown on a placed record, so an app had to copy the
  field onto the root model (`resourceKind`, `resourceEnabled`) and keep the copies true.
- **Sound because the leaf stays on the row**: it is required of every copy and judged on the
  real record at read. Root conjuncts, literal `equals`, scalar values, the entry's own path
  only; never the anchor or a row above it; the path's keys and kind win.
- **Refused** on an id, a relation key, a discriminator, a list, a relation, and any scalar but
  String, Int and Boolean; enums are allowed.
- **From the review, B-1.** A field two root leaves state with different values is left unknown,
  for a mark and for a root pin. Before, the last conjunct won, so
  `all[kind = user, kind = channel]` was granted and the same row with the two swapped refused.
- **Options rejected:** inferring the fields from the rules (too hard to know
  which belong, and rules also live on rows); filling every nested `equals` (a key, an id or a
  date stated in a `where` would be believed on a record nobody loaded).

### Breaking

- **`@permissions(...)` is read strictly** when a map is first used: an unknown key, an empty
  annotation, a malformed `down` or `place`, or `down` beside `hydrate: false` throws. prisma-map
  keeps a malformed value without complaint, so a typo was a silently missing list or mark.
  Annotations on models that are not resources are not read.
- **`createHydrator` drops a value it did not load** from every to-one relation of the model,
  followed or not, and from every declared list (A-1): a `rel` through a relation nothing loads
  denies. Hydrate rows; attach a hand-made to-one relation after hydrating. A list that is not
  declared is left as given, since no `rel` crosses it. A `{ rule }` or a `where` can still read
  into one by field path (`messages.0.id`, `notEmpty`), and reads scalars and `permissionRules`
  as given: hydration protects relations only. A map that declares a list needs `loadMany`.
- **A `where` no longer pins an object or an array** onto the placed record (A-5), nor a field
  stated with two different values (B-1). A pin on a relation admitted nothing at read, so
  only a dead grant is lost there. **A pin on a Json column or a scalar list (`String[]`) was a
  live row and is now refused at grant time.**
- **`validateSchema` reports a `{ rel }` through a list.**
- **`createCanGrantEntitlement(map)` takes the map alone.** Its `options` argument is removed:
  the first pass always read absent fields as unknown.
- **Under a list item, a to-one relation outside the declared paths ends empty**, as under any
  hydrated row.

## 0.22.0 — delegatedWhere; no negative rules; a where never takes part in liveness

- **`delegatedWhere(held, ...added)`**: the `where` of a grant passed on from a held one: `all` of
  the added conditions, then the held `where`'s conjuncts, flat and each kept whole (one conjunct
  comes back alone). A narrower list sits beside the held one: `all[ in [A], in [A, B] ]`.
- **Breaking: negated rules are refused on every check.** A schema is judged whole on first use
  and a check throws when any of its rules, or a rule passed to the check, is one
  `validateActionRule` refuses. A negated rule passes on a field the record lacks, so in the grant
  walk it let a writer grant what it cannot do. Write rules positively.
- **Breaking: the grant check's liveness walk consults no entitlement `where`.** Passing on a
  copy still asks that the held entitlement's granter holds the action, with its anchor reached
  from the placed record at every link, but a `where` is judged by structure alone. A list pin
  (`id in [A, B]`) now passes on at any depth; before, the granter's `in` could not hold on a
  placed record whose id is unknown. It also means a granter limited only by a `where` counts as
  live for records outside it at grant time; reads still apply every `where` on the chain.
- `conjuncts` accepts `null`.

## 0.22.0 — every path a check is admitted along

- **`createRebacPaths(map, { limit })`**: the walk `check` runs, without stopping at the first
  admission. It returns every way the check is admitted, once each, as the chains of entitlement
  `ref`s it stands on, holder first (`null` for an entitlement without a `ref`). It is non-empty
  exactly when `check` is true; a loop `paths` reaches past an admission adds nothing instead of
  throwing. More than `limit` admissions (default 20) throws `PathLimitError`. The order is
  deterministic, not setup order.
- **`ref` on an entitlement entry**: the app's id for its row, reported by `paths`. It is not part
  of what the entry grants; `entitlementProblem` refuses an empty one. Rows alike but for their
  `ref` are both kept.
- **`installPermissions` / `permixOf` build an owner once per install** when the same
  `Permissions` object is reached more than once, so a diamond is not rebuilt per path. A loop in
  the permissions data now settles (that edge backs nothing) instead of never resolving.

## 0.21.1 — the idField setting reaches consumers' types

- **Fix: the published `index.d.ts` / `index.d.cts` now carry the `EngineGlobalValues`
  augmentation**, so `engineGlobals.set('permissions.idField', 'uuid')` typechecks in a consumer
  without redeclaring the key. The d.ts bundler dropped it because it sat in a module none of whose
  exports were public; it now lives in `src/core/engineGlobals.ts`, which the index reaches through
  the new `PermissionsEngineGlobals` type.

## 0.21.0 — the hydrator walks the map, nothing else

- **Breaking: `createHydrator` no longer takes `schema`, and `walkedRelations` is gone.** The
  hydrator loads every to-one relation the map gives it, as before 0.20; skip an edge with
  `/// @permissions(hydrate: false)` (prisma-map 0.4.1 reads it on Prisma 6 too). `validateSchema`
  stays.

## 0.20.0 — the hydrator loads what the rules walk; validateSchema

- **`createHydrator({ map, load, schema })`**: given the schema, only the relations its rules walk
  are loaded — each `{ rel }` path's segments, the relations a `{ rule }` reads a field through
  (json-rules' `listFields`), and whatever a record's own `permissionRules` walk. Without `schema`
  it loads every to-one relation, as before. An entitlement's anchor path is not in the schema, so a
  consumer checking entitlements hydrates without it.
- **`validateSchema(map, schema)`**: every action rule well formed and positive, every `{ rel }`
  segment a relation or a bridge, every action a rule names defined where it lands. A rule naming a
  relation the map doesn't have otherwise denies forever without saying why; run it in a test or at
  boot.
- **`walkedRelations(map, schema)`**: the relations a schema walks, by resource.
- Requires `@inixiative/json-rules` ^3.18.

## 0.19.0 — the identifier is an engine setting

- **`permissions.idField`** in json-rules' `engineGlobals` (3.17, the one engine interaction point)
  names the field a record's grants are keyed by: `id` unless the app sets another (`uuid`, `_id`,
  `ID`). The direct grant probe, an entitlement's anchor match, `placeEntitlement` and the
  hydrator's fallback target column all read it. A record without the field has no id, so only
  resource-wide grants reach it. Set it once at boot:
  `engineGlobals.set('permissions.idField', 'uuid')`, or scope it with `engineGlobals.with`.
- Requires `@inixiative/json-rules` ^3.17.

## 0.18.0 — stored rules the core refuses widen nothing

- **`check` validates a record's `permissionRules` entry before ORing it in.** A row rule that isn't positive, or that delegates back to its own action, widens nothing; it never throws. Before, `{ read: 'read' }` stored on a record threw "Cycle detected" on every check of it, and a negated condition widened as written.
- **`validateActionRule(rule, context?)`** takes `{ schema, resource, action, rowRules? }` and refuses a cycle: a rule that comes back to its own action through the schema or the record's other rules.

## 0.17.1 — core and helpers

- **`src/core` and `src/helpers`.** The core (the algebra, `check`, the permix, entitlements, the grant check, validation) never imports a helper; `test/layout.test.ts` enforces it. Delegation (`delegate`, `capAtRole`, `installPermissions`, `permixOf`, `wellFormedEntitlements`) and hydration (`createHydrator`) are helpers. Exports are unchanged.
- **Docs.** README: why this one, a comparison table, core and helpers, a vocabulary, the 1.0 roadmap (reflection to Prisma and SQL by the end of 2026). New `COMPARISON.md` with sources.

## 0.17.0 — delegate resolution

- **Passing on a held entitlement asks its grantor about the action being granted (R111).** Holding `manage` by entitlement while the grantor is down to `read`, you may still pass on `read`, exactly as you may still use it; `manage` stays refused. Before, any grantor loss froze the whole entitlement for passing on.
- **`delegate(schema, owner, { full?, ceiling?, entitlements? })`** resolves a delegate's permissions from its owner's: `full` is the owner's permissions whole (its entitlements included); otherwise the owner's role grants capped at the ceiling (none without one; the owner's entitlements never) plus the delegate's entitlements backed by the owner's permissions. Nothing set is the empty permissions. Delegates chain (a token on an integration of a member). Who may set `full` stays app policy.
- **`Permissions`**, permissions as data (`{ entries, owner? }[]`), with `installPermissions(permix, permissions)` and `permixOf(permissions)`.
- **`capAtRole(schema, entry, ceiling)`** keeps an entry at a ceiling — the action the delegate's role maps to — by the schema's pure-delegation chain; no role ladder.
- **`wellFormedEntitlements(value)`** keeps a stored value's well-formed, non-redundant entitlement entries.
- README § Delegation: full or specified.

## 0.16.0 — the hydrator walks the schema map

- **Breaking: `createHydrator({ map, load })`.** It takes the schema map the checks walk instead of a `parents` function, and `load(resource, where)` instead of `load(model, id)`. It follows every to-one relation that owns its foreign key and leads to a resource in the map, loads composite keys and non-id targets by every column the target names, gives a polymorphic record every relation whose columns are set, and skips a relation tagged `/// @permissions(hydrate: false)`. Cycles are still cut by the ancestors on the path. `ParentRelation` is gone.

## 0.15.0 — entitlements indexed, duplicates collide at setup, a performance bench

- **Entitlements are indexed by resource and action at `setup`.** A check no longer scans every held entitlement: holding 10,000 on other resources costs the same as holding none (2.7 ms → 21 µs per refused check at 3 hops), and on the same resource it is about twice as fast. Same results, same order.
- **A duplicate entitlement is a no-op at `setup`:** one the holder already holds from the same owner, identical or with fewer actions, is skipped. `coversEntitlement(held, entry)` and `withoutRedundantEntitlements(entries)` apply the rule to a list before it is stored.
- **`bun run bench`** (`bench/`): check cost by walk depth and by entitlements held; README § Performance.
- Tests: boundary scenarios (agent vs licensee, sublicense chains, cycles, two distributors, License rows).

## 0.14.0 — a grant is the writer's table without an actor, or one held entitlement passed on whole

- **Breaking: `canGrantEntitlement` runs in two passes.** First the writer's table, with no entitlements and no actor: a rule that needs an actor never grants, so person-only actions are not grantable. Failing it, the entry may be one entitlement the writer holds, passed on whole (held entitlements never combine): same resource and anchor, each action held or reached by pure delegation (holding `manage` grants `read`), the held `where` copied or narrowed, and its granter still backing the held action on the placed record.
- **Breaking: an entitlement must grant at least one action;** `setup` and `placeEntitlement` refuse one that grants none.
- **Breaking: `placeUnder(map, resource, path, anchorResource, anchor, where?)`** takes a `where` instead of `pins`, and narrows the first step's kinds by it the same way a grant does.
- **An entitlement answers every action it implies,** and its owner is re-walked on the action asked, not the one held: a `manage` entitlement whose granter is down to `read` still reads, across every side of a chain.
- `reachableFrom(schema, resource, action)` is exported: the actions whose holding grants `action` by pure delegation.
- Rules evaluate with exact strings whatever the app's json-rules globals say, so grant time and read time agree.

## 0.13.1 — `entitlementProblem` is exported

- `entitlementProblem(entry)`: what is wrong with an entitlement entry, or `null` — the rules `setup` and `placeEntitlement` already apply, for an app that filters stored entries before installing them.

## 0.13.0 — the root of the where narrows the kinds

- **A grant's kinds are narrowed by the `where`'s root leaves on the kind field, each checked with json-rules** on each kind the path's first step admits: the `where` itself, or each leaf of its top `all`, with a literal `value`. `ownerModel in [Organization, Space]` now keeps those two kinds (before, only `equals` narrowed). Leaves on other fields (dotted ones included), leaves reading a path, and nested rules narrow nothing.

## 0.12.1 — a path names its anchor and axis; every kind on it is judged

- **Breaking: a polymorphic step admits every kind that carries its keys**, not one: `organization` on an integration reaches the organization's own, a space's, a member's and a space member's integrations. The `where` narrows them (`ownerModel equals Organization`). Sides stay distinct axes (`targetOrganization` vs `sourceOrganization`).
- **Breaking: `placeEntitlement` returns `Row[] | null`**, one pseudo record per admitted kind, each with its owner placed under the anchor along every relation that leads there (a kind whose owner can't be placed keeps its record, owner unknown, so it is refused rather than skipped); the writer must pass on every one. Null for a malformed entry (the rules `setup` refuses at install), a foreign anchor, or a path that reaches nothing.
- **`placeUnder(map, resource, path, anchorResource, anchor, pins?)`** returns the records of `resource` under a hydrated anchor along a path (known foreign keys, composite ones too, the admitted kinds narrowed by `pins`); what an app uses to place a record it is about to create.

## 0.11.1 — the walk reads the map

- Internal: a check's walk reads relations from the schema map directly; no derived resolver beside it. No behaviour change.

## 0.11.0 — the library reads the schema map

- **Breaking: `createRebacCheck(map)` and `createCanGrantEntitlement(map)` take a `SchemaMap`** — `{ resources, fieldMap, polymorphism? }`: which `fieldMap` model each resource is, its relations and foreign keys (a json-rules `FieldMap`, structurally a prisma-map), and the polymorphic models' kinds (a false-polymorphism registry). The `resolveRelation` callback is gone.
- **Each polymorphic step of an anchor's path names one kind.** A relation's foreign key columns pick the kind; the step passes only when the record is that kind. `organization` reaches an organization's own integrations, not its spaces' (which carry `organizationId` too).
- **`placeEntitlement(map, entry, anchor)`** builds the grant's pseudo record from the hydrated anchor down the path (foreign keys, kinds, the where's exact values; the path wins over a pinned foreign key). The app no longer places.
- An anchor path follows to-one relations that own their foreign key (`fromFields`); a back-relation no longer reaches an anchor.
- `createRebacCheck` indexes the map once and refuses two resources on one model.
- Migration: build a `SchemaMap` from your prisma map and registry; replace app-side placement with `placeEntitlement`.

## 0.10.0 — the anchor carries its path

- **Breaking: an anchor on another resource needs `path`**, the relations from the record up to the anchor (`'space.organization'`); a record anchored at itself has none. `setup` refuses either mismatch. An entitlement applies when the hydrated record at the end of the path is the anchor, its `where` holds, and its owner allows the action on the record. Only the anchor's id is fixed, so a record that moves inside the anchor stays reached; the path picks the side of a two-parent record; a list relation reaches nothing.
- **The action is checked on the record again**, not asked of the anchor (0.9.3's anchor walk is gone, with `fromAnchor`). The grant check is the writer's check on `placed` only.
- Migration: give every non-self anchor its `path`.

## 0.9.3 — an entitlement is assessed from its anchor

- **Breaking: the library checks `anchor` again, with nothing from the app.** An entitlement applies to a record when the normal walk from the record passes for a holder whose only grant is the entitlement's actions on the anchor record, its `where` holds, and its owner allows the action on the record. The schema says how far an action at the anchor reaches; no callback, no ownership convention. The grant check requires the same on `placed`. `Entitlement` carries its `actions`.
- Migration: stop folding the anchor into `where` (0.9.2); install entries as stored.

## 0.9.2 — no anchor matching, no Zod

- **Breaking: the library does not read `anchor`.** `directOwner`, `onPath` and the `DirectOwner` type are gone, and so is the grant check's anchor test. An entitlement applies when its `where` holds and its owner still allows the action; the app folds where the entitlement sits into its `where` at install (the anchor row itself: `id equals`; a record under it: the columns that place it there) and refuses an anchor it cannot place under.
- **Breaking: `actionRuleSchema` and the `./actionRuleSchema` entry are gone, and Zod is no longer a peer.** `validateActionRule(rule)` checks an action rule's shape and every `{ rule }` as a positive json-rules condition, returning json-rules' `{ ok, errors }`.
- Migration: drop `directOwner` from both factories; add the anchor's placement to each entitlement's `where` before `setup`; validate stored action rules with `validateActionRule` where you validated with `actionRuleSchema`.

## 0.9.1 — actionRuleSchema serializes

- **Fix: `actionRuleSchema`'s `rule` branch is a boolean or an object refined by json-rules `validateRule(…, { positive: true })`**, not a `z.custom`, so OpenAPI and JSON Schema generators can describe it. Validation is unchanged.

## 0.9.0 — anchors at the direct owner, positive rules, unknown on the placed record

- **Breaking: an entitlement acts at its `anchor`: the record itself or the record's direct owner.** `createRebacCheck(resolveRelation, { directOwner })` and `createCanGrantEntitlement(resolveRelation, { directOwner })` take `directOwner(resource, record) => Anchor | null`, the app's tenancy tree. The rules-derived ancestor walk (`parentFields`, `pathTo`) is gone: an anchor two levels up no longer reaches, reach further down comes from the schema walk. Without `directOwner`, only an anchor on the record itself applies.
- **Breaking: `canGrantEntitlement(permix, schema, entry, placed)` takes the pseudo record the app placed at the anchor**, with the values the entry's `where` pins exactly, and refuses one not at the anchor. The library builds no record.
- **Breaking: the grant check reads `placed` with json-rules `absent: 'unknown'`.** A field the placed record does not carry fails every positive leaf (`equals null` included: `null === null`, `undefined` is not null), so a writer whose authority reads a field the `where` leaves open is refused. Run-time checks are unchanged: a missing path still reads as null. `CheckOptions.absent` sets it for a check you build.
- **Breaking: rules are positive.** `actionRuleSchema` and an entitlement's `where` at setup refuse the negations, `isEmpty`, `notExists`, `if`/`then`/`else`, array and aggregate rules (json-rules `validateRule(rule, { positive: true })`). "No value" is `equals null`.
- Requires `@inixiative/json-rules` 3.11.0.
- Migration: pass `directOwner` to both factories; anchor every entitlement at the record or its direct owner; build `placed` with the `where`'s `equals` values; rewrite negated rules and `where`s positively (`notIn X` → `in` the rest, `isEmpty` → `equals null`).

## 0.8.0 — an entitlement acts from an anchor

- **Breaking: an entitlement's `from` is `anchor`**, and the `Position` type is `Anchor`: `{ resource, anchor: { resource, id }, where?, actions }`. `canGrantEntitlement(permix, schema, entry, anchor)` takes the hydrated anchor record. Setup's refusals name `anchor`. No behaviour change.
- **Removed: the conditional-entitlement clause in `canGrantEntitlement`.** A writer grants an action iff it could take that action on the stand-in record under the anchor through the normal check. The extra demand that a rule-gated action (a `{ rule }` on the record or on `__actor`) also needs every terminal action of the resource, and on a resource without one a superadmin, is gone: its premise was false. The holder's read runs the action through the writer's walk on the real record with the request's actor, so the rule's conditions hold at read time. A manager now grants a rule-gated `assign` and its holder reaches exactly the manager's reach.
- **Breaking: a bridge hop to an absent far row denies.** The engine no longer stands in `{ [farOn]: joinValue }` for a far row missing from `subject.data`: the walk returns false, whatever the far action is. A rule on the far row is judged only against the row (a negation such as `status notEquals 'blocked'` no longer passes on missing data), and an rbac grant keyed by the far record's id needs that row in `subject.data` too. With the row supplied, decisions are unchanged.
- **Breaking: `where: null` is refused at setup.** It was accepted and denied at check. `EntitlementEntry.where` and `Entitlement.where` are `Condition`, no longer `Condition | null`; omit `where` for none.
- Migration: rename `from` to `anchor` in every entitlement entry and in stored entitlement rows; `Position` → `Anchor`. Supply every far row a bridge walk crosses in `subject.data`. Drop `where: null` from entitlement entries and stored rows.

## 0.7.0 — no self arm

- **Breaking: the `{ self, action }` arm and `createRebacCheck`'s `selfResource` option are gone.** Identity is not read from the actor. Acting on your own row is a walk to your own entry: `{ rel: 'user', action }` on a row hydrated with its `user`, where the actor's table holds its grants on that user. A row without the relation loaded is denied, never guessed from the key. `actionRuleSchema` rejects `self`.
- **New: `createCanGrantEntitlement(resolveRelation)`.** A grant is an action: `canGrantEntitlement(permix, schema, entry, position)` holds when the writer's table (its grants, its own entitlements, its actor) could take every action the entry names, judged through the normal check on a stand-in record of `entry.resource` placed under `position` along the resource's own `rel` tree. A `where` only narrows and is not consulted. An action whose rule carries ABAC (a `rule` or `actor` condition, here or in a same-resource action it delegates to) is a conditional entitlement: its holder would skip the condition, so it is granted at its strongest: the writer must also hold the resource's terminal (`null`) actions, and on a resource without one only a superadmin grants it. A position off the tree, or not the record `from` names, grants nothing.
- **Breaking: the actor is `{ model, record }`, read by a plain `{ rule }` as `__actor`.** The `{ actor }` arm and `actor.<field>` binds are gone: `{ actor: C }` becomes `{ rule: C' }` with fields prefixed `__actor.` (`model`, `record.*`), and `bind: 'actor.x'` becomes `path: '__actor.record.x'`. With nobody acting, `__actor` is null and the rule runs as written; a rule that needs an actor says so.
- **Removed: the `where` bind guard.** The library does no binding (paths only); a bind in a `where` fails in json-rules like any unbound bind.
- Migration: replace every `{ self: '<fk>', action }` with `{ rel: '<relation the fk points at>', action }`, hydrate that relation on the records you check, and drop `{ selfResource }` from `createRebacCheck`. The actor keeps `id` and whatever meta `{ actor }` arms read.

## 0.6.0 — entitlements

- **New: entitlements.** A `setup` entry may be `{ resource, from: { resource, id }, where?, actions }`, installed with `setup(entries, { owner })` where `owner` is the table of whoever granted it. Entitlements live beside the table, never in it. The engine consults them at a node after the table and the schema rule both miss: one applies when `from` is on the record's natural tree (the resource's own `rel` relations), `where` holds (plain json-rules over the record at that node, no binds), and the owner's table, walked from that record through the normal schema, allows the action. Tenancy is live with no fetch; owners nest; a holder never exceeds its owner on the same record and action; `{ actor }` and `{ self }` arms inside the owner's walk see the request's actor.
- `PermixLike` gains optional `entitlements(resource, action)`; the wrapper's `Permix` has it. `PermissionEntry` is now `GrantEntry | EntitlementEntry`; `SetupOptions` gains `owner`. `replace: true` clears entitlements too. `getJSON` carries grants only.
- `setup` validates before touching state and refuses: an entitlement without `owner`, `where` without `from`, `id` with `from`, a non-boolean entitlement action, a `where` with a bind or one `validateRule` rejects.
- Cycle keys include the table being walked. A loop built from grant data denies instead of throwing; schema loops still throw.
- **Removed:** the unused `Entitlements` type (`Record<string, boolean> | null`).

## 0.5.0 — the actor carries meta; self names its action

- **Breaking: `setUserId`/`getUserId` become `setActor`/`getActor`.** The actor is `{ id, ...meta }`: plain data about who is acting (kind of principal, bound integration, …). `PermixLike` exposes `getActor`. `{ self }` reads `actor.id`.
- **New `{ actor: Condition }` arm:** a json-rules predicate over the actor itself (e.g. only a person may create tokens).
- **`{ rule }` binds the actor:** a record predicate may compare against `{ bind: 'actor.<field>' }`. With nobody acting, a rule that binds an actor field denies; an actor missing a bound field throws.
- `actionRuleSchema` accepts the `actor` arm.

- **Breaking: `{ self }` becomes `{ self, action }`.** A self arm passes only when `record[self]` is the actor's id **and** the actor holds `action` on its own entry, evaluated through the schema on the `selfResource` (so delegation chains and custom actions apply). Before, a self arm passed on identity alone, so a narrowed credential (one holding only `read` on its user) could still leave, delete or resolve through a self arm.
- `createRebacCheck(resolveRelation, { selfResource })` names the resource holding the actor's own entry (e.g. `db:user`). A self arm evaluated without it throws.
- A bare `{ self }` (no `action`) throws at evaluation; `actionRuleSchema` rejects it.
- Migration: give every self arm the action it needs (`read` for read arms, `operate` for writes such as leave or resolve), and pass `selfResource`.

## 0.4.0 — json-rules 3.0

- **Requires `@inixiative/json-rules@^3.0.0`.** Bridge lookups build with `indexBridges` (was `buildBridgeDictionary`); `BridgeDictionary` and `Row` are json-rules' own exports (`Row` is re-exported here unchanged).
- **`{ rule }` checks take json-rules 3.0's semantics.** An absent path reads as NULL (so `notIn [null]` no longer matches a missing field, and a negation keeps NULL rows), values compare as JSON (`"3"` never equals `3`, ordered comparisons hold only within one type), patterns run on RE2, and a rule json-rules now refuses (an `in` with a scalar, an unknown period unit or aggregate mode) throws out of `check` instead of answering. Review stored ABAC rules that relied on the old coercions.
- `actionRuleSchema` validates the `rule` branch with json-rules 3.0's `validateRule`, which also rejects patterns RE2 can't run.

## 0.3.1 — bridge wrong-allow, hydrator cycle guard, permix wrapper fixes

- **Security (wrong-allow) fix.** A bridge hop that joins on a non-`id` field no longer fabricates `{ id: farId }` from the join scalar — it synthesizes `{ [hop.farOn]: farId }`, and only consults an id-keyed grant when the far join key *is* the id. Previously, with `subject.data` omitted, an actor holding an id-keyed grant on an unrelated record whose id equaled the join value was wrongly authorized, and the decision was non-monotonic in supplied data (omitting data could allow more than providing it).
- **Hydrator cycle guard.** `hydrate` no longer hangs forever on cyclic to-one FKs (a self-referential `managerId = id`, or an A→B→A loop) — a per-branch `ancestors` set cuts any edge that points back at an ancestor, so hydration always terminates. Legitimate diamonds (the same parent via two non-ancestor paths) still fully hydrate.
- **Permix wrapper.** A resource-wide grant now applies when checking a specific record id (the wrapper falls back from the `resource:id` key to the bare `resource` key); successive `setup` calls for the same key merge their actions instead of overwriting; and the spurious `[Permix]: Incorrect entity name` warning that printed on every deny is gone.
- Requires `@inixiative/json-rules@^2.12.1`.
