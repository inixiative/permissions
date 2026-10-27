# Changelog

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
