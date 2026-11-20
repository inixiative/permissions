# Verbs

Every operation this library performs has one verb, one name that says the action, and one
implementation. `test/verbs.test.ts` enforces it: every exported function must appear in this file,
and each internal verb below lives only in the module that owns it. Nouns (resource, action, grant,
entitlement, anchor, actor, permix) are in the README's Vocabulary table.

Before naming anything here, read this file and json-rules' `docs/VERBS.md`. Use the verb that
exists; add a row when the operation is new. A name is close to a full sentence: what it does to
what.

## Public API

| Verb | Name | What it does |
| --- | --- | --- |
| check | `createRebacCheck` | Build the check for a schema map: may this actor's permissions take this action on this record. |
| check | `createRebacPaths` | Build the same walk returning every path that admits the action, for attribution; throws `PathLimitError` past its limit. |
| check a grant | `createCanGrantEntitlement` | Build the grant check: may this writer hand out this entitlement on this placed record. |
| install | `createPermissions` | Create a permix: the installed form of one actor's grants and entitlements that a check reads. |
| install | `installPermissions`, `permixOf` | Install a `Permissions` value (groups of entries, each backed by its owner) into a permix; build the permix of one group. |
| delegate | `delegate` | The entries a token or integration acts from: its owner's in full, capped at a ceiling, or its own entitlements. |
| cap | `capAtRole` | Keep a delegate's entries at the action its role maps to. |
| reach | `reachableFrom` | The actions on a resource whose holding grants an action by pure delegation, itself included. |
| narrow a grant | `delegatedWhere` | The `where` of a grant passed on from a held one: the added conditions, then the held `where`'s conjuncts, flat. |
| place | `placeEntitlement`, `placeUnder` | Build the stand-in records a grant is checked on, below its hydrated anchor along the entry's path. |
| hydrate | `createHydrator` | Build the loader that puts on a record every relation the lens follows, so a check never reads a relation that was not loaded; `hydrationLimits` is its load budget. |
| validate | `validateActionRule` | Whether one action rule is well formed and positive, and does not delegate back to its own action. |
| validate | `validateSchema`, `schemaRuleIssues` | Every issue in a schema against its map (shape, cycles, reads outside the lens, undefined actions); the shape issues alone, without the map. |
| validate | `entitlementProblem`, `wellFormedEntitlements` | Why one entitlement entry is malformed, or null; the well-formed entries of a list. |
| validate | `whyEntitlementWhereLeavesLens` | Why an entitlement's `where` reads something the lens does not load, or null, for an app that validates a row before saving it. |
| lens | `lensesAtRow`, `lensesAtListItem` | The json-rules lenses a read is judged in at one row (`lens` for a `where` or a path, `rule` with the actor for a `{ rule }`); at an item of a declared list, or null for a list that is not declared. For an editor that authors rules in the lens they are judged in. |
| offer | `relationHopsFrom`, `declaredListsOf` | The segments a `{ rel }` may take next from a row (to-one relations and bridges whose walk `validateSchema` accepts), each with the resource it lands on; the declared lists a list arm may cross. |
| validate | `issuesForRuleReadsOutsideLens` | Every read of one well-formed action rule at a resource outside the lens, for a rule not in the schema (a transition's permission side, a draft). |
| compare | `coversEntitlement`, `withoutRedundantEntitlements` | Whether one entitlement covers another; a list without the entries another one covers. |

`PathLimitError` is thrown by `createRebacPaths` when more paths admit an action than its limit.

## Internal verbs and their owners

| Verb | Owner | Rule (`test/verbs.test.ts`) |
| --- | --- | --- |
| read a model or a field of the schema map | `@inixiative/field-map` (`modelOf`, `fieldOf`; kind tests `hasColumn`, `isScalarField`) | No `.models[...]` or `.fields[...]` index read in `src`: every read is own-property, through field-map's readers. |
| decide which relations hydration follows | `src/core/schemaMap.ts` (`followedToOneRelationOrWhyNot`, `followedToOneRelationsOf`, `listOf`) | No `.fromFields` read elsewhere: an owning key is classified once. |
| read a `@permissions(...)` annotation | `src/core/schemaMap.ts` (`permissionsAnnotation`) | No `annotations.permissions` read elsewhere. |
| build a json-rules lens and judge a path against it | `src/core/lens.ts` | `validateRuleInLens` and `walkLensPath` are called nowhere else. |
| spell a relation tree | `src/core/lens.ts` (`spellEveryFollowedRelationChain`) | json-rules' model defaults enter each model once; every route is spelled under `root` here, as json-rules' docs say to. |
| freeze, then judge once | `src/core/freezeThenJudgeOnce.ts` | `Object.freeze` nowhere else: a schema, an inline rule and a `where` are frozen by the one function that memoises their judgement. |
| remember an answer by two keys | `src/core/freezeThenJudgeOnce.ts` (`answerOnce`) | — (used by `freezeThenJudgeOnce`, `reachableFrom`, the walker's inline-rule keys and the per-check row caches) |
| walk a rule | `src/core/evaluate.ts` (`evaluate`), entered through `src/core/walker.ts` (`createWalker`) | — (one engine walk for `check`, `paths` and both grant passes) |
| hop to a related row | `src/core/evaluate.ts` (`{ rel }` and the list arm), `src/core/bridgeHop.ts` (a bridge) | — |
| remember a node's answer for one check | `src/core/evaluate.ts` (`walkAction`; `isNodeOnPath` is the counted test for a node on the path, `entitled`'s owner test included; a remembered answer's footprint is read against `visited` uncounted; the per-check state is `WhatOneCheckRemembers`) | — (a node reached after a hop: kept when no test in its walk found a node on the path, reused while no answer in its footprint is on the path; nothing outlives the check) |
| consult an entitlement | `src/core/entitled.ts` (`entitled`) | — |
| walk an anchor path on a record | `src/core/schemaMap.ts` (`rowsAlongAnchorPath`; `anchorRowReachedFrom`, whether it reaches the anchor) | — (used by `entitled`, `rowsAbove` and placement) |
| walk the delegation graph | `src/core/reachableFrom.ts` (`delegationReach`) | — (used by `reachableFrom` and `validateActionRule`'s cycle test) |
| identify a row | `src/core/schemaMap.ts` (`identityColumnsOfRow`, `identityKeyOfRow`, `keyFromResourceAndColumns`), `src/core/recordId.ts` (`recordId`, `hasNoValue`: null, undefined or `''` is no value); on a walk, `src/core/evaluate.ts` (`identifyRowOncePerCheck`, once per row and resource in one check) | — (the hydrator and loop detection share one key) |
| load a row | `src/helpers/hydration/hydrate.ts` | — (the app's `load` is called nowhere else; it brings a resource's declared lists with the row) |

## The lens, in this library's words

The lens is json-rules' own (`docs/LENS.md` there). This library only builds its declaration and
words its refusals:

| Name | What it does |
| --- | --- |
| `spellEveryFollowedRelationChain` | From a resource, spell under `root.relations` every chain of relations hydration follows, never entering the same model twice on one chain; throws past `relationLensLimits`. |
| `lensAnchoredAtModel` | The json-rules lens for one model with a spelled relation tree; the rule form also carries the actor. |
| `lensesAtRow` | The lenses a read is judged in at one row: the resource's, or under a list item what remains of the list's declared `down` paths. |
| `lensesBuiltOnceAt` | The lens and the rule lens at one key (a resource, or a landing under an item), built once per map. |
| `countRelationsOneRowHydrates` | The relations one row of a resource hydrates, one kind of each false-polymorphic model counted. |
| `issuesForReadsOutsideLens` | Every path a condition reads that the lens does not hold, as json-rules' gate reports it. |
| `whyPathLeavesLens`, `whyRelationPathCannotBeWalked` | The refusal in this library's words: a list (use the list arm), a relation not loaded, a path outside a declared `down`, a path back to a model. |
| `whyWhereLeavesLensAtRow` | Why an entitlement's `where` leaves the lens at the row it is consulted on, judged once. |
