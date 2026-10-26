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
  | { rule: Condition }          // abac: a json-rules predicate over the record, the actor under `__actor`
  | { any: ActionRule[] }        // OR
  | { all: ActionRule[] }        // AND
  | null;                        // terminal deny
```

A `RebacSchema` is `{ bridges?, permissions }` — `permissions` maps a (map-qualified) **resource**,
e.g. `db:User`, to `{ actions: { name → ActionRule } }`; `bridges` are the cross-source edges a `rel`
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
        read: { any: [{ rel: 'user', action: 'read' }, { rel: 'organization', action: 'read' }] },
        leave: { rel: 'user', action: 'operate' }, // your own row: a walk to your own user entry
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
);

check(permix, schema, { resource: 'membership', record }, 'manage');
// string → permix grant or schema delegation; { rel } walks `record.organization` (or a bridge —
// see below); { rule } evals json-rules over the record (the actor under __actor); any/all compose. Cycles throw.
```

**There is no `self` arm. Identity lives in the table.** A principal holds grants only on its own
user entry, so acting on your own row is `{ rel: 'user', action }`: the walk reaches the hydrated
`record.user` and checks `action` there, through the delegation chain and custom user actions alike.
A full principal holds `own` on itself; a narrowed one (a credential holding only `read` on its
user) fails a write arm on its own row; a row without its `user` loaded is denied, never guessed
from the foreign key. `actionRuleSchema` rejects `self`.

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
(`read: 'read'`) throws instead of overflowing the stack. The key includes the table being
walked, so an entitlement's owner revisiting the same node is not a cycle. A loop built from grant
data (two holders owning each other's entitlements) is not a schema bug and does not throw: the
back edge contributes nothing, and only a chain that reaches a real grant allows.

## The actor

The actor is who is acting: what kind of credential (`model`) and its row (`record`). The app sets
it once per request; a `{ rule }` reads it under the reserved key `__actor`, like any other data:

```ts
permix.setActor({ model: 'User', record: user });   // a person, acting directly
permix.setActor({ model: 'Token', record: token }); // a token, with whatever owner relations you loaded

// person-only
{ rule: { field: '__actor.model', operator: Operator.equals, value: 'User' } }
// the record against the actor's row
{ rule: { field: 'ownerId', operator: Operator.equals, path: '__actor.record.userId' } }
```

It is just a rule. With nobody acting, `__actor` is null and the rule runs as written; a rule that
needs someone acting says so (`{ field: '__actor', operator: 'notEmpty', value: true }` inside its
`all`). A row's `permissionRules` read it the same way and still only widen. A superadmin skips
the schema, so it skips these too.

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
needs nothing extra. When a downstream action reads the far record's *fields* (abac), pass
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

Holds the actor's role-derived grants (keyed by `resource` / `resource:id`), its entitlements, a
superadmin bypass, and the actor. App code populates it from roles and entitlements (hydration
stays app-side); the check engine reads it back through the `PermixLike` slice.

### Entitlements

A grant says what a role holds. An entitlement says what a holder (a token, a membership, an
integration) was given beyond its role: **an action, on a resource, from an anchor, with an
optional `where`**. It is installed with the table of whoever granted it, bound once per `setup`
call because the grantor is on the holder's row, never in the entitlement:

```ts
const o1 = createPermissions();
await o1.setup({ resource: 'db:organization', id: 'o1', actions: { own: true } });

await permix.setup(
  [
    // manage space s1 (and what is under it)
    { resource: 'db:space', anchor: { resource: 'db:space', id: 's1' }, actions: { manage: true } },
    // manage the slack integrations of s1
    {
      resource: 'db:integration',
      anchor: { resource: 'db:space', id: 's1' },
      where: { field: 'provider', operator: Operator.equals, value: 'slack' },
      actions: { manage: true },
    },
  ],
  { owner: o1 },
);
```

Entitlements never enter the table. The engine consults them at a node only after the table and
the schema rule both miss, with the record in hand, and one applies when all three hold:

- **`anchor` is on the record's natural tree** — the record itself, or an ancestor reached through
  the relations that resource's own `rel` arms name. A hydrated sideways foreign key is not a
  anchor. Off the tree, the entitlement is not acting from where it says.
- **`where` holds** — plain json-rules over the record at that node, `field` and `path` both
  starting there and free to climb hydrated parents (`space.organizationId`). Whatever referred to
  the holder (its own id, its user) is written in as a literal when the grant is made. An absent
  path reads as NULL, so write `where` positively. `where: false` or `null` is a `where` that fails,
  not its absence.
- **The grantor is still in control** — the owner's table, walked from this very record through
  the normal schema, allows the action. That is the only tenancy check and it is live: a space
  moved to another org stops reaching the grantor on the next request, no fetch. The record's
  schema guards run inside that walk, and a `{ rule }` met there still sees the
  request's actor as `__actor`. A holder can never exceed its owner on the same record and action; owners nest
  (token ← membership ← org) because an owner's table carries its own entitlements.

`setup` refuses an entitlement without an `owner`, a `where` without a `anchor`, an `id` beside a
`anchor` (a single row is `where: { field: 'id', … }`), a non-boolean action, or a malformed
rule, before touching any state. `replace: true` clears entitlements with the table. `getJSON`
carries grants only. Tenancy is as live as the owner's grants are id-keyed: an owner table with a
resource-wide grant, or the superadmin flag, short-circuits before any walk.

#### Granting one

A grant is an action, and grant time mirrors read time through the same check. Build the grant
check with the same resolver as the rebac check, then ask it with the writer's table and the
hydrated record at `anchor`:

```ts
const canGrantEntitlement = createCanGrantEntitlement(resolveRelation);

canGrantEntitlement(writer, schema, {
  resource: 'db:integration',
  anchor: { resource: 'db:space', id: 's1' },
  actions: { manage: true },
}, s1); // can the writer manage every integration under s1?
```

Each action the entry grants is checked on a stand-in record of `entry.resource` placed under the
anchor along that resource's own `rel` tree. The writer's own entitlements and owner chain apply,
so a token never grants past its holder, and a `{ rule }` sees the writer's actor as `__actor`. A `where` only
narrows, so the writer must cover the whole collection at the anchor.

An action's rule is ReBAC (walks to parents) plus ABAC (`{ rule }` conditions on the record,
conditions on `__actor`, who acts). Granting checks the ReBAC at the anchor; the ABAC runs at read
time, because the holder's check walks the writer's table on the real record with the request's
actor. A holder of a granted action reaches exactly as far as its writer would on that record.

```ts
// assign: high roles need own, others need manage
assign: {
  any: [
    { all: [{ rule: { field: 'role', operator: 'in', value: ['owner', 'admin'] } }, 'own'] },
    { all: [{ rule: { field: 'role', operator: 'notIn', value: ['owner', 'admin'] } }, 'manage'] },
  ],
}
// An admin (manage) grants assign; its holder assigns member-role records, never owners.

// token.create: { all: [{ rule: { field: '__actor.model', operator: 'equals', value: 'User' } }, 'operate'] }
// A member grants token.create; a token holding it mints nothing, because the actor is a token.
```

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
deriving the relation map, mapping roles → grants, building an entitlement's owner table, or
populating permix from a user graph all stay in the consuming app (e.g. [`@template/permissions`](https://github.com/inixiative/template) injects
its Prisma-derived `resolveRelation`, app `rebacSchema`, and role mappings — including app-specific
action sets like `ownerActions`). Action and role **naming conventions** also stay in the app —
this core makes no assumptions about what actions or roles are called.

## License

MIT
