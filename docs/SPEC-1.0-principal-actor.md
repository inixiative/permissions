# Entitlements — state of play, 2026-10-22 (end of session)

Supersedes every earlier draft in this file. The keyed-grant / narrowing / fence / principal-actor
designs were explored and dropped (template branch `wip/permissions-holders-2026-10-21`, library
branch `feat/0.6-grant-keys` hold the exploration). Start here.

## Locked

**The engine stays as it is.** One table (permix entries), one walk (row → hydrated parents →
anchor), schema rules with guards inside `all`. Entitlements add no evaluator.

**Collections are not a thing.** A list is the child's `read` checked on a *pseudo-record* (the
owner's keys, `ownerModel` included, no id); a create is `create`/`manage` on the draft. The
pseudo-record has the same FK shape as a row so the same walk applies: a collection is a proxy for
an action on the owner. Library PR #14 (a `collections` map) is to be closed in favour of a README
paragraph; its tests document the convention and pass on today's engine. Template: list routes
check the child's `read` on the scope row instead of the parent's `read`; `ownerActions` gates on
`ownerModel`.

**An entitlement is an action on a pseudo-record.**
```
{ action: 'manage', model: 'db:integration', record: { ownerModel: 'Organization', organizationId: 'o1' } }
{ action: 'manage', model: 'db:integration', record: { id: '$self.id' } }
```
A real row is the case `record = { id }`. The record carries its OWN `ownerModel`; the registry
(`falsePolymorphism.ts`) says which keys that `(model, ownerModel)` needs, and the record must be
exactly `{ id }` or that key set, non-null scalars — otherwise refused at grant. Interpolation
(`self.*`, `$source`, `$target`) fills keys from the holder's chain; a key the holder can't supply
→ refused, never stored partial. The holder's owner shape need not match the target's.

**Grant check** = the writer runs the normal check on the pseudo-record (walks to the owner).
**Tenancy is live**: a collection entitlement is live through the walk; a row entitlement is kept
at permix build only if the holder's OWNER can still do that action on that row (one cached fetch +
check per entitlement). A space transferred to another org breaks both forms.

Roles stay on `canAssign`. Memberships keep required roles; Token / Integration / JWT grant roles
nullable (null = only the entitlements; a user's own JWT with null = everything). Entitlements are
an array. In-person actions are a schema arm (`{ actor: model == 'User' }`), never grantable.
No `where` filters yet (only 2 of 11 cases wanted one); no `owner` virtual relation; no
`<child>.<action>` actions generated on owners (rejected: not the pattern).

## Open (tomorrow's first item)

How a collection-shaped entitlement sits in the holder's permix table at READ time without
(a) widening to `manage` on the owner row itself (would also cover spaces etc.), or
(b) a rule-valued entry OR'd at the merge point (bypasses schema guards such as
`db:contact.manage = all[valueKey ≠ user.email, owner walk]`; check ≠ list through `rel`).
Children-actions-on-the-parent (`integration.manage` on org) would solve it and was ruled out.

## Cases the design must express (acceptance)
user grants read on his organizations / his spaces / the spaces of one org / phone contacts;
integration manages itself / all owner's integrations of its provider (needs `where`, deferred);
token manages itself; member token manages all spaces of its org / custom action on its org /
its membership's integrations; user token reads one organization.

## Three layers (Aron)
1. evaluation given valid grants — engine; 2. tenancy — grant check + live owner check;
3. emission — provenance (inquiry row, audit log, Signet signatures), not permissions.
