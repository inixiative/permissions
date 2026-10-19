# Changelog

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
