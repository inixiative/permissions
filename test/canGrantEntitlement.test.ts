import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type RebacSchema,
  type Row,
} from '../index';

// A grant is an action: the writer could take every action the holder would hold, from where it
// would act. Grant time mirrors read time through the same check (Aron, 2026-10-22 and 2026-10-25).

const person = { rule: { field: '__actor.model', operator: Operator.equals, value: 'User' } };
const highRoles = ['owner', 'admin'];

const schema: RebacSchema = {
  permissions: {
    'db:organization': {
      actions: {
        own: null,
        manage: 'own',
        read: 'manage',
        assign: {
          any: [
            { all: [{ rule: { field: 'role', operator: Operator.in, value: highRoles } }, 'own'] },
            {
              all: [
                { rule: { field: 'role', operator: Operator.notIn, value: highRoles } },
                'manage',
              ],
            },
          ],
        },
        'token.create': { all: [person, 'manage'] },
      },
    },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
        assign: { rule: { field: 'role', operator: Operator.notIn, value: highRoles } },
        rename: {
          all: [{ rule: { field: 'label', operator: Operator.equals, value: null } }, 'read'],
        },
      },
    },
    'db:integration': {
      actions: {
        own: { rel: 'space', action: 'own' },
        manage: { any: ['own', { rel: 'space', action: 'manage' }] },
        read: { any: ['manage', { rel: 'space', action: 'read' }] },
      },
    },
    'db:user': { actions: { own: null } },
  },
};

const relations: Record<string, Record<string, string>> = {
  'db:space': { organization: 'db:organization' },
  'db:integration': { space: 'db:space' },
};
const resolveRelation = (resource: string, segment: string) =>
  relations[resource]?.[segment] ?? null;
const owners: Record<string, string> = {
  'db:space': 'organization',
  'db:integration': 'space',
};
const directOwner = (resource: string, record: Row) => {
  const field = owners[resource];
  const owner = field ? (record[field] as Row | undefined) : undefined;
  return field && owner && typeof owner === 'object'
    ? { resource: relations[resource]?.[field] ?? '', id: String(owner.id) }
    : null;
};
const canGrantEntitlement = createCanGrantEntitlement(resolveRelation, { directOwner });
const rebac = createRebacCheck(resolveRelation, { directOwner });
const check = (permix: Permix, resource: string, record: Row, action: string) =>
  rebac(permix, schema, { resource, record }, action);

const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const at = (resource: string, id: string) => ({ resource, id });
const integrationUnder = (space: Row) => ({ id: '', spaceId: space.id, space });

const entry = (
  resource: string,
  anchor: { resource: string; id: string },
  actions: string[],
  where?: EntitlementEntry['where'],
): EntitlementEntry => ({
  resource,
  anchor,
  actions: Object.fromEntries(actions.map((a) => [a, true])),
  ...(where === undefined ? {} : { where }),
});

const writer = async (entries: PermissionEntry[], model = 'User') => {
  const permix = createPermissions();
  await permix.setup(entries);
  permix.setActor({ model, record: { id: 'w1' } });
  return permix;
};
const holding = (resource: string, id: string, actions: string[]) =>
  writer([{ resource, id, actions: Object.fromEntries(actions.map((a) => [a, true])) }]);

const may = (permix: Permix, granted: EntitlementEntry, anchor: Row) =>
  canGrantEntitlement(permix, schema, granted, anchor);

describe('canGrantEntitlement: never more than the writer could do from that anchor', () => {
  test('a manager grants manage on the organization, not own', async () => {
    const manager = await holding('db:organization', 'o1', ['manage']);
    expect(
      may(manager, entry('db:organization', at('db:organization', 'o1'), ['manage', 'read']), o1),
    ).toBe(true);
    expect(may(manager, entry('db:organization', at('db:organization', 'o1'), ['own']), o1)).toBe(
      false,
    );
  });

  test('an action the writer holds only by name is granted only by a writer who holds it', async () => {
    const custom = entry('db:organization', at('db:organization', 'o1'), ['report.export']);
    expect(may(await holding('db:organization', 'o1', ['own']), custom, o1)).toBe(false);
    expect(may(await holding('db:organization', 'o1', ['own', 'report.export']), custom, o1)).toBe(
      true,
    );
  });

  test('a rule-gated action is granted by whoever could take it at the anchor', async () => {
    const assign = entry('db:organization', at('db:organization', 'o1'), ['assign']);
    expect(may(await holding('db:organization', 'o1', ['read']), assign, o1)).toBe(false);
    expect(may(await holding('db:organization', 'o1', ['manage']), assign, o1)).toBe(true);
    expect(may(await holding('db:organization', 'o1', ['own']), assign, o1)).toBe(true);
  });

  test('a granted rule-gated action reaches exactly as far as its writer: the owner walk runs the rule', async () => {
    const assign = entry('db:organization', at('db:organization', 'o1'), ['assign']);
    const assignFrom = async (owner: Permix) => {
      const holder = createPermissions();
      await holder.setup([assign], { owner });
      holder.setActor({ model: 'User', record: { id: 'h1' } });
      return holder;
    };
    const fromManager = await assignFrom(await holding('db:organization', 'o1', ['manage']));
    expect(check(fromManager, 'db:organization', { ...o1, role: 'member' }, 'assign')).toBe(true);
    expect(check(fromManager, 'db:organization', { ...o1, role: 'owner' }, 'assign')).toBe(false);
    const fromOwner = await assignFrom(await holding('db:organization', 'o1', ['own']));
    expect(check(fromOwner, 'db:organization', { ...o1, role: 'owner' }, 'assign')).toBe(true);
  });

  test('a rule-only action is granted by anyone who could take it, and its holder still meets the rule', async () => {
    const assign = entry('db:space', at('db:space', 's1'), ['assign']);
    const nobody = await writer([]);
    expect(may(nobody, assign, s1)).toBe(true);
    const holder = createPermissions();
    await holder.setup([assign], { owner: nobody });
    expect(check(holder, 'db:space', { ...s1, role: 'member' }, 'assign')).toBe(true);
    expect(check(holder, 'db:space', { ...s1, role: 'admin' }, 'assign')).toBe(false);
  });

  test('a granted actor-gated action still meets the actor: a token holding token.create mints nothing', async () => {
    const mint = entry('db:organization', at('db:organization', 'o1'), ['token.create']);
    const holderAs = async (model: string) => {
      const holder = createPermissions();
      await holder.setup([mint], { owner: await holding('db:organization', 'o1', ['manage']) });
      holder.setActor({ model, record: { id: 'h1' } });
      return holder;
    };
    expect(check(await holderAs('User'), 'db:organization', o1, 'token.create')).toBe(true);
    expect(check(await holderAs('Token'), 'db:organization', o1, 'token.create')).toBe(false);
  });

  test('a child resource from its direct owner: the integrations of s1, judged on the record the app placed under s1', async () => {
    const integrations = entry('db:integration', at('db:space', 's1'), ['manage']);
    expect(
      may(await holding('db:space', 's1', ['manage']), integrations, integrationUnder(s1)),
    ).toBe(true);
    expect(may(await holding('db:space', 's1', ['read']), integrations, integrationUnder(s1))).toBe(
      false,
    );
  });

  test('an anchor acts at its direct owner: integrations from o1, two hops up, are refused even to its owner', async () => {
    const integrations = entry('db:integration', at('db:organization', 'o1'), ['manage']);
    expect(
      may(await holding('db:organization', 'o1', ['own']), integrations, integrationUnder(s1)),
    ).toBe(false);
  });

  test('a placed record must sit at the anchor: not under another record', async () => {
    const integrations = entry('db:integration', at('db:space', 's1'), ['manage']);
    const s2 = { id: 's2', organizationId: 'o1', organization: o1 };
    expect(
      may(await holding('db:organization', 'o1', ['own']), integrations, integrationUnder(s2)),
    ).toBe(false);
  });

  test('an anchor off the resource tree grants nothing', async () => {
    const offTree = entry('db:integration', at('db:user', 'u1'), ['read']);
    expect(may(await holding('db:user', 'u1', ['own']), offTree, { id: 'u1' })).toBe(false);
  });

  test('the anchor must be the record the entitlement names', async () => {
    const owner = await holding('db:organization', 'o1', ['own']);
    expect(may(owner, entry('db:organization', at('db:organization', 'o9'), ['read']), o1)).toBe(
      false,
    );
  });

  test('a where only narrows: the writer must cover the whole collection at that anchor', async () => {
    const slack = { field: 'provider', operator: Operator.equals, value: 'slack' };
    const granted = entry('db:integration', at('db:space', 's1'), ['manage'], slack);
    expect(may(await holding('db:space', 's1', ['manage']), granted, integrationUnder(s1))).toBe(
      true,
    );
    expect(may(await holding('db:space', 's1', ['read']), granted, integrationUnder(s1))).toBe(
      false,
    );
  });

  test('false actions grant nothing and need nothing', async () => {
    const granted: EntitlementEntry = {
      resource: 'db:organization',
      anchor: at('db:organization', 'o1'),
      actions: { own: false },
    };
    expect(may(await holding('db:organization', 'o1', ['read']), granted, o1)).toBe(true);
  });

  test('the actor is the request actor: a token never grants a person-only action', async () => {
    const mint = entry('db:organization', at('db:organization', 'o1'), ['token.create']);
    const asPerson = await holding('db:organization', 'o1', ['own']);
    expect(may(asPerson, mint, o1)).toBe(true);
    const asToken = await writer(
      [{ resource: 'db:organization', id: 'o1', actions: { own: true } }],
      'Token',
    );
    expect(may(asToken, mint, o1)).toBe(false);
  });

  test('a writer holding through its own owner grants no more than that owner reaches', async () => {
    const readOnlyOwner = await holding('db:organization', 'o1', ['read']);
    const token = createPermissions();
    await token.setup([entry('db:organization', at('db:organization', 'o1'), ['manage', 'read'])], {
      owner: readOnlyOwner,
    });
    token.setActor({ model: 'Token', record: { id: 't1' } });
    const manage = entry('db:organization', at('db:organization', 'o1'), ['manage']);
    expect(may(token, manage, o1)).toBe(false);
    expect(may(token, entry('db:organization', at('db:organization', 'o1'), ['read']), o1)).toBe(
      true,
    );
  });

  test('a superadmin grants anything', async () => {
    const superadmin = await writer([]);
    superadmin.setSuperadmin(true);
    expect(may(superadmin, entry('db:space', at('db:space', 's1'), ['assign']), s1)).toBe(true);
  });
});

describe('canGrantEntitlement on a placed record: a field it does not carry is unknown, not null', () => {
  const rename = entry('db:space', at('db:space', 's1'), ['rename']);

  test('a rule for records with no label does not grant records the placed one leaves open', async () => {
    expect(may(await holding('db:space', 's1', ['read']), rename, s1)).toBe(false);
  });

  test('a placed record that pins label null is granted: null === null', async () => {
    expect(may(await holding('db:space', 's1', ['read']), rename, { ...s1, label: null })).toBe(
      true,
    );
  });

  test("the writer's own entitlement where reads the placed record the same way", async () => {
    const unnamed = entry('db:integration', at('db:space', 's1'), ['manage'], {
      field: 'name',
      operator: Operator.equals,
      value: null,
    });
    const holder = createPermissions();
    await holder.setup([unnamed], { owner: await holding('db:space', 's1', ['manage']) });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    const integrations = entry('db:integration', at('db:space', 's1'), ['manage']);
    expect(may(holder, integrations, integrationUnder(s1))).toBe(false);
    expect(may(holder, integrations, { ...integrationUnder(s1), name: null })).toBe(true);
  });

  test('a check at run time still reads a field the record does not carry as null', async () => {
    expect(check(await holding('db:space', 's1', ['read']), 'db:space', s1, 'rename')).toBe(true);
  });
});
