import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  pseudoRecordsOfEntitlement,
  type Row,
} from '../index';
import { actorData, canGrantWithRules, checkWithRules, mapOf, type Rules } from './schemaMaps';

// A grant is an action: the writer could take every action the holder would hold, from where it
// would act. Grant time mirrors read time through the same check (Aron, 2026-10-22 and 2026-10-25).

const person = { rule: { field: 'actor:User.id', operator: Operator.exists } };
const highRoles = ['owner', 'admin'];
const lowRoles = ['member', 'guest'];

const schema: Rules = {
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
              all: [{ rule: { field: 'role', operator: Operator.in, value: lowRoles } }, 'manage'],
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
        assign: { rule: { field: 'role', operator: Operator.in, value: lowRoles } },
        rename: {
          all: [{ rule: { field: 'label', operator: Operator.equals, value: 'draft' } }, 'read'],
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
const columns = {
  'db:user': [],
  'db:organization': ['role'],
  'db:space': ['label', 'name', 'role'],
  'db:integration': ['provider', 'name'],
};
const canGrantEntitlement = canGrantWithRules(mapOf(relations, columns));
const rebac = checkWithRules(mapOf(relations, columns));
const check = (
  permix: Permix,
  resource: string,
  record: Row,
  action: string,
  data: Record<string, Row[]> = actorData('User', { id: 'h1' }),
) => rebac(permix, schema, { resource, record, data }, action);

const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const at = (resource: string, id: string, path?: string) =>
  path === undefined ? { resource, id } : { resource, id, path };
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

const writer = async (entries: PermissionEntry[]) => {
  const permix = createPermissions();
  await permix.setup(entries);
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
    const member = { ...o1, role: 'member' };
    const owner = { ...o1, role: 'owner' };
    expect(may(await holding('db:organization', 'o1', ['read']), assign, member)).toBe(false);
    expect(may(await holding('db:organization', 'o1', ['manage']), assign, member)).toBe(true);
    expect(may(await holding('db:organization', 'o1', ['manage']), assign, owner)).toBe(false);
    expect(may(await holding('db:organization', 'o1', ['manage']), assign, o1)).toBe(false);
    expect(may(await holding('db:organization', 'o1', ['own']), assign, member)).toBe(true);
    expect(may(await holding('db:organization', 'o1', ['own']), assign, owner)).toBe(true);
  });

  test('a granted rule-gated action reaches exactly as far as its writer: the owner walk runs the rule', async () => {
    const assign = entry('db:organization', at('db:organization', 'o1'), ['assign']);
    const assignFrom = async (owner: Permix) => {
      const holder = createPermissions();
      await holder.setup([assign], { owner });
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
    expect(may(nobody, assign, { ...s1, role: 'member' })).toBe(true);
    expect(may(nobody, assign, s1)).toBe(false);
    const holder = createPermissions();
    await holder.setup([assign], { owner: nobody });
    expect(check(holder, 'db:space', { ...s1, role: 'member' }, 'assign')).toBe(true);
    expect(check(holder, 'db:space', { ...s1, role: 'admin' }, 'assign')).toBe(false);
  });

  test('a granted actor-gated action still meets the actor: a token holding token.create mints nothing', async () => {
    const mint = entry('db:organization', at('db:organization', 'o1'), ['token.create']);
    const holder = createPermissions();
    await holder.setup([mint], { owner: await holding('db:organization', 'o1', ['manage']) });
    const as = (model: string) =>
      check(holder, 'db:organization', o1, 'token.create', actorData(model, { id: 'h1' }));
    expect(as('User')).toBe(true);
    expect(as('Token')).toBe(false);
  });

  test('a child resource from its direct owner: the integrations of s1, judged on the record the app pseudoRecord under s1', async () => {
    const integrations = entry('db:integration', at('db:space', 's1', 'space'), ['manage']);
    expect(
      may(await holding('db:space', 's1', ['manage']), integrations, integrationUnder(s1)),
    ).toBe(true);
    expect(may(await holding('db:space', 's1', ['read']), integrations, integrationUnder(s1))).toBe(
      false,
    );
  });

  test('an anchor off the resource tree grants nothing', async () => {
    const offTree = entry('db:integration', at('db:user', 'u1', 'user'), ['read']);
    expect(pseudoRecordsOfEntitlement(mapOf(relations, columns), offTree, { id: 'u1' })).toBeNull();
  });

  test('a where only narrows: the writer must cover the whole collection at that anchor', async () => {
    const slack = { field: 'provider', operator: Operator.equals, value: 'slack' };
    const granted = entry('db:integration', at('db:space', 's1', 'space'), ['manage'], slack);
    expect(may(await holding('db:space', 's1', ['manage']), granted, integrationUnder(s1))).toBe(
      true,
    );
    expect(may(await holding('db:space', 's1', ['read']), granted, integrationUnder(s1))).toBe(
      false,
    );
  });

  test('an entry that grants no action is malformed, so it is never granted (R104)', async () => {
    const granted: EntitlementEntry = {
      resource: 'db:organization',
      anchor: at('db:organization', 'o1'),
      actions: { own: false },
    };
    expect(may(await holding('db:organization', 'o1', ['own']), granted, o1)).toBe(false);
  });

  test('the grant check has no actor: a person-only action is never granted, by a person or a token', async () => {
    const mint = entry('db:organization', at('db:organization', 'o1'), ['token.create']);
    const asPerson = await holding('db:organization', 'o1', ['own']);
    expect(may(asPerson, mint, o1)).toBe(false);
    const asToken = await writer([
      { resource: 'db:organization', id: 'o1', actions: { own: true } },
    ]);
    expect(may(asToken, mint, o1)).toBe(false);
  });

  test('a writer holding through its own owner grants no more than that owner reaches', async () => {
    const readOnlyOwner = await holding('db:organization', 'o1', ['read']);
    const token = createPermissions();
    await token.setup([entry('db:organization', at('db:organization', 'o1'), ['manage', 'read'])], {
      owner: readOnlyOwner,
    });
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

describe('canGrantEntitlement on a pseudoRecord record: a field it does not carry is unknown, not null', () => {
  const rename = entry('db:space', at('db:space', 's1'), ['rename']);

  test('a rule for draft-labelled records does not grant records the pseudoRecord one leaves open', async () => {
    expect(may(await holding('db:space', 's1', ['read']), rename, s1)).toBe(false);
  });

  test('a pseudoRecord record that pins the label is granted', async () => {
    expect(may(await holding('db:space', 's1', ['read']), rename, { ...s1, label: 'draft' })).toBe(
      true,
    );
  });

  test('a held entitlement is passed on with its where: without it the grant is wider than what is held', async () => {
    const unnamed = entry('db:integration', at('db:space', 's1', 'space'), ['manage'], {
      field: 'name',
      operator: Operator.equals,
      value: 'ops',
    });
    const holder = createPermissions();
    await holder.setup([unnamed], { owner: await holding('db:space', 's1', ['manage']) });
    const integrations = entry('db:integration', at('db:space', 's1', 'space'), ['manage']);
    const grants = (granted: EntitlementEntry) =>
      (pseudoRecordsOfEntitlement(mapOf(relations, columns), granted, s1) ?? []).every((record) =>
        may(holder, granted, record),
      );
    expect(grants(integrations)).toBe(false);
    expect(grants(unnamed)).toBe(true);
  });

  test('a check at run time reads a field the record does not carry as unknown, never null', async () => {
    expect(check(await holding('db:space', 's1', ['read']), 'db:space', s1, 'rename')).toBe(false);
    expect(
      check(
        await holding('db:space', 's1', ['read']),
        'db:space',
        { ...s1, label: 'draft' },
        'rename',
      ),
    ).toBe(true);
  });
});

describe('a held entitlement is passed on only as a copy or a narrowing of itself (R95)', () => {
  const slack = { field: 'provider', operator: Operator.equals, value: 'slack' };
  const named = { field: 'name', operator: Operator.equals, value: 'ops' };
  const underS1 = (actions: string[], where?: EntitlementEntry['where']) =>
    entry('db:integration', at('db:space', 's1', 'space'), actions, where);
  const holderOf = async (...held: EntitlementEntry[]) => {
    const holder = createPermissions();
    await holder.setup(held, { owner: await holding('db:space', 's1', ['manage']) });
    return holder;
  };
  const pseudoRecord = (where: Row = {}) => ({ ...integrationUnder(s1), ...where });

  test('an exact copy, and a narrowing of it, pass', async () => {
    const holder = await holderOf(underS1(['manage', 'read'], slack));
    expect(
      may(holder, underS1(['manage', 'read'], slack), pseudoRecord({ provider: 'slack' })),
    ).toBe(true);
    expect(
      may(holder, underS1(['read'], { all: [slack, named] }), pseudoRecord({ provider: 'slack' })),
    ).toBe(true);
  });

  test('a grant wider than what is held is refused: a dropped condition or an extra action', async () => {
    const holder = await holderOf(underS1(['read'], slack));
    expect(may(holder, underS1(['read']), pseudoRecord())).toBe(false);
    expect(
      may(holder, underS1(['read', 'manage'], slack), pseudoRecord({ provider: 'slack' })),
    ).toBe(false);
  });

  test('a held entitlement passes on only what its granter still backs: copying never revives the rest (R111)', async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], { owner: await holding('db:space', 's1', ['read']) });
    expect(may(holder, underS1(['manage']), pseudoRecord())).toBe(false);
    expect(may(holder, underS1(['read']), pseudoRecord())).toBe(true);
  });

  test('two held entitlements never combine into one wider grant', async () => {
    const teams = { field: 'provider', operator: Operator.equals, value: 'teams' };
    const holder = await holderOf(underS1(['read'], slack), underS1(['read'], teams));
    const both = underS1(['read'], {
      field: 'provider',
      operator: Operator.in,
      value: ['slack', 'teams'],
    });
    expect(may(holder, both, pseudoRecord())).toBe(false);
  });

  test('another anchor is not a copy of what is held: narrow with the where instead', async () => {
    const holder = await holderOf(
      entry('db:integration', at('db:organization', 'o1', 'space.organization'), ['read'], slack),
    );
    expect(may(holder, underS1(['read'], slack), pseudoRecord({ provider: 'slack' }))).toBe(false);
  });
});

describe('a held entitlement passes on lower actions: each granted action reaches a held one through pure delegation (R99)', () => {
  const underS1 = (actions: string[]) =>
    entry('db:integration', at('db:space', 's1', 'space'), actions);
  const holderOf = async (held: EntitlementEntry) => {
    const holder = createPermissions();
    await holder.setup([held], { owner: await holding('db:space', 's1', ['own']) });
    return holder;
  };
  const pseudoRecord = integrationUnder(s1);

  test('a lower action: holding manage grants read', async () => {
    expect(may(await holderOf(underS1(['manage'])), underS1(['read']), pseudoRecord)).toBe(true);
  });

  test('through a chain: holding own grants read (read → manage → own)', async () => {
    expect(may(await holderOf(underS1(['own'])), underS1(['read']), pseudoRecord)).toBe(true);
  });

  test('a subset, and a subset with a lowered action', async () => {
    const holder = await holderOf(underS1(['read', 'manage']));
    expect(may(holder, underS1(['read']), pseudoRecord)).toBe(true);
    expect(may(await holderOf(underS1(['own'])), underS1(['read', 'manage']), pseudoRecord)).toBe(
      true,
    );
  });

  test('never a higher action: holding manage does not grant own', async () => {
    expect(may(await holderOf(underS1(['manage'])), underS1(['own']), pseudoRecord)).toBe(false);
  });

  test('a delegation that needs more than the action is not pure: holding read on a space does not grant rename', async () => {
    const onSpace = (actions: string[]) => entry('db:space', at('db:space', 's1'), actions);
    expect(may(await holderOf(onSpace(['read'])), onSpace(['rename']), s1)).toBe(false);
  });
});

describe('passing on a lower action asks the grantor about that action, not the held one (R111)', () => {
  const underS1 = (actions: string[]) =>
    entry('db:integration', at('db:space', 's1', 'space'), actions);
  const pseudoRecord = integrationUnder(s1);
  const heldWhileGrantorReads = async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], {
      owner: await holding('db:space', 's1', ['read']),
    });
    return holder;
  };

  test('the grantor lowered to read: the holder of manage still passes on read', async () => {
    expect(may(await heldWhileGrantorReads(), underS1(['read']), pseudoRecord)).toBe(true);
  });

  test('and not manage, which the grantor no longer allows', async () => {
    expect(may(await heldWhileGrantorReads(), underS1(['manage']), pseudoRecord)).toBe(false);
  });

  test("the same when the grantor's read reaches the space through its organization", async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], {
      owner: await holding('db:organization', 'o1', ['read']),
    });
    expect(may(holder, underS1(['read']), pseudoRecord)).toBe(true);
    expect(may(holder, underS1(['manage']), pseudoRecord)).toBe(false);
  });

  test('a grantor that lost even read passes on nothing', async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], { owner: await holding('db:space', 's9', ['own']) });
    expect(may(holder, underS1(['read']), pseudoRecord)).toBe(false);
  });
});

test('an entitlement that grants no action is malformed: refused at setup and when its pseudo records are built', async () => {
  const nothing = entry('db:space', at('db:space', 's1'), []);
  const none = { ...nothing, actions: { own: false } };
  expect(pseudoRecordsOfEntitlement(mapOf(relations, columns), nothing, s1)).toBeNull();
  expect(pseudoRecordsOfEntitlement(mapOf(relations, columns), none, s1)).toBeNull();
  await expect(
    createPermissions().setup([none], { owner: await holding('db:space', 's1', ['own']) }),
  ).rejects.toThrow();
});

// Reversed 2026-11-14 for a row marked `grantsBelow` (test/grantBelow.test.ts); withoutPseudoFields, it stands.
describe('step one is the table: a stored entitlement is passed on only as itself, unless it is marked grantsBelow (R103)', () => {
  const manageS1 = entry('db:space', at('db:space', 's1'), ['manage']);
  const slackUnderS1 = entry('db:integration', at('db:space', 's1', 'space'), ['manage'], {
    field: 'provider',
    operator: Operator.equals,
    value: 'slack',
  });

  test('holding manage on s1 as an entitlement grants a copy of it, not manage on its integrations', async () => {
    const holder = createPermissions();
    await holder.setup([manageS1], { owner: await holding('db:space', 's1', ['own']) });
    expect(may(holder, manageS1, s1)).toBe(true);
    expect(may(holder, slackUnderS1, { ...integrationUnder(s1), provider: 'slack' })).toBe(false);
  });

  test('holding the same manage on s1 marked grantsBelow grants manage on its integrations', async () => {
    const holder = createPermissions();
    await holder.setup([{ ...manageS1, grantsBelow: true }], {
      owner: await holding('db:space', 's1', ['own']),
    });
    expect(may(holder, manageS1, s1)).toBe(true);
    expect(may(holder, slackUnderS1, { ...integrationUnder(s1), provider: 'slack' })).toBe(true);
  });

  test('the same manage on s1 in the table grants manage on its integrations', async () => {
    const writer = await holding('db:space', 's1', ['manage']);
    expect(may(writer, slackUnderS1, { ...integrationUnder(s1), provider: 'slack' })).toBe(true);
  });
});
