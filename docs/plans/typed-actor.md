# The typed actor: `__actor.<kind>.*`

Status: **reshaped 2026-11-21 (R-2026-11-21-07).** Aron: "The permissions library should just support maps, and you put a map. If you have actors, you have actors." What shipped in permissions 0.26 is general: `SchemaMap.supplied` (field maps by prefix), rows given in the check's `data`, filled by json-rules 4.4's `recordWithBridgeData`, every read of them guarded by `exists` (the positive gate), and the kind blocks reading kinds from the map. The actor taxonomy below (`SchemaMap.actors`, pseudo kinds, `recordWithActor`, `permix.setActor`) is template's to declare as its `actor` map, not the library's; the sections below are the 11-19 design, kept for its why.

Earlier status: built 2026-11-19 (the fan-out, `actor:Acting` and the null-check refusal, R-2026-11-19-13..16) over json-rules 4.3's supplied bridges.

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

Aron 11-19: "Instead of the DB prefix, we should have the actor prefix, right? Then we can remove
the `__actor`. We can just use a normal prefix of `actor:`." So the actor is a json-rules bridge to
a map named `actor`, read with json-rules' own bridge spelling, and `__actor` goes.

1. **The app declares who can act**, on the `SchemaMap`: `actors: ['User', 'Token']` (Zealot:
   `['User', 'ApiToken']`), models of `fieldMap`. The app's `ActorModel` constant is derived from it.
2. **The rule lens bridges to the actor.** `lensAnchoredAtModel` builds the rule lens over
   `stitchFieldMaps({ maps: { app: fieldMap, actor: <the declared models> }, bridges })`, one
   one-to-one bridge from the anchored model to each `actor:<Model>`, and turns each on at the root
   (`relations: { 'actor:User': {}, 'actor:Token': {} }`), nothing below. Rules read
   `actor:User.email`, `actor:Token.ownerModel`, `path: 'actor:User.id'`; which kind is acting is
   `{ field: 'actor:Token.id', operator: 'exists' }`, positive, so `model` and its enum go. Probed on
   json-rules 4.2 (`validateRuleInLens`):
   - accepted: `actor:User.email`, `actor:Token.ownerModel`, `actor:User.id exists`,
     `ownerId = path actor:User.id`;
   - refused: `actor:Usr.email`, `actor:User.nope` (no such path), `actor:User.org.id` (a relation of
     the actor is not turned on).
   The plain lens (a `where`) has no actor bridge, so a `where` still cannot read the actor.
3. **The check puts the actor's row under its bridge key.** `setActor({ model, record })` is
   unchanged for the app; where `evaluate.ts` injected `__actor` it now writes
   `{ ...record, ['actor:' + model]: actor.record }` (one exported function, which Zealot's
   `actionReachable` also calls). `check()` is bridge-unaware and reads the key by plain property
   access, as json-rules documents for every bridge. A model not in `actors` throws once when a walk
   starts.
4. **Only the actor's own columns** (Aron 11-19: "you can put the token into a relation check").
5. **Hard cut:** `__actor` is gone from the lens and the row; every `__actor.*` read is refused.
6. **The enum fix stays** (found by the first review): `issuesForReadsOutsideLens` keeps json-rules'
   `value_not_allowed`, for every rule.

### What the bridge's `on` means here

A json-rules bridge names a join (`on` on each side). The actor is not joined; it is the presented
credential. The bridge is lens metadata only (json-rules' `check` never reads `on`), so the
endpoints carry each side's id (`on: 'id'`). Open for the review: whether that fiction leaks
anywhere `on` is read (`toPrisma`, `toSql`, `indexBridges`, permissions' `bridgeHop`), and whether
the actor bridges belong in the schema's `bridges` at all. They don't today: `{ rel: 'actor:Token',
action }` would be a hop to the actor's row, a new kind of check, not asked for.

### Actor-level fields and a row-less actor

Zealot's `impersonatedBy` sits on the actor, not its row, and its `Internal` actor has no row. With
no `__actor` object they need a home: `impersonatedBy` as a declared column of the acting model's
slot in the `actor` map (`actor:User.impersonatedBy`, injected onto the row), and `Internal` as an
`actor:Internal` model with no columns but `id`. Open for the review and for Aron.

## Re-spelling (each app, in the PR that takes the release)

- template, Kingdom, Tribe: `__actor.model = 'User'` → `actor:User.id exists`;
  `__actor.record.ownerModel` → `actor:Token.ownerModel`; declare `actors: ['User', 'Token']` in
  `packages/db/src/schemaMap.ts`; re-spell the `rebac-schema-never-reads-full` CI fixture.
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
- A check with a user actor reads `actor:User.id`; with a token actor `actor:User.*` is absent and
  a rule on it does not hold.
- `setActor` with an undeclared model throws when a walk starts.
- The actor never resolves in a `where`, on a related row (`org.actor:User`), or past its own
  columns.
- Every `__actor.*` read is refused.

## Superseded

The first draft typed `__actor` as a synthetic `__Actor` model with one slot per kind. Aron chose the
`actor:` bridge instead (11-19), which uses json-rules' bridge spelling and drops `__actor`. The
review's findings that still apply are folded in above.

## Settled by the review

- No per-slot `omits` for sensitive columns: a rule on a Token row can read `keyHash` today, so
  cutting it only under `__actor` would be a special case. If sensitive columns should leave every
  rule lens, that is a general narrowing on the map, filed separately.
- `actors` lives on `SchemaMap`: lenses are built and cached per map, the injection reads the map,
  and who can act is a fact about the data, not the rules.

## For Aron

- Keeping `value_not_allowed` tightens every app's rules, not only the actor's: an enum value that
  isn't in the enum becomes a schema error. I expect none in template, Kingdom or Tribe; the build
  would show any.

## The fan-out: the standard shape of a polymorphic check (Aron 11-19)

Aron 11-19: "Most polymorphic permission checks are fanned out, and so each branch of it should
check its fan, or each branch should check its own branch." And: "we have to start checking the
model. Because it has to be all positive rules": a pseudo kind (`Default`, `Internal`, `admin`) has
no row and no id, so `exists` cannot name it, and "the id does not exist" is not a positive rule.
"This is a standard shape that we should be moving towards."

So permissions exports the blocks, built from the map's polymorphism registry (`map.polymorphism`
axes) and the actor declaration, so no app restates its kinds:

```ts
// a false-polymorphic side: one branch per kind, each checking its own model first
sideFanOut('owner', {
  Organization: { rel: 'organization', action: 'manage' },
  Space:        { rel: 'space', action: 'manage' },
  User:         actorMatches('ownerUserId', 'User', 'id'),
  Default:      true,                      // a pseudo kind: its model check is the whole branch
})
// → any: [ all: [ownerModel = 'Organization', { rel: 'organization', action: 'manage' }],
//          all: [ownerModel = 'Space', { rel: 'space', action: 'manage' }],
//          all: [ownerModel = 'User', ownerUserId exists, ownerUserId equals actor:User.id],
//          ownerModel = 'Default' ]

// the actor: the same fan-out over who is acting
actorFanOut({ User: …, Token: …, Internal: true })
// each branch: all: [actor:Session.model = '<kind>', …]

// the leaf: the actor kind, then exists, then match
actorMatches('ownerId', 'User', 'id')
// → all: [actor:Session.model = 'User', actor:User.id exists, ownerId equals actor:User.id]
```

- A kind check on its own is a rule too (Aron 11-19: "actor token is this, or any of actor token,
  actor user. That's a totally valid check also"): `actorIs(['Token', 'User'])` →
  `actor:Session.model in ['Token', 'User']`; `sideIs('owner', ['Organization', 'Space'])` →
  `ownerModel in [...]` (template's `ownerModelIsOneOf`).
- A kind left out of a fan-out has no branch and denies.
- The actor gets a discriminator again, on the session row: every actor's `actor:Session` row
  carries `model` (an enum of the declared kinds, pseudo kinds included), so "who is acting" is a
  positive model check. The declaration gains pseudo kinds:
  `actors: { models: ['User', 'Token'], pseudo: ['Internal'], session? }`.
- The blocks return ordinary `ActionRule` values: validation, the walk and the builder see plain
  rules. The walk infers nothing from the registry (no implicit kind check on a `{ rel }` hop):
  under the full owner chain a Space-owned row also carries its organization, and a rule may mean
  to walk it.
- Template's `ownerModelIsOneOf` / `actorMayPerformActionOnOwner` become `sideFanOut`; `actorIsUser`
  a one-branch `actorFanOut`. Names to settle against `docs/VERBS.md`.
