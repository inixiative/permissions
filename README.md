# @inixiative/permissions

Generic **rebac / abac / rbac** core: a small `permix` wrapper plus a relationship-walking `check`
engine, on top of [`@inixiative/json-rules`](https://github.com/inixiative/json-rules). It is
**ORM-agnostic** — the one app-specific bit (resolving which model a relation points at) is injected,
so this package never imports a database layer. Record **hydration stays in the app**.

## Permission algebra (`ActionRule`)

```ts
type ActionRule =
  | string                       // rbac: delegate to another action on the same model
  | { rel: string; action: string }  // rebac: walk a relation, then check `action` on the target
  | { self: string }             // record[field] === actor id
  | { rule: Condition }          // abac: a json-rules predicate over the record
  | { any: ActionRule[] }        // OR
  | { all: ActionRule[] }        // AND
  | null;                        // terminal deny
```

A `RebacSchema` is `model → { actions: { name → ActionRule } }`.

## The check engine

```ts
import { createRebacCheck } from '@inixiative/permissions';

// inject the ORM-specific relation resolver (e.g. derived from a Prisma model map)
const check = createRebacCheck((model, segment) => relationTargets[model]?.[segment] ?? null);

check(permix, schema, 'membership', record, 'manage');
// string → permix grant or schema delegation; { rel } walks `record.organization`; { self }
// matches the actor; { rule } evals json-rules; any/all compose. Cycles throw, they don't loop.
```

Cycle detection uses **object identity** (a `WeakMap`), not `record.id` — so id-less or
id-colliding records never produce a false "cycle", and a genuine self/mutual delegation
(`read: 'read'`) throws instead of overflowing the stack.

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

## Also exported

- `ownerActions(rels?)` — standard action set for owner-polymorphic models (fan out to several parents).
- `actionRuleSchema` — recursive Zod validator for a serialized `ActionRule` (validate tenant/row overrides).

## Boundary

This package owns the **wrapping and checking**. It does **not** own hydration — loading records,
deriving the relation map, mapping roles → grants, or populating permix from a user graph all stay
in the consuming app (e.g. `@template/permissions` injects its Prisma-derived `resolveModel`, app
`rebacSchema`, and role mappings).

## License

MIT
