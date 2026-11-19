# The typed actor: `__actor.<kind>.*`

Status: spec (2026-11-19), revised after an adversarial review; for Aron. Replaces TRACKING "Actor bridge".

## Problem

A `{ rule }` reads who is acting under `__actor`, and the rule lens types it as one Json field
(`src/core/lens.ts`, `actorAsJsonField`). Any path under it is accepted, so a typo or a field of
the wrong kind of actor passes validation and reads null at check time.
Rules in use today (the whole survey):

| App | Rule | Reads |
|---|---|---|
| template, Kingdom, Tribe | `actorIsUser` | `__actor.model = 'User'` |
| template, Kingdom, Tribe | `actorIsDelegateOfUser` | `__actor.record.ownerModel = 'User'` |
| Zealot | `actorIsUser`, `apiToken`, `actorIsUserOrUserKey` | `__actor.model`, `__actor.record.ownerType`, `__actor.record.parentTokenUuid` |
| Zealot | `actorIsNotImpersonating` | `__actor.impersonatedBy` (on the actor, not its row) |
| Zealot | `user`, `conversation` | `path: '__actor.record.uuid'` |

None reads a row related to the actor. Also reading the actor: Zealot's
`actionReachable.ts:53` evaluates rules against `{ __actor: permix.getActor() }` for role reflection
(`roleReflection.ts:54` builds a stand-in actor); the CI fixture
`scripts/ci/rule-violations/rebac-schema-never-reads-full/` in template, Kingdom and Tribe; and
permissions' own tests (`check.test.ts`, `relationLens.test.ts`, `lensesAtListItem.test.ts`).
Foundry reads none. Unchanged and correct as they are: a token acting through its owner's
entitlement stays the token (`identity.ts:25`, `entitled.ts:33`); the grant check runs with no actor
(`grant.ts:51`); superadmin returns before any rule (`evaluate.ts:128`); template's spoof does not
change the actor.

## Change

Agreed shape (Aron 11-15: "I'm fine with those being properly discriminated"; 11-19: slot names are
the app's model names, `token` in template, `apiToken` in Zealot).

1. **The app declares who can act**, on the `SchemaMap` (the object every check already takes):

   ```ts
   actors: {
     kinds: { User: 'user', Token: 'token' },      // actor model → its slot; Zealot: { User: 'user', ApiToken: 'apiToken', Internal: null }
     fields?: { impersonatedBy: { kind: 'scalar', type: 'String' } }, // on the actor, beside the slots
   }
   ```

   A kind whose slot is `null` acts with no row (Zealot's `Internal`). A kind with a slot names a
   model of `fieldMap`; two kinds may not share a slot (the map is refused). Keyed by model, since
   the injection looks up `actor.model`. The app's `ActorModel` constant is derived from it (one
   declaration, not two).
2. **The rule lens types the actor.** `lensAnchoredAtModel` adds to the rule lens's copy of the map
   a model `__Actor` with `model` (an enum `__ActorKind` of the declared kinds), the declared
   `fields`, and one to-one relation per slot to its model; the anchored model gets
   `__actor: { kind: 'object', type: '__Actor' }`; the root spells
   `__actor: { relations: { <slot>: {} … } }`. The refusal message for an `__actor` read branches:
   in a `where` it is "a `where` reads the record alone", in a `{ rule }` it is the ordinary
   not-in-lens message (today it says the `where` text for both, `lens.ts:318`). Probed on
   json-rules 4.2 (`validateRuleInLens`) and on permissions' own path (`validateSchema`,
   `createRebacCheck`, `lensesAtListItem`), by the review:
   - `__actor.user.email`, `__actor.token.ownerModel`, `__actor.impersonatedBy`, `path: '__actor.user.id'`: accepted;
   - `__actor.usr.email`, `__actor.record.email`: refused (`not_in_lens`);
   - `__actor.user.org.id`: refused (a relation of the actor is not turned on);
   - `__actor.model = 'Bogus'`: refused by json-rules (`value_not_allowed`) but **kept by
     permissions**: `issuesForReadsOutsideLens` passes on only path and operator codes
     (`lens.ts:295-316`), so every app's out-of-enum value is accepted today. Fixed in general here:
     `value_not_allowed` is kept for every rule, not only the actor's.
   - unchanged: the hydrator (it walks `map.fieldMap`, not the rule lens's copy),
     `countRelationsOneRowHydrates`, `delegatedWhere`, a `where`'s refusal of `__actor`.
3. **The check injects the slots.** `setActor({ model, record, ...fields })` is unchanged for the
   app. One exported function, `actorAsRuleReadsIt(map, actor)` (name to settle with the verbs doc),
   turns it into `{ model, [slot(model)]: record, ...fields }`; `evaluate.ts` calls it where it
   injects `__actor`, and Zealot's `actionReachable` calls it instead of passing the raw actor. A
   model not in `kinds` throws once when a walk starts (`walker.ts`), since `createPermissions` takes
   no map.
4. **Only the actor's own columns.** Related rows are not readable (Aron 11-19: "you can put the
   token into a relation check"). A rule that needs the actor's position says it as a relation from
   the record (`{ rel, action }` or an entitlement), as every rule surveyed already does.
5. **Hard cut.** A map without `actors` gets an `__Actor` with `model` only (an empty enum), so
   every `__actor.record.*` read is refused and each app declares its actors in the release that
   takes this (no backwards compatibility, CLAUDE.md).

## Re-spelling (each app, in the PR that takes the release)

- template, Kingdom, Tribe: `__actor.record.ownerModel` → `__actor.token.ownerModel`; declare
  `actors: { kinds: { User: 'user', Token: 'token' } }` in `packages/db/src/schemaMap.ts`.
- Zealot (a ticket for Alexandre, never merged by an agent): Zealot is on permissions 0.21.1 and
  json-rules 3.22, so this rides the json-rules 4 / field-map cut-over (ZLT-7009). Then
  `record.ownerType` / `record.parentTokenUuid` → `apiToken.*`; `record.uuid` → `user.uuid` (a token
  actor no longer matches a user's uuid, which it never should have); `actionReachable` and
  `roleReflection` through the exported injection; declare `ApiToken: 'apiToken'`, `Internal: null`,
  `fields: { impersonatedBy }`. `actorIsNotImpersonating` (`impersonatedBy notExists`) is not
  positive, which the current engine refuses, so it needs a positive spelling (for example an
  `impersonating: Boolean` actor field set false).
- rules-builder: nothing; it reads the rule lens (`lensesAtRow`).

## Tests

- Each probe line above, as `validateSchema` and `issuesForRuleReadsOutsideLens` report it.
- A check with a user actor reads `__actor.user.id`; with a token actor `__actor.user.*` is absent
  and a rule on it does not hold.
- `setActor` with an undeclared model throws; an `Internal` actor has `model` and no slot.
- `__actor` still never resolves in a `where` or on a related row (`org.__actor`).

## Settled by the review

- `kinds` keyed by model (above).
- No per-slot `omits` for sensitive columns: a rule on a Token row can read `keyHash` today, so
  cutting it only under `__actor` would be a special case. If sensitive columns should leave every
  rule lens, that is a general narrowing on the map, filed separately.
- `actors` lives on `SchemaMap`: lenses are built and cached per map, the injection reads the map,
  and who can act is a fact about the data, not the rules.

## For Aron

- Keeping `value_not_allowed` tightens every app's rules, not only the actor's: an enum value that
  isn't in the enum becomes a schema error. I expect none in template, Kingdom or Tribe; the build
  would show any.
