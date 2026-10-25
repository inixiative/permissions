import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type RebacSchema,
  type Row,
} from '../index';

// A grant is an action: the writer could take every action the holder would hold, from where it
// would act. Grant time mirrors read time through the same check (Aron, 2026-10-22 and 2026-10-25).

const person = { actor: { field: 'model', operator: Operator.equals, value: 'User' } };
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
const canGrantEntitlement = createCanGrantEntitlement(
  (resource, segment) => relations[resource]?.[segment] ?? null,
);

const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const at = (resource: string, id: string) => ({ resource, id });

const entry = (
  resource: string,
  from: { resource: string; id: string },
  actions: string[],
  where?: EntitlementEntry['where'],
): EntitlementEntry => ({
  resource,
  from,
  actions: Object.fromEntries(actions.map((a) => [a, true])),
  ...(where === undefined ? {} : { where }),
});

const writer = async (entries: PermissionEntry[], model = 'User') => {
  const permix = createPermissions();
  await permix.setup(entries);
  permix.setActor({ id: 'w1', model });
  return permix;
};
const holding = (resource: string, id: string, actions: string[]) =>
  writer([{ resource, id, actions: Object.fromEntries(actions.map((a) => [a, true])) }]);

const may = (permix: Permix, granted: EntitlementEntry, position: Row) =>
  canGrantEntitlement(permix, schema, granted, position);

describe('canGrantEntitlement: never more than the writer could do from that position', () => {
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

  test('a rule-gated action is granted at its strongest: a granted assign skips its rule', async () => {
    const assign = entry('db:organization', at('db:organization', 'o1'), ['assign']);
    expect(may(await holding('db:organization', 'o1', ['manage']), assign, o1)).toBe(false);
    expect(may(await holding('db:organization', 'o1', ['own']), assign, o1)).toBe(true);
  });

  test('a rule-gated action on a resource with no terminal action is granted by nobody', async () => {
    const assign = entry('db:space', at('db:space', 's1'), ['assign']);
    expect(may(await holding('db:organization', 'o1', ['own']), assign, s1)).toBe(false);
  });

  test('a child resource from a position: the integrations of s1, judged on a stand-in under s1', async () => {
    const integrations = entry('db:integration', at('db:space', 's1'), ['manage']);
    expect(may(await holding('db:space', 's1', ['manage']), integrations, s1)).toBe(true);
    expect(may(await holding('db:space', 's1', ['read']), integrations, s1)).toBe(false);
  });

  test('two hops up: the integrations of every space of o1', async () => {
    const integrations = entry('db:integration', at('db:organization', 'o1'), ['manage']);
    expect(may(await holding('db:organization', 'o1', ['manage']), integrations, o1)).toBe(true);
    expect(may(await holding('db:space', 's1', ['manage']), integrations, o1)).toBe(false);
  });

  test('a position off the resource tree grants nothing', async () => {
    const offTree = entry('db:integration', at('db:user', 'u1'), ['read']);
    expect(may(await holding('db:user', 'u1', ['own']), offTree, { id: 'u1' })).toBe(false);
  });

  test('the position must be the record the entitlement names', async () => {
    const owner = await holding('db:organization', 'o1', ['own']);
    expect(may(owner, entry('db:organization', at('db:organization', 'o9'), ['read']), o1)).toBe(
      false,
    );
  });

  test('a where only narrows: the writer must cover the whole collection at that position', async () => {
    const slack = { field: 'provider', operator: Operator.equals, value: 'slack' };
    const granted = entry('db:integration', at('db:space', 's1'), ['manage'], slack);
    expect(may(await holding('db:space', 's1', ['manage']), granted, s1)).toBe(true);
    expect(may(await holding('db:space', 's1', ['read']), granted, s1)).toBe(false);
  });

  test('false actions grant nothing and need nothing', async () => {
    const granted: EntitlementEntry = {
      resource: 'db:organization',
      from: at('db:organization', 'o1'),
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
    token.setActor({ id: 't1', model: 'Token' });
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
