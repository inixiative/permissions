import { describe, expect, test } from 'bun:test';
import { type Condition, Operator } from '@inixiative/json-rules';
import {
  type Anchor,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type PermixLike,
  type RebacSchema,
  type Row,
} from '../index';

// An entitlement: an action, on a model, FROM an anchor on the record's chain, with an optional
// `where` over the record. The owner (who granted it) is bound once per setup call, from the row.
const entitle = (permix: Permix, entries: EntitlementEntry[], owner?: PermixLike) =>
  permix.setup(entries, { owner });

const is = (field: string, value: string): Condition => ({
  field,
  operator: Operator.equals,
  value,
});

const inPerson: Condition = { field: '__actor.model', operator: Operator.equals, value: 'User' };

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:user': { actions: { own: null, 'token.create': { all: [{ rule: inPerson }, 'own'] } } },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
      },
    },
    'db:integration': {
      actions: {
        own: { rel: 'space', action: 'own' },
        manage: { any: ['own', { rel: 'space', action: 'manage' }] },
        read: { any: ['manage', { rel: 'space', action: 'read' }] },
      },
    },
    'db:contact': {
      actions: {
        own: { rel: 'space', action: 'own' },
        manage: {
          all: [
            {
              rule: {
                field: 'valueKey',
                operator: Operator.notEquals,
                path: '__actor.record.email',
              },
            },
            { any: ['own', { rel: 'space', action: 'manage' }] },
          ],
        },
      },
    },
  },
};

const relations: Record<string, Record<string, string>> = {
  'db:space': { organization: 'db:organization' },
  'db:integration': { space: 'db:space', replacedBy: 'db:integration' },
  'db:contact': { space: 'db:space' },
};
const check = createRebacCheck((resource, segment) => relations[resource]?.[segment] ?? null);

const o1 = { id: 'o1' };
const o2 = { id: 'o2' };
const u1 = { id: 'u1' };
const space = (id: string, organization: Row, name = 'x') => ({
  id,
  name,
  organizationId: organization.id,
  organization,
});
const integration = (id: string, s: Row, provider = 'slack') => ({
  id,
  provider,
  spaceId: s.id,
  space: s,
});
const contact = (id: string, s: Row, fields: Row = {}) => ({
  id,
  spaceId: s.id,
  space: s,
  ...fields,
});

const s1 = space('s1', o1);
const s1moved = space('s1', o2);
const s2 = space('s2', o1);

const at = (resource: string, id: string): Anchor => ({ resource, id });
const AT_S1 = at('db:space', 's1');

const table = async (...entries: PermissionEntry[]) => {
  const permix = createPermissions();
  await permix.setup(entries);
  return permix;
};
const own = (resource: string, id: string): PermissionEntry => ({
  resource,
  id,
  actions: { own: true },
});

// The grantors, built the way the app builds any principal: an org owns itself.
const o1Table = () => table(own('db:organization', 'o1'));

const manage = (permix: Permix, resource: string, record: Row) =>
  check(permix, schema, { resource, record }, 'manage');

describe('entitlements: an action on a model from an anchor, owner on the row', () => {
  test('1. manage s1: the space, read through it, not own, an integration under it, not s2', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:space', s1)).toBe(true);
    expect(check(holder, schema, { resource: 'db:space', record: s1 }, 'read')).toBe(true);
    expect(check(holder, schema, { resource: 'db:space', record: s1 }, 'own')).toBe(false);
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(holder, 'db:space', s2)).toBe(false);
  });

  test('2. same entitlement, s1 transferred to o2: nothing', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:space', s1moved)).toBe(false);
    expect(manage(holder, 'db:integration', integration('i1', s1moved))).toBe(false);
  });

  test('2b. s1 transferred to o2, and the same user is also a member of o2: still nothing', async () => {
    // ou1's row: manage s1, granted by o1. ou2's row: plain member of o2. One merged holder table.
    const holder = await table({
      resource: 'db:organization',
      id: 'o2',
      actions: { operate: true },
    });
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:space', s1moved)).toBe(false);
    expect(check(holder, schema, { resource: 'db:space', record: s1moved }, 'read')).toBe(false);
    // Only an o2 role reaches the moved space, and that is the role being right, not the entitlement.
    await holder.setup({ resource: 'db:organization', id: 'o2', actions: { manage: true } });
    expect(manage(holder, 'db:space', s1moved)).toBe(true);
  });

  test('3. the integrations of s1: not another space’s, not after the transfer, not the space', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:integration', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(holder, 'db:integration', integration('i2', s2))).toBe(false);
    expect(manage(holder, 'db:integration', integration('i1', s1moved))).toBe(false);
  });

  test('4. the slack integrations of s1', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [
        {
          resource: 'db:integration',
          anchor: AT_S1,
          actions: { manage: true },
          where: is('provider', 'slack'),
        },
      ],
      await o1Table(),
    );
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(holder, 'db:integration', integration('i3', s1, 'github'))).toBe(false);
  });

  test('5. an integration manages itself: its id is written into `where` at grant time', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [
        {
          resource: 'db:integration',
          anchor: AT_S1,
          actions: { manage: true },
          where: is('id', 'i1'),
        },
      ],
      await o1Table(),
    );
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(holder, 'db:integration', integration('i2', s1))).toBe(false);
  });

  test('6. a role grant and an entitlement on the same key each hold on their own terms', async () => {
    const holder = await table({ resource: 'db:space', id: 's1', actions: { read: true } });
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    expect(check(holder, schema, { resource: 'db:space', record: s1moved }, 'read')).toBe(true);
    expect(manage(holder, 'db:space', s1moved)).toBe(false);
    expect(manage(holder, 'db:space', s1)).toBe(true);
  });

  describe('7. recursive: token ← org-user ← org', () => {
    const member = (): PermissionEntry => ({
      resource: 'db:organization',
      id: 'o1',
      actions: { operate: true },
    });
    const admin = (): PermissionEntry => ({
      resource: 'db:organization',
      id: 'o1',
      actions: { manage: true },
    });
    const manageS1: EntitlementEntry = {
      resource: 'db:space',
      anchor: AT_S1,
      actions: { manage: true },
    };
    const tokenOf = async (membership: Permix) => {
      const token = createPermissions();
      await entitle(token, [manageS1], membership);
      return token;
    };

    test('the org-user holds it from the org, so its token may hold it from the org-user', async () => {
      const m1 = await table(member());
      await entitle(m1, [manageS1], await o1Table());
      expect(manage(await tokenOf(m1), 'db:space', s1)).toBe(true);
      expect(manage(await tokenOf(m1), 'db:space', s1moved)).toBe(false);
    });

    test('the org-user lacks it, so the token’s entitlement fails', async () => {
      expect(manage(await tokenOf(await table(member())), 'db:space', s1)).toBe(false);
    });

    test('the org-user’s role grounds it instead', async () => {
      expect(manage(await tokenOf(await table(admin())), 'db:space', s1)).toBe(true);
    });
  });

  test('8. a schema guard survives: the owner’s walk runs it on the record', async () => {
    const holder = createPermissions();
    holder.setActor({ model: 'User', record: { id: 'u1', email: 'me@example.com' } });
    await entitle(
      holder,
      [{ resource: 'db:contact', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:contact', contact('c1', s1, { valueKey: 'me@example.com' }))).toBe(
      false,
    );
    expect(manage(holder, 'db:contact', contact('c2', s1, { valueKey: 'other@example.com' }))).toBe(
      true,
    );
  });

  test('9. `from` off the record’s path: no longer valid', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:integration', anchor: at('db:space', 's2'), actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(false);
    expect(manage(holder, 'db:integration', integration('i2', s2))).toBe(true);
  });

  test('10. `where` through an unhydrated parent fails, it does not guess', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [
        {
          resource: 'db:integration',
          anchor: at('db:integration', 'i1'),
          actions: { manage: true },
          where: is('space.organizationId', 'o1'),
        },
      ],
      await o1Table(),
    );
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(holder, 'db:integration', { id: 'i1', provider: 'slack', spaceId: 's1' })).toBe(
      false,
    );
  });

  test('11. an owner loop built from grant data denies: never a stack overflow, never an error', async () => {
    const manageS1: EntitlementEntry = {
      resource: 'db:space',
      anchor: AT_S1,
      actions: { manage: true },
    };
    const a = createPermissions();
    const b = createPermissions();
    await entitle(a, [manageS1], b);
    await entitle(b, [manageS1], a);
    expect(manage(a, 'db:space', s1)).toBe(false);

    const self = createPermissions();
    await entitle(self, [manageS1], self);
    expect(manage(self, 'db:space', s1)).toBe(false);

    // a looping sibling cannot hide the entitlement that does grant
    const c = createPermissions();
    const d = createPermissions();
    await entitle(c, [manageS1], d);
    await entitle(d, [manageS1], c);
    await entitle(c, [manageS1], await o1Table());
    expect(manage(c, 'db:space', s1)).toBe(true);
  });

  test('12. tenancy is as live as the owner’s grants: a resource-wide owner grant never walks', async () => {
    const owner = await table({ resource: 'db:integration', actions: { manage: true } });
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:integration', anchor: AT_S1, actions: { manage: true } }],
      owner,
    );
    expect(manage(holder, 'db:integration', integration('i1', s1moved))).toBe(true);
  });

  test('13. replace drops entitlements too', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true } }],
      await o1Table(),
    );
    await holder.setup([own('db:organization', 'o2')], { replace: true });
    expect(manage(holder, 'db:space', s1)).toBe(false);
  });

  test('14. a malformed `where` is refused when it is installed', async () => {
    const holder = createPermissions();
    const entry = { resource: 'db:space', anchor: AT_S1, actions: { manage: true } };
    await expect(
      entitle(
        holder,
        [{ ...entry, where: { operator: 'nope' } as unknown as Condition }],
        await o1Table(),
      ),
    ).rejects.toThrow();
  });

  test('15. `from` needs an owner; a false action grants nothing', async () => {
    const holder = createPermissions();
    await expect(
      entitle(holder, [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true } }]),
    ).rejects.toThrow();
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: false } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:space', s1)).toBe(false);
  });

  test('16. the actor is always the request’s actor, inside the owner’s walk too', async () => {
    // The owner is the person u1, acting in person; its table would pass the in-person arm on its own.
    const owner = await table(own('db:user', 'u1'));
    owner.setActor({ model: 'User', record: { id: 'u1' } });
    const holder = createPermissions();
    holder.setActor({ model: 'Token', record: { id: 't1' } });
    await entitle(
      holder,
      [{ resource: 'db:user', anchor: at('db:user', 'u1'), actions: { 'token.create': true } }],
      owner,
    );
    // token.create = all[in person, own]: the token has no `own`, so it needs the owner's walk, and
    // inside that walk the in-person arm must still see the token, not the owner.
    expect(check(holder, schema, { resource: 'db:user', record: u1 }, 'token.create')).toBe(false);
    holder.setActor({ model: 'User', record: { id: 'u1' } });
    expect(check(holder, schema, { resource: 'db:user', record: u1 }, 'token.create')).toBe(true);
  });

  test('16b. the owner is checked on the record, not on the anchor', async () => {
    const owner = await table({ resource: 'db:integration', id: 'i1', actions: { manage: true } });
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:integration', anchor: AT_S1, actions: { manage: true } }],
      owner,
    );
    expect(manage(holder, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(holder, 'db:integration', integration('i2', s1))).toBe(false);
  });

  test('16c. an owner’s `where`, written at grant time, bounds what a token inherits', async () => {
    // m1 was granted "manage the contacts of s1 that belong to u1" — u1 written in at grant time.
    const m1 = await table({ resource: 'db:organization', id: 'o1', actions: { operate: true } });
    await entitle(
      m1,
      [
        {
          resource: 'db:contact',
          anchor: AT_S1,
          actions: { manage: true },
          where: is('userId', 'u1'),
        },
      ],
      await o1Table(),
    );
    const t1 = createPermissions();
    t1.setActor({ model: 'Token', record: { id: 't1', email: 'token@example.com' } });
    await entitle(t1, [{ resource: 'db:contact', anchor: AT_S1, actions: { manage: true } }], m1);
    expect(manage(t1, 'db:contact', contact('c1', s1, { userId: 'u1', valueKey: 'k' }))).toBe(true);
    expect(manage(t1, 'db:contact', contact('c2', s1, { userId: 'u2', valueKey: 'k' }))).toBe(
      false,
    );
  });

  test('16d. `where` sees the record at the entitlement’s node, not the subject', async () => {
    const holder = createPermissions();
    holder.setActor({ model: 'User', record: { id: 'u1', email: 'me@example.com' } });
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: AT_S1, actions: { manage: true }, where: is('name', 'x') }],
      await o1Table(),
    );
    expect(
      manage(holder, 'db:contact', contact('c1', space('s1', o1, 'x'), { valueKey: 'k' })),
    ).toBe(true);
    expect(
      manage(
        holder,
        'db:contact',
        contact('c1', space('s1', o1, 'y'), { valueKey: 'k', name: 'x' }),
      ),
    ).toBe(false);
  });

  test('17. `where` is plain traversal from the node’s record: field and path both climb hydrated parents', async () => {
    const s1slack = { ...s1, defaultProvider: 'slack' };
    const holder = createPermissions();
    await entitle(
      holder,
      [
        {
          resource: 'db:integration',
          anchor: AT_S1,
          actions: { manage: true },
          where: {
            all: [
              // a parent's column, read through the hydrated relation
              { field: 'space.organization.id', operator: Operator.equals, value: 'o1' },
              // the record's own column against a parent's column: `path` starts at the same record
              { field: 'provider', operator: Operator.equals, path: 'space.defaultProvider' },
            ],
          },
        },
      ],
      await o1Table(),
    );
    expect(manage(holder, 'db:integration', integration('i1', s1slack, 'slack'))).toBe(true);
    expect(manage(holder, 'db:integration', integration('i2', s1slack, 'github'))).toBe(false);
    // the parent is there but carries no default: NULL on the right-hand side, so equals fails
    expect(manage(holder, 'db:integration', integration('i3', s1, 'slack'))).toBe(false);
  });
});

describe('entitlements: edges the review asked for', () => {
  const manageS1: EntitlementEntry = {
    resource: 'db:space',
    anchor: AT_S1,
    actions: { manage: true },
  };
  const integrationsOfS1: EntitlementEntry = {
    resource: 'db:integration',
    anchor: AT_S1,
    actions: { manage: true },
  };

  test('`from` follows the resource’s natural tree only: a hydrated sideways foreign key is not an anchor', async () => {
    const holder = createPermissions();
    await entitle(holder, [{ ...integrationsOfS1, anchor: at('db:space', 's2') }], await o1Table());
    const replaced = { ...integration('i1', s1), replacedBy: integration('i9', s2) };
    expect(manage(holder, 'db:integration', replaced)).toBe(false);
  });

  test('`from` two hops up: every space of o1', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [{ resource: 'db:space', anchor: at('db:organization', 'o1'), actions: { manage: true } }],
      await o1Table(),
    );
    expect(manage(holder, 'db:space', s1)).toBe(true);
    expect(manage(holder, 'db:space', s2)).toBe(true);
    expect(manage(holder, 'db:integration', integration('i1', s2))).toBe(true);
    expect(manage(holder, 'db:space', s1moved)).toBe(false);
  });

  test('`where: false` is a `where`, not its absence', async () => {
    const holder = createPermissions();
    await entitle(holder, [{ ...manageS1, where: false }], await o1Table());
    expect(manage(holder, 'db:space', s1)).toBe(false);
  });

  test('a negated `where` on an unloaded path passes: write `where` positively', async () => {
    const holder = createPermissions();
    await entitle(
      holder,
      [
        {
          ...integrationsOfS1,
          anchor: at('db:integration', 'i1'),
          where: { field: 'space.archivedAt', operator: Operator.notEquals, value: 'x' },
        },
      ],
      await table({ resource: 'db:integration', id: 'i1', actions: { manage: true } }),
    );
    expect(manage(holder, 'db:integration', { id: 'i1', provider: 'slack' })).toBe(true);
  });

  test('a superadmin owner is unfenced: `from` and `where` still narrow, tenancy does not', async () => {
    const owner = createPermissions();
    owner.setSuperadmin(true);
    const holder = createPermissions();
    await entitle(holder, [integrationsOfS1], owner);
    expect(manage(holder, 'db:integration', integration('i1', s1moved))).toBe(true);
    expect(manage(holder, 'db:integration', integration('i2', s2))).toBe(false);
  });

  test('setup is atomic: one bad entry in an array installs nothing', async () => {
    const holder = createPermissions();
    await expect(
      entitle(
        holder,
        [manageS1, { ...manageS1, anchor: { resource: 'db:space', id: '' } }],
        await o1Table(),
      ),
    ).rejects.toThrow(/`anchor` is/);
    expect(manage(holder, 'db:space', s1)).toBe(false);
  });

  test('setup refuses what the types cannot: `id` with `anchor`, a grant with `where`, a function action', async () => {
    const holder = createPermissions();
    const owner = await o1Table();
    await expect(
      holder.setup([{ ...manageS1, id: 's1' } as PermissionEntry], { owner }),
    ).rejects.toThrow(/`anchor` with `id`/);
    await expect(
      holder.setup([
        {
          resource: 'db:space',
          id: 's1',
          actions: { manage: true },
          where: is('name', 'x'),
        } as PermissionEntry,
      ]),
    ).rejects.toThrow(/`where` needs `anchor`/);
    await expect(
      holder.setup([{ ...manageS1, actions: { manage: () => true } } as PermissionEntry], {
        owner,
      }),
    ).rejects.toThrow(/booleans/);
    await expect(
      holder.setup([{ ...manageS1, anchor: null } as unknown as PermissionEntry], { owner }),
    ).rejects.toThrow(/`anchor` is/);
    // a row spread with an undefined `id` is still a plain entitlement
    await holder.setup([{ ...manageS1, id: undefined } as PermissionEntry], { owner });
    expect(manage(holder, 'db:space', s1)).toBe(true);
  });

  test('getJSON carries grants only: entitlements are not serializable', async () => {
    const holder = await table({ resource: 'db:space', id: 's1', actions: { read: true } });
    await entitle(holder, [manageS1], await o1Table());
    expect(holder.getJSON()).toEqual({ 'db:space:s1': { read: true } });
  });
});

describe('the chain: token ← org-user’s entitlement ← organization’s right', () => {
  const manageS1: EntitlementEntry = {
    resource: 'db:space',
    anchor: AT_S1,
    actions: { manage: true },
  };
  const readS1: EntitlementEntry = { resource: 'db:space', anchor: AT_S1, actions: { read: true } };
  const integrationsOfS1: EntitlementEntry = {
    resource: 'db:integration',
    anchor: AT_S1,
    actions: { manage: true },
  };
  const spacesOfO1: EntitlementEntry = {
    resource: 'db:space',
    anchor: at('db:organization', 'o1'),
    actions: { manage: true },
  };

  // An org-user row: its role on o1, plus whatever o1 granted it.
  const orgUser = async (
    role: 'member' | 'admin',
    granted: EntitlementEntry[] = [],
    by?: PermixLike,
  ) => {
    const m = await table({
      resource: 'db:organization',
      id: 'o1',
      actions: role === 'admin' ? { manage: true } : { operate: true },
    });
    if (granted.length) await entitle(m, granted, by ?? (await o1Table()));
    return m;
  };
  // A token row owned by that org-user, holding what the org-user granted it.
  const tokenOf = async (owner: PermixLike, granted: EntitlementEntry[]) => {
    const t = createPermissions();
    await entitle(t, granted, owner);
    return t;
  };
  const read = (permix: Permix, resource: string, record: Row) =>
    check(permix, schema, { resource, record }, 'read');

  test('intact: token → org-user → org, and the transfer kills it at every level', async () => {
    const t = await tokenOf(await orgUser('member', [manageS1]), [manageS1]);
    expect(manage(t, 'db:space', s1)).toBe(true);
    expect(manage(t, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(t, 'db:space', s1moved)).toBe(false);
  });

  test('the token’s entitlement is wider than the org-user’s: nothing, not even the narrower action', async () => {
    const t = await tokenOf(await orgUser('member', [readS1]), [manageS1]);
    expect(manage(t, 'db:space', s1)).toBe(false);
    expect(read(t, 'db:space', s1)).toBe(false);
  });

  test('the token’s entitlement is narrower: only the narrower action', async () => {
    const t = await tokenOf(await orgUser('member', [manageS1]), [readS1]);
    expect(read(t, 'db:space', s1)).toBe(true);
    expect(manage(t, 'db:space', s1)).toBe(false);
  });

  test('the token narrows by resource: the integrations of s1, not the space', async () => {
    const t = await tokenOf(await orgUser('member', [manageS1]), [integrationsOfS1]);
    expect(manage(t, 'db:integration', integration('i1', s1))).toBe(true);
    expect(manage(t, 'db:space', s1)).toBe(false);
  });

  test('the token narrows by anchor: one space out of every space of o1', async () => {
    const t = await tokenOf(await orgUser('member', [spacesOfO1]), [manageS1]);
    expect(manage(t, 'db:space', s1)).toBe(true);
    expect(manage(t, 'db:space', s2)).toBe(false);
  });

  test('the token’s anchor is wider than the org-user’s: only where the org-user reaches', async () => {
    // The owner is checked on the record, so a too-wide anchor is cut to the owner's reach
    // rather than refused outright; the writer's grant-time check is what refuses it.
    const t = await tokenOf(await orgUser('member', [manageS1]), [spacesOfO1]);
    expect(manage(t, 'db:space', s2)).toBe(false);
    expect(manage(t, 'db:space', s1)).toBe(true);
  });

  test('the org-user’s role grounds the token where its entitlement cannot', async () => {
    const t = await tokenOf(await orgUser('admin'), [manageS1]);
    expect(manage(t, 'db:space', s1)).toBe(true);
    expect(manage(t, 'db:space', s1moved)).toBe(false);
  });

  test('the org’s right is what everything stands on: an empty owner at the bottom, nothing', async () => {
    const t = await tokenOf(await orgUser('member', [manageS1], createPermissions()), [manageS1]);
    expect(manage(t, 'db:space', s1)).toBe(false);
  });

  test('an integration in the middle: token ← integration ← org-user ← org, intact', async () => {
    const integrationOf = (orgUserRow: PermixLike) => tokenOf(orgUserRow, [manageS1]);
    const t = await tokenOf(await integrationOf(await orgUser('member', [manageS1])), [manageS1]);
    expect(manage(t, 'db:space', s1)).toBe(true);
    expect(manage(t, 'db:space', s1moved)).toBe(false);
    const grounded = await tokenOf(await integrationOf(await orgUser('admin')), [manageS1]);
    expect(manage(grounded, 'db:space', s1)).toBe(true);
  });

  test('both ends hold it, the integration in the middle does not: nothing', async () => {
    const member = await orgUser('member', [manageS1]);
    const readOnlyIntegration = await tokenOf(member, [readS1]);
    expect(manage(await tokenOf(readOnlyIntegration, [manageS1]), 'db:space', s1)).toBe(false);
    const emptyIntegration = createPermissions();
    await entitle(emptyIntegration, [], member);
    expect(manage(await tokenOf(emptyIntegration, [manageS1]), 'db:space', s1)).toBe(false);
  });

  test('a user-owned holder (a scoped JWT): the owner is the user’s memberships', async () => {
    const readO1: EntitlementEntry = {
      resource: 'db:organization',
      anchor: at('db:organization', 'o1'),
      actions: { read: true },
    };
    // the user's own table: a viewer of o1 (this toy schema has no operate → read chain)
    const userInO1 = await table({
      resource: 'db:organization',
      id: 'o1',
      actions: { read: true },
    });
    expect(read(await tokenOf(userInO1, [readO1]), 'db:organization', o1)).toBe(true);
    // the membership is gone: the user's table no longer reaches o1
    expect(read(await tokenOf(createPermissions(), [readO1]), 'db:organization', o1)).toBe(false);
    // the JWT asks for more than the user has
    const manageO1: EntitlementEntry = { ...readO1, actions: { manage: true } };
    expect(manage(await tokenOf(userInO1, [manageO1]), 'db:organization', o1)).toBe(false);
  });
});

test('`where: null` is refused at setup', async () => {
  const holder = createPermissions();
  await expect(
    entitle(
      holder,
      [
        {
          resource: 'db:space',
          anchor: AT_S1,
          actions: { manage: true },
          where: null as unknown as Condition,
        },
      ],
      await o1Table(),
    ),
  ).rejects.toThrow(/`where: null`/);
  expect(holder.entitlements('db:space', 'manage')).toEqual([]);
});
