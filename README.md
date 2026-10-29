# @inixiative/permissions

Generic **rebac / abac / rbac** core: a small `permix` wrapper plus a relationship-walking `check`
engine, on top of [`@inixiative/json-rules`](https://github.com/inixiative/json-rules). The app
passes its **schema map** — which model each resource is, its relations and foreign keys (a
[`@inixiative/prisma-map`](https://github.com/inixiative/prisma-map) map in the inixiative stack),
and its polymorphic models' kinds — so the core never imports a database layer itself. Record
**loading and hydration stay in the app**.

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
through `record.space.organization`, resolving each hop's model from the schema map.

Records may also carry a `permissionRules` JSON field (`action → ActionRule`); `check` merges a row
rule **additively** (OR) with the schema rule, so per-record overrides can widen but never revoke.
Validate tenant-authored overrides with `validateActionRule` before persisting them.

## The check engine

```ts
import { createRebacCheck, type SchemaMap } from '@inixiative/permissions';

// the schema the walk reads: which fieldMap model each resource is, its relations and foreign keys
// (a json-rules FieldMap, structurally a prisma-map), and the polymorphic models' kinds
const map: SchemaMap = { resources, fieldMap: prismaMap, polymorphism };
const check = createRebacCheck(map);

check(permix, schema, { resource: 'membership', record }, 'manage');
// string → permix grant or schema delegation; { rel } walks `record.organization` (or a bridge —
// see below); { rule } evals json-rules over the record (the actor under __actor); any/all compose. Cycles throw.
```

**There is no `self` arm. Identity lives in the table.** A principal holds grants only on its own
user entry, so acting on your own row is `{ rel: 'user', action }`: the walk reaches the hydrated
`record.user` and checks `action` there, through the delegation chain and custom user actions alike.
A full principal holds `own` on itself; a narrowed one (a credential holding only `read` on its
user) fails a write arm on its own row; a row without its `user` loaded is denied, never guessed
from the foreign key. `validateActionRule` rejects `self`.

The check takes a **subject** — `{ resource, record, data? }` — not a bare record; `data` is the
supplemental rows that back cross-source bridge hops (below). `resources` gives each resource its own model (`createRebacCheck` refuses two resources on one
model). `createRebacCheck` is generic over the
resource key (default `string`). Pass your resource union and the schema, `subject.resource`, and
map all enforce it — no casts for your own types:

```ts
type Resource = 'organization' | 'membership' | 'document';
const check = createRebacCheck<Resource>(map); // map: SchemaMap<Resource>
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

Bridges **don't hydrate** (they aren't FK relations). The join key is a scalar on the record
(`User.accountId`); pass the far rows as `subject.data` (keyed `map:model` — the `indexBridges`
shape) and the engine builds the lookup itself. A far row absent from `subject.data` denies the
walk, whatever the far action is, an rbac grant on the far id included:

```ts
check(permix, schema, {
  resource: 'db:User',
  record: { id: 'u1', accountId: 'acc1' },
  data: { 'crm:Account': [{ id: 'acc1', tier: 'gold' }] },
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
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      where: { field: 'provider', operator: Operator.equals, value: 'slack' },
      actions: { manage: true },
    },
  ],
  { owner: o1 },
);
```

Entitlements never enter the table. The engine consults them at a node only after the table and
the schema rule both miss, with the record in hand, and one applies when all three hold:

- **Its `anchor` is reached along its `path`** — `anchor.path` names the relations from the
  record up to the anchor (`'space.organization'`); the hydrated record at the end of the path is
  the anchor (its resource and id). Only the anchor's id is fixed: a record that moves inside the
  anchor stays reached, one that moves out stops. The path picks the side when a record hangs from
  two parents of one model (`targetOrganization`, not `sourceOrganization`), so a relation the path
  does not name never counts, and a path through a list relation reaches nothing. A record anchored
  at itself has no path. The action is checked on the record, never asked of the anchor.
  **A polymorphic step admits every kind that carries its keys.** A polymorphic record carries the
  ids of everything above it, so `organization` on an integration admits each kind whose registry
  columns (`map.polymorphism`) hold `organizationId`: the organization's own, a space's, a
  member's, a space member's. The step passes when the record is one of those kinds; the `where`
  narrows them (`ownerModel equals Organization` is the organization's own; `ownerModel in [...]` keeps the kinds it names). A side is a
  different axis, so `targetOrganization` reaches what an organization received and never what it
  sent.
- **`where` holds** — the `where` is plain json-rules over the record at that node, `field` and `path` both
  starting there and free to climb hydrated parents (`space.organizationId`). Whatever referred to
  the holder (its own id, its user) is written in as a literal when the grant is made. A `where`
  is positive (json-rules `validateRule(where, { positive: true })`): no negation, `isEmpty`,
  `notExists`, `if`/`then`/`else`, array or aggregate rule, so it never passes on what is not
  loaded; "no value" is `equals null`. `where: false` is a `where` that fails, not its absence;
  `where: null` is refused at setup.
- **The grantor is still in control** — the owner's table, walked from this very record through
  the normal schema, allows the action. That is the only tenancy check and it is live: a space
  moved to another org stops reaching the grantor on the next request, no fetch. The record's
  schema guards run inside that walk, and a `{ rule }` met there still sees the
  request's actor as `__actor`. A holder can never exceed its owner on the same record and action; owners nest
  (token ← membership ← org) because an owner's table carries its own entitlements.

`setup` refuses an entitlement without an `owner`, a `where` without a `anchor`, an `anchor` on
another resource without a `path` or on its own resource with one, an `id` beside a
`anchor` (a single row is `where: { field: 'id', … }`), a non-boolean action, `where: null`, or a
malformed or non-positive rule, before touching any state. `replace: true` clears entitlements with the table. `getJSON`
carries grants only. Tenancy is as live as the owner's grants are id-keyed: an owner table with a
resource-wide grant, or the superadmin flag, short-circuits before any walk.

#### Granting one

A grant is an action, and grant time mirrors read time through the same check. Build the grant
check with the same map as the rebac check, place the entry on the hydrated anchor, and ask:

```ts
const canGrantEntitlement = createCanGrantEntitlement(map);

const entry = {
  resource: 'db:integration',
  anchor: { resource: 'db:space', id: 's1', path: 'space' },
  where: { field: 'provider', operator: 'equals', value: 'slack' },
  actions: { manage: true },
};
const placed = placeEntitlement(map, entry, await hydrate('Space', space)); // null: malformed
placed?.every((record) => canGrantEntitlement(writer, schema, entry, record)); // every Slack integration of s1?
```

`placeEntitlement` first refuses a malformed entry (null), by the rules `setup` applies at install, so validity and the grant are one check before saving. It then builds the pseudo records of `entry.resource` from the anchor down the path (`placeUnder`, also exported for placing a record you are about to create): at
each step the foreign keys whose values the parent knows, the parent attached under the
relation, ids below the anchor unknown; on a polymorphic step one record per kind it admits, each
with its owner placed under the anchor along every relation that leads there. The `where`'s root
leaves (the `where` itself, or each leaf of its top `all`; nothing nested) with a literal `value`
are checked on what the path fixes for each record (its first step's foreign keys and kind): a
record a leaf fails is dropped (`ownerModel in [Organization, Space]` keeps those two kinds;
`organizationId equals o2` under o1 keeps none). A leaf on anything else (the placed owner, a
dotted field, a column the path leaves open), a leaf reading its value from a path, and anything
nested narrow nothing: dropping a record loosens the grant, so only a value every real record of
that kind shares may drop it. The writer must pass on every record left. The root's exact
`equals` leaves (`equals null` pins `null`) fill the rest (a pin on a foreign key the path leaves
unknown stays, and the rules still walk the placed relation). It returns `null` when no record is
left, the anchor row is not the entry's, or the path does not end at the anchor's model through
to-one relations. A self
anchor is the anchor row itself. The writer must take each action on `placed`. The check reads `placed` with json-rules `absent: 'unknown'`: a field
it does not carry fails every positive leaf, `equals null` included, so a writer whose authority
reads a field the `where` leaves open is refused, and only a writer unfiltered on it passes. The
writer's own entitlements and owner chain apply, so a token never grants past its holder, and a
`{ rule }` sees the writer's actor as `__actor`. Rules are positive (`validateActionRule` refuses
the rest), which is what makes a pass on `placed` hold for every record the `where` admits.

An action's rule is ReBAC (walks to parents) plus ABAC (`{ rule }` conditions on the record,
conditions on `__actor`, who acts). Granting checks the ReBAC at the anchor; the ABAC runs at read
time, because the holder's check walks the writer's table on the real record with the request's
actor. A holder of a granted action reaches exactly as far as its writer would on that record.

```ts
// assign: high roles need own, others need manage
assign: {
  any: [
    { all: [{ rule: { field: 'role', operator: 'in', value: ['owner', 'admin'] } }, 'own'] },
    { all: [{ rule: { field: 'role', operator: 'in', value: ['member', 'viewer'] } }, 'manage'] },
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
both the schema map and the hydrator's `parents` so they can't drift:

```ts
import { buildPrismaMapV7, type RelationField } from '@inixiative/prisma-map';
import { createHydrator, createRebacCheck, type ParentRelation } from '@inixiative/permissions';

const map = buildPrismaMapV7();

const check = createRebacCheck({
  resources: { Document: 'Document', Team: 'Team' },
  fieldMap: { models: map },
  polymorphism, // your false-polymorphism registry, if you have one
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
special-casing relations that don't traverse cleanly (self-references) in a custom hydration step.

## Also exported

- `validateActionRule(rule)` — checks a serialized `ActionRule` (tenant/row overrides) the way
  json-rules `validateRule` checks a condition, and returns the same `{ ok, errors }`: the shape,
  and every `{ rule }` a positive json-rules condition. No schema library involved.

## Boundary

This package owns the **wrapping, checking and grant placement**. It does **not** own loading —
fetching records, hydrating them, mapping roles → grants, building an entitlement's owner table, or
populating permix from a user graph all stay in the consuming app (e.g. [`@template/permissions`](https://github.com/inixiative/template) passes
its generated prisma map and polymorphism registry, app `rebacSchema`, and role mappings — including app-specific
action sets like `ownerActions`). Action and role **naming conventions** also stay in the app —
this core makes no assumptions about what actions or roles are called.

## License

MIT
