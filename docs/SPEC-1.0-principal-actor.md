# Holders, grant keys and narrowing (permissions 0.6 + template)

Status: BUILT 2026-10-21 against the 28 situations in template
`apps/api/src/lib/permissions/holders.test.ts` (all green). Supersedes the principal/actor
drafts in this file's history; the two-sided check, `toCondition`, `implies` and `self`-removal
were dropped. Principal/actor as first-class permix slots remains a later step, if ever.

## What permix is

A lookup table of anchors: `db:user:<u>`, `db:organization:<o>`, `db:space:<s>`, each holding
the actions a role gives. The schema walks any row up to an anchor and asks the table. Permix
reasons about nothing.

## Holders

A row with `{ owner, role, entitlements }`: `OrganizationUser`, `SpaceUser`, `Token`, `Integration`.
The role is the holder's role on its owner (the anchor). Entitlements are keyed:

```
db:integration            every integration the principal reaches
db:integration:i7         that row
db:integration:self       the holder's own row of that model (resolved when the permix is built)
db:integration + rule     rows matching a rule over the row's own fields
```

Each key maps an action to `true` or an `ActionRule`.

## Widen or narrow, by position

| Position | Entitlements | Mechanism |
|---|---|---|
| Acting as the principal (membership, integration) | widen | permix entries; rule-valued entries OR at the merge point |
| Narrowing a principal (token, JWT grant) | narrow | `permix.setNarrowing`: a keyed resource is reachable only through its keys; unkeyed = untouched; `null` = unnarrowed; a listed action covers what the schema delegates to it; fenced on every visit, walks included |

The credential's role is the ceiling: `lesserRole(anchor role, credential role)` on every anchor.
A narrowing can never widen, so minting needs no comparison.

## Principals

| Credential | principal | narrowing |
|---|---|---|
| Session | the user: `own` on itself + memberships | — |
| User token | the user | token role + keys |
| OrganizationUser / SpaceUser token | that membership (+ `user.identify`) | token role + keys |
| Organization / Space token | the org / space | token role + keys |
| Integration token (`ownerModel = 'Integration'`) | the integration: role on its owner, `operate` on itself, its own keys | token role + keys |
| JWT `grant` claim | the user; the integration's own keys do not apply | `resolution.grant` |

## Actor

`{ id, model: User | Token | Integration | Grant, integrationId }`. Person-only is the schema arm
`inPerson = { actor: model == 'User' }` on `token.create`, `user.redact`, `organization.delete`.
`self` arms compare `record[field]` to the user behind the request and only match users.
Superadmin short-circuits on any credential (ruled).

## Write-time binding

Entitlements never carry literal ids. Keys name rows by `$source` / `$target` (inquiries) or
`self`; rule values on `id` / `*Id` fields are `{ bind: 'source.x' | 'target.x' | 'content.x' | 'self.x' }`.
Bound at approval (`resolution.grant`) or at integration creation (`Integration.entitlements`,
from the draft row). A literal id is 422. The approver may only drop entries; `{}` is refused.

Example, an integration that owns the Slack integrations of its own organization:

```ts
'db:integration': { own: { rule: { all: [
  { field: 'provider',       operator: 'equals', value: { bind: 'self.provider' } },
  { field: 'organizationId', operator: 'equals', value: { bind: 'self.organizationId' } },
] } } }
```

## Lists

`entitlementScope(model)` compiles the narrowing keys of the listed resource into one `where`
(id keys → `id in`, a bare key's `read` rule → the rule, `true` → no narrowing, nothing covering
read → empty). Rules that are not a `{ rule }` condition are not listable; accepted limitation.

## Library (0.6.0)

`Entitlements` keyed; `entitlementEntries`, `parseGrantKey`, `narrowingKeysFor`; rule-valued
permix entries + `permix.rules`; `permix.setNarrowing` / `getNarrowing`; the fence and the merge
point in `createRebacCheck`. 1.0 (#13: nested actor, expressions, `toCondition`, `implies`)
stays parked.

## Open

- Narrowing rules that are not plain `{ rule }` conditions cannot be listed.
- A membership's flat `{ action: true }` entitlements are shorthand for keys on its owner.
- Principal and actor as two first-class slots with one `check(rule, principal, actor)`:
  deferred; the actor arm plus narrowing covered every situation named so far.
