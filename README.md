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
  | { self: string }             // record[field] === actor id
  | { rule: Condition }          // abac: a json-rules predicate over the record
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
        read: { any: [{ self: 'userId' }, { rel: 'organization', action: 'read' }] },
        leave: { self: 'userId' }, // the actor's own row
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
const check = createRebacCheck((resource, segment) => relationTargets[resource]?.[segment] ?? null);

check(permix, schema, { resource: 'membership', record }, 'manage');
// string → permix grant or schema delegation; { rel } walks `record.organization` (or a bridge —
// see below); { self } matches the actor; { rule } evals json-rules; any/all compose. Cycles throw.
```

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
those rows as `subject.data` (keyed `map:model` — the `buildBridgeDictionary` shape) and the engine
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
permix.setUserId('u1');
permix.check('organization', 'own', 'o1'); // true
```

Holds the actor's role-derived grants (keyed by `resource` / `resource:id`), a superadmin bypass,
and the actor id. App code populates it from roles/entitlements (hydration); the check engine reads
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
