# The typed actor: `__actor.<kind>.*`

Status: spec (2026-11-19), for adversarial review, then Aron. Replaces TRACKING "Actor bridge".

## Problem

A `{ rule }` reads who is acting under `__actor`, and the rule lens types it as one Json field
(`src/core/lens.ts`, `actorAsJsonField`). Any path under it is accepted, so a typo, a field of the
wrong kind of actor, or a column the app strips all pass validation and read null at check time.
Rules in use today (the whole survey):

| App | Rule | Reads |
|---|---|---|
| template, Kingdom, Tribe | `actorIsUser` | `__actor.model = 'User'` |
| template, Kingdom, Tribe | `actorIsDelegateOfUser` | `__actor.record.ownerModel = 'User'` |
| Zealot | `actorIsUser`, `apiToken`, `actorIsUserOrUserKey` | `__actor.model`, `__actor.record.ownerType`, `__actor.record.parentTokenUuid` |
| Zealot | `actorIsNotImpersonating` | `__actor.impersonatedBy` (on the actor, not its row) |
| Zealot | `user`, `conversation` | `path: '__actor.record.uuid'` |

None reads a row related to the actor.

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
   model of `fieldMap`.
2. **The rule lens types the actor.** `lensAnchoredAtModel` adds to the rule lens's copy of the map
   a model `__Actor` with `model` (an enum `__ActorKind` of the declared kinds), the declared
   `fields`, and one to-one relation per slot to its model; the anchored model gets
   `__actor: { kind: 'object', type: '__Actor' }`; the root spells
   `__actor: { relations: { <slot>: {} … } }`. Nothing else changes in the lens. Probed on
   json-rules 4.2 (`validateRuleInLens`):
   - `__actor.user.email`, `__actor.token.ownerModel`, `__actor.impersonatedBy`, `path: '__actor.user.id'`: accepted;
   - `__actor.usr.email`, `__actor.record.email`: refused (`not_in_lens`);
   - `__actor.user.org.id`: refused (a relation of the actor is not turned on);
   - `__actor.model = 'Bogus'`: refused (`value_not_allowed`, the declared kinds).
3. **The check injects the slots.** `setActor({ model, record, ...fields })` is unchanged for the
   app. Where `evaluate.ts` injects `__actor`, it writes `{ model, [slot(model)]: record, ...fields }`:
   one place, so the app never spells slots. A model not in `kinds` throws at `setActor`.
4. **Only the actor's own columns.** Related rows are not readable (Aron 11-19: "you can put the
   token into a relation check"). A rule that needs the actor's position says it as a relation from
   the record (`{ rel, action }` or an entitlement), as every rule surveyed already does.
5. **Hard cut.** A map without `actors` gets an `__Actor` with `model` only (an empty enum), so
   every `__actor.record.*` read is refused and each app declares its actors in the release that
   takes this (no backwards compatibility, CLAUDE.md).

## Re-spelling (each app, in the PR that takes the release)

- template, Kingdom, Tribe: `__actor.record.ownerModel` → `__actor.token.ownerModel`; declare
  `actors: { kinds: { User: 'user', Token: 'token' } }` in `packages/db/src/schemaMap.ts`.
- Zealot (a ticket for Alexandre, never merged by an agent): `record.ownerType` /
  `record.parentTokenUuid` → `apiToken.*`; `record.uuid` → `user.uuid` (a token actor no longer
  matches a user's uuid, which it never should have); declare `ApiToken: 'apiToken'`,
  `Internal: null`, `fields: { impersonatedBy }`.
- rules-builder: nothing; it reads the rule lens (`lensesAtRow`).

## Tests

- Each probe line above, as `validateSchema` and `issuesForRuleReadsOutsideLens` report it.
- A check with a user actor reads `__actor.user.id`; with a token actor `__actor.user.*` is absent
  and a rule on it does not hold.
- `setActor` with an undeclared model throws; an `Internal` actor has `model` and no slot.
- `__actor` still never resolves in a `where` or on a related row (`org.__actor`).

## Open for the review

- `kinds` keyed by model with the slot as value, vs slots keyed with the model as value.
- Whether sensitive columns should also be cut in the lens (`omits` on each slot), beside the
  app's `pickColumns` minus sensitive fields at `setActor`.
- Whether `actors` belongs on `SchemaMap` or on the schema (`RebacSchema`).
