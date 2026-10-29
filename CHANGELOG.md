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
