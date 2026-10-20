# @inixiative/permissions

Generic **rebac / abac / rbac** core: a small `permix` wrapper plus a relationship-walking `check`
engine, on top of [`@inixiative/json-rules`](https://github.com/inixiative/json-rules). The one
app-specific bit — resolving which model a relation points at — is **injected** (built from
[`@inixiative/prisma-map`](https://github.com/inixiative/prisma-map) in the inixiative stack), so the
core stays small and never imports a database layer itself. Record **hydration stays in the app**.

## Permission algebra (`ActionRule`)

```ts
type ActionRule =
  | string                       // rbac: delegate to another action on the same resource
  | { rel: string; action: string }  // rebac: walk a relation, then check `action` on the target
  | { self: string; action?: string } // record[field] is the acting person; with `action`, it holds `action` on itself
  | { rule: Condition }          // abac: a json-rules predicate over the record
  | { actor: Condition }         // abac: a json-rules predicate over the actor itself
  | { any: ActionRule[] }        // OR
  | { all: ActionRule[] }        // AND
  | null;                        // terminal deny
```

A `RebacSchema` is `{ bridges?, permissions }` — `permissions` maps a (map-qualified) **resource**,
e.g. `db:User`, to `{ actions: { name → ActionRule }, collections?: { name → ActionRule } }`; `bridges` are the cross-source edges a `rel`
walk may cross (see [Bridges](#bridges-cross-source-rel-walks)). A single-source schema omits
`bridges` and can use bare resource keys.

## Writing a schema

Action names are **yours** — the engine imposes no vocabulary. The `own`/`manage`/`read` chain below
is illustrative; use whatever your roles grant.

```ts
import { Operator } from '@inixiative/json-rules';
import type { RebacSchema } from '@inixiative/permissions';

const schema: RebacSchema = {
  permissions: {
    organization: {
      actions: {
        own: null, //         terminal: granted only via permix (roles) or row rules
        manage: 'own', //     delegation chain — own ⊇ manage ⊇ read
        read: 'manage',
      },
    },
    membership: {
      actions: {
        read: { any: [{ self: 'userId', action: 'read' }, { rel: 'organization', action: 'read' }] },
        leave: { self: 'userId', action: 'operate' }, // the actor's own row, if it may act as itself
        manage: { rel: 'organization', action: 'manage' },
      },
    },
    document: {
      actions: {
        read: {
          any: [
            { rule: { field: 'isPublic', operator: Operator.equals, value: true } }, // abac guard
            { rel: 'organization', action: 'read' }, // rebac: walk the relation
          ],
        },
        manage: { rel: 'organization', action: 'manage' },
      },
    },
  },
};
```

`rel` accepts dot-paths for multi-hop walks — `{ rel: 'space.organization', action: 'own' }` chains
through `record.space.organization`, resolving each hop's model via the injected resolver.

Records may also carry a `permissionRules` JSON field (`action → ActionRule`); `check` merges a row
rule **additively** (OR) with the schema rule, so per-record overrides can widen but never revoke.
Validate tenant-authored overrides with `actionRuleSchema` before persisting them.

## The check engine

```ts
import { createRebacCheck } from '@inixiative/permissions';

// inject the ORM-specific INTRA-map relation resolver (e.g. derived from a Prisma model map)
const check = createRebacCheck(
  (resource, segment) => relationTargets[resource]?.[segment] ?? null,
  { selfResource: 'user' }, // where `{ self, action }` checks the actor's own action
);

check(permix, schema, { resource: 'membership', record }, 'manage');
// string → permix grant or schema delegation; { rel } walks `record.organization` (or a bridge —
// see below); { self, action } matches the actor and checks `action` on its own entry; { rule } evals json-rules; any/all compose. Cycles throw.
```

**`self` is the acting person.** `{ self: 'userId' }` passes when `record.userId` is the person
behind the actor (`selfId(actor)`: the principal's id when the principal is a `User`, else its
`userId`, else null — so an organization's credential fails every self arm closed). With an action,
`{ self: 'userId', action: 'operate' }` also requires the actor to hold `operate` on its own entry
(the `selfResource` record `{ id }`), evaluated through the schema, so a narrowed credential (one
holding only `read` on its user) doesn't pass a write arm on identity alone. Pass
`createRebacCheck(resolve, { selfResource, selfId })` to change either.

The check takes a **subject** — `{ resource, record, data? }` — not a bare record; `data` is the
supplemental rows that back cross-source bridge hops (below). `createRebacCheck` is generic over the
resource key (default `string`). Pass your resource union and the schema, `subject.resource`, and
resolver all enforce it — no casts for your own types:

```ts
type Resource = 'organization' | 'membership' | 'document';
const check = createRebacCheck<Resource>((resource, segment) => relationTargets[resource]?.[segment] ?? null);
// now `schema: RebacSchema<Resource>`, `subject.resource: Resource` — a typo is a compile error.
```

Cycle detection uses **object identity** (a `WeakMap`), not `record.id` — so id-less or
id-colliding records never produce a false "cycle", and a genuine self/mutual delegation
(`read: 'read'`) throws instead of overflowing the stack.

## The actor

The actor is plain data, like a record: what kind of thing acts (`model`), its `id`, the
**principal** whose authority it draws on, and any flat meta the app adds. `defineActor` fills the
defaults (`model` is `'User'`, the principal is the actor itself):

```ts
import { defineActor } from '@inixiative/permissions';

permix.setActor(defineActor({ id: userId })); // a person
permix.setActor(
  defineActor({
    id: tokenId,
    model: 'Token',
    principal: { model: 'OrganizationUser', id: membershipId, userId, organizationId },
    integrationId: 'i1', // meta: the integration this credential is bound to
  }),
);
```

Rules read it two ways: `{ self }` compares a record field against the person behind it (above),
and `{ actor: Condition }` is a json-rules predicate over the actor itself, dotted paths included:

```ts
const personOnly: ActionRule = { actor: { field: 'model', operator: Operator.equals, value: 'User' } };
user: { actions: { 'token.create': { all: [personOnly, 'own'] } } }, // tokens can't mint tokens
```

`{ rule }` conditions read only the record: the engine binds nothing, and `actionRuleSchema` refuses
a condition that names a bind. Identity that a grant needs is written into the grant when it is
written (see `$self` below), never bound at check time.

## Grants: held actions and rule values

A permix entry's action is `true` (held) or an `ActionRule` (a **rule-valued grant**). A rule value
is OR'd with the schema rule at the merge point, inside the same pass, so it narrows only what that
permix grants:

```ts
await permix.setup([
  { resource: 'db:integration', actions: { read: { rule: { field: 'provider', operator: 'equals', value: 'slack' } } } },
  { resource: 'db:integration', id: 'i1', actions: { manage: true } }, // that row only
]);
```

Grants stored as JSON use the same keys: a key without an id is the whole resource, `resource:id`
is that row. `entitlementEntries(entitlements, resources)` turns them into permix entries
(`parseGrantKey` splits one key; resource keys may contain `:`, the longest match wins).

**`$self` at write time.** A grant written for something it is bound to may name
`<resource>:$self`; `interpolateSelf(grant, subjects)` rewrites it to the literal id when the grant
is written, and reports every placeholder whose subject is absent so the write can be refused.
`selfPlaceholders(subjects)` lists the ones a grant may use.

```ts
interpolateSelf({ 'db:integration:$self': { manage: true } }, { 'db:integration': 'i1' });
// → { ok: true, value: { 'db:integration:i1': { manage: true } } }
```

## Several passes: permix expressions

The check takes a permix, or `any` / `all` of several, each evaluated as a full pass over the same
subject (one bridge dictionary shared). "The principal allows AND the grant allows" is:

```ts
check({ all: [principal, grant] }, schema, subject, 'read');
// a membership's own grant, bounded by its tenant, as an alternative:
check({ all: [{ any: [person, { all: [tenant, membershipGrant] }] }, grant] }, schema, subject, 'read');
```

## Collections

`collections` are checked on a **scope row** (just the parent's keys) or a **draft row** (the row
about to be created), with `{ collection: name }` in place of the action. Inside a collection rule a
string names a row action of the same resource, evaluated on that row. A resource with no rule for
the collection denies.

```ts
contact: {
  actions: { read: { rel: 'organization', action: 'read' } },
  collections: { readMany: 'read', create: { rel: 'organization', action: 'manage' } },
},
check(permix, schema, { resource: 'contact', record: { organizationId, organization } }, { collection: 'create' });
```

## Reach as a condition: `toCondition` and `implies`

`createConditionCompiler({ resolveRelation, isToMany, hasRowRules?, selfResource?, selfId? })`
returns `toCondition(expression, schema, resource, actionOrRule, 'over' | 'under')`: what a permix
expression reaches for that action, as one json-rules condition over rows of `resource` (`true` =
every row). It mirrors the engine: a held resource-wide action is `true`, id-keyed ones `id in [ids]`,
rules recurse with field paths rebased through `rel` walks, `{ self }` and `{ actor }` are constants
for the request, to-many walks are `false`. An arm it can't express (a bridge hop, a row's
`permissionRules`) is `true` when over-approximating and `false` when under-approximating.

`implies(h, i)` answers "does every row matching `h` match `i`?" syntactically: sound, incomplete.
Together they compare reaches, e.g. a grant cap "the issuer reaches at least what the holder will":

```ts
implies(toCondition(holder, schema, R, a, 'over'), toCondition(issuer, schema, R, a, 'under'));
```

## Bridges (cross-source `rel` walks)

A `rel` can cross a **bridge** — a cross-source edge between two fieldMaps (see
[`@inixiative/json-rules`](https://github.com/inixiative/json-rules)). Declare them on the schema;
both ends are map-qualified resources:

```ts
const schema: RebacSchema = {
  bridges: [{
    endpoints: [
      { fieldMap: 'crm', model: 'Account', on: 'id' },
      { fieldMap: 'db',  model: 'User',    on: 'accountId' },
    ],
    cardinality: 'oneToMany',
  }],
  permissions: {
    'db:User':     { actions: { read: { rel: 'crm:Account', action: 'own' } } },
    'crm:Account': { actions: { own: null } },
  },
};
```

Bridges **don't hydrate** (they aren't FK relations) — the engine traverses them *synthetically*.
The join key is a scalar already on the record (`User.accountId`), so a hop ending in an rbac grant
needs nothing extra. When a downstream action reads the far record's *fields* (abac / `self`), pass
those rows as `subject.data` (keyed `map:model` — the `indexBridges` shape) and the engine
builds the lookup itself:

```ts
check(permix, schema, {
  resource: 'db:User',
  record: { id: 'u1', accountId: 'acc1' },
  data: { 'crm:Account': [{ id: 'acc1', tier: 'gold' }] }, // only when far fields are needed
}, 'read');
```

## The permix wrapper

```ts
import { createPermissions } from '@inixiative/permissions';

const permix = createPermissions<'read' | 'manage' | 'own'>();
await permix.setup([{ resource: 'organization', id: 'o1', actions: { own: true } }]);
permix.setActor({ id: 'u1' });
permix.check('organization', 'own', 'o1'); // true
```

Holds the actor's grants (keyed by `resource` / `resource:id`; held actions and rule values), a
superadmin bypass, and the actor. `rules(resource, action)` and `heldIds(resource, action)` read
entries back for the engine and the condition compiler. App code populates it from roles/entitlements (hydration); the check engine reads
it back through the `PermixLike` slice.

## Hydration (Prisma example)

`check` walks relation **fields on the record you pass in** — it never queries. The robust pattern
is to make under-hydration impossible by construction: recursively load every FK-backed to-one
relation (the record's ownership closure) before checking, instead of maintaining per-action
include shapes. Then a missing relation can only mean the FK is null — a real deny, not a loading
artifact. `createHydrator` is that pattern as an injected-seam primitive: give it `parents` (the
to-one, FK-owning relations for a model) and `load` (a single read — also where you wrap caching).

Don't hand-maintain the relation map — extract it from the generated Prisma client with
[`@inixiative/prisma-map`](https://github.com/inixiative/prisma-map), and feed the **same map** to
both the resolver and the hydrator's `parents` so they can't drift:

```ts
import { buildPrismaMapV7, type RelationField } from '@inixiative/prisma-map';
import { createHydrator, createRebacCheck, type ParentRelation } from '@inixiative/permissions';

const map = buildPrismaMapV7();

// the resolver is a one-line lookup in the map
const check = createRebacCheck((resource, segment) => {
  const field = map[resource]?.fields[segment];
  return field?.kind === 'object' ? field.type : null;
});

// to-one parents: relation fields whose FK lives on this model (fromFields is empty on back-relations)
const parents = (model: string): ParentRelation[] =>
  Object.entries(map[model]?.fields ?? {})
    .filter((e): e is [string, RelationField] => e[1].kind === 'object' && !e[1].isList && e[1].fromFields.length > 0)
    .map(([field, rel]) => ({ field, model: rel.type, fk: rel.fromFields[0] }));

// load is the cache seam: the hydrator de-dupes within one call, your wrapper caches across calls
const hydrate = createHydrator({
  parents,
  load: (model, id) => cached(`${model}:${id}`, () => db[model].findFirst({ where: { id } })),
});

const doc = await hydrate('Document', await db.document.findFirstOrThrow({ where: { id } }));
check(permix, schema, { resource: 'Document', record: doc }, 'manage');
```

(`buildPrismaMapV6` covers Prisma 6 clients. The map keys models by Prisma name — `Document` — so
if your schema and delegates use accessor casing, `lowerFirst`/`upperFirst` at the boundary.)

This guarantees the vast majority of the path automatically; records are plain data, so nothing
stops you from attaching extra relations or predicate fields by hand before checking, or
special-casing relations that don't traverse cleanly (self-references, polymorphic joins) in the
resolver or a custom hydration step.

## Also exported

- `actionRuleSchema` — recursive Zod validator for a serialized `ActionRule` (validate tenant/row
  overrides). Lives on its own subpath so the core stays zod-free; `zod` is an **optional peer** —
  install it only if you use this:

  ```ts
  import { actionRuleSchema } from '@inixiative/permissions/actionRuleSchema';
  ```

## Boundary

This package owns the **wrapping and checking**. It does **not** own hydration — loading records,
deriving the relation map, mapping roles → grants, or populating permix from a user graph all stay
in the consuming app (e.g. [`@template/permissions`](https://github.com/inixiative/template) injects
its Prisma-derived `resolveRelation`, app `rebacSchema`, and role mappings — including app-specific
action sets like `ownerActions`). Action and role **naming conventions** also stay in the app —
this core makes no assumptions about what actions or roles are called.

## License

MIT
