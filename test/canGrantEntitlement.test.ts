import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  placeEntitlement,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

// A grant is an action: the writer could take every action the holder would hold, from where it
// would act. Grant time mirrors read time through the same check (Aron, 2026-10-22 and 2026-10-25).

const person = { rule: { field: '__actor.model', operator: Operator.equals, value: 'User' } };
const highRoles = ['owner', 'admin'];
const lowRoles = ['member', 'guest'];

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
const canGrantEntitlement = createCanGrantEntitlement(mapOf(relations));
const rebac = createRebacCheck(mapOf(relations));
const check = (permix: Permix, resource: string, record: Row, action: string) =>
  rebac(permix, schema, { resource, record }, action);

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
    expect(may(nobody, assign, { ...s1, role: 'member' })).toBe(true);
    expect(may(nobody, assign, s1)).toBe(false);
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
    expect(placeEntitlement(mapOf(relations), offTree, { id: 'u1' })).toBeNull();
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

  test('a held entitlement is passed on with its where: without it the grant is wider than what is held', async () => {
    const unnamed = entry('db:integration', at('db:space', 's1', 'space'), ['manage'], {
      field: 'name',
      operator: Operator.equals,
      value: null,
    });
    const holder = createPermissions();
    await holder.setup([unnamed], { owner: await holding('db:space', 's1', ['manage']) });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    const integrations = entry('db:integration', at('db:space', 's1', 'space'), ['manage']);
    const grants = (granted: EntitlementEntry) =>
      (placeEntitlement(mapOf(relations), granted, s1) ?? []).every((record) =>
        may(holder, granted, record),
      );
    expect(grants(integrations)).toBe(false);
    expect(grants(unnamed)).toBe(true);
  });

  test('a check at run time still reads a field the record does not carry as null', async () => {
    expect(check(await holding('db:space', 's1', ['read']), 'db:space', s1, 'rename')).toBe(true);
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
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    return holder;
  };
  const placed = (where: Row = {}) => ({ ...integrationUnder(s1), ...where });

  test('an exact copy, and a narrowing of it, pass', async () => {
    const holder = await holderOf(underS1(['manage', 'read'], slack));
    expect(may(holder, underS1(['manage', 'read'], slack), placed({ provider: 'slack' }))).toBe(
      true,
    );
    expect(
      may(holder, underS1(['read'], { all: [slack, named] }), placed({ provider: 'slack' })),
    ).toBe(true);
  });

  test('a grant wider than what is held is refused: a dropped condition or an extra action', async () => {
    const holder = await holderOf(underS1(['read'], slack));
    expect(may(holder, underS1(['read']), placed())).toBe(false);
    expect(may(holder, underS1(['read', 'manage'], slack), placed({ provider: 'slack' }))).toBe(
      false,
    );
  });

  test('a held entitlement passes on only what its granter still backs: copying never revives the rest (R111)', async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], { owner: await holding('db:space', 's1', ['read']) });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    expect(may(holder, underS1(['manage']), placed())).toBe(false);
    expect(may(holder, underS1(['read']), placed())).toBe(true);
  });

  test('two held entitlements never combine into one wider grant', async () => {
    const teams = { field: 'provider', operator: Operator.equals, value: 'teams' };
    const holder = await holderOf(underS1(['read'], slack), underS1(['read'], teams));
    const both = underS1(['read'], {
      field: 'provider',
      operator: Operator.in,
      value: ['slack', 'teams'],
    });
    expect(may(holder, both, placed())).toBe(false);
  });

  test('a held entitlement at a higher anchor passes on the part of it under a lower one, its where kept', async () => {
    const holder = await holderOf(
      entry('db:integration', at('db:organization', 'o1', 'space.organization'), ['read'], slack),
    );
    expect(may(holder, underS1(['read'], slack), placed({ provider: 'slack' }))).toBe(true);
    expect(may(holder, underS1(['read']), placed())).toBe(false);
  });
});

describe('a held entitlement passes on lower actions: each granted action reaches a held one through pure delegation (R99)', () => {
  const underS1 = (actions: string[]) =>
    entry('db:integration', at('db:space', 's1', 'space'), actions);
  const holderOf = async (held: EntitlementEntry) => {
    const holder = createPermissions();
    await holder.setup([held], { owner: await holding('db:space', 's1', ['own']) });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    return holder;
  };
  const placed = integrationUnder(s1);

  test('a lower action: holding manage grants read', async () => {
    expect(may(await holderOf(underS1(['manage'])), underS1(['read']), placed)).toBe(true);
  });

  test('through a chain: holding own grants read (read → manage → own)', async () => {
    expect(may(await holderOf(underS1(['own'])), underS1(['read']), placed)).toBe(true);
  });

  test('a subset, and a subset with a lowered action', async () => {
    const holder = await holderOf(underS1(['read', 'manage']));
    expect(may(holder, underS1(['read']), placed)).toBe(true);
    expect(may(await holderOf(underS1(['own'])), underS1(['read', 'manage']), placed)).toBe(true);
  });

  test('never a higher action: holding manage does not grant own', async () => {
    expect(may(await holderOf(underS1(['manage'])), underS1(['own']), placed)).toBe(false);
  });

  test('a delegation that needs more than the action is not pure: holding read on a space does not grant rename', async () => {
    const onSpace = (actions: string[]) => entry('db:space', at('db:space', 's1'), actions);
    expect(may(await holderOf(onSpace(['read'])), onSpace(['rename']), s1)).toBe(false);
  });
});

describe('passing on a lower action asks the grantor about that action, not the held one (R111)', () => {
  const underS1 = (actions: string[]) =>
    entry('db:integration', at('db:space', 's1', 'space'), actions);
  const placed = integrationUnder(s1);
  const heldWhileGrantorReads = async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], {
      owner: await holding('db:space', 's1', ['read']),
    });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    return holder;
  };

  test('the grantor lowered to read: the holder of manage still passes on read', async () => {
    expect(may(await heldWhileGrantorReads(), underS1(['read']), placed)).toBe(true);
  });

  test('and not manage, which the grantor no longer allows', async () => {
    expect(may(await heldWhileGrantorReads(), underS1(['manage']), placed)).toBe(false);
  });

  test("the same when the grantor's read reaches the space through its organization", async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], {
      owner: await holding('db:organization', 'o1', ['read']),
    });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    expect(may(holder, underS1(['read']), placed)).toBe(true);
    expect(may(holder, underS1(['manage']), placed)).toBe(false);
  });

  test('a grantor that lost even read passes on nothing', async () => {
    const holder = createPermissions();
    await holder.setup([underS1(['manage'])], { owner: await holding('db:space', 's9', ['own']) });
    holder.setActor({ model: 'User', record: { id: 'h1' } });
    expect(may(holder, underS1(['read']), placed)).toBe(false);
  });
});

test('an entitlement that grants no action is malformed: refused at setup and at placement', async () => {
  const nothing = entry('db:space', at('db:space', 's1'), []);
  const none = { ...nothing, actions: { own: false } };
  expect(placeEntitlement(mapOf(relations), nothing, s1)).toBeNull();
  expect(placeEntitlement(mapOf(relations), none, s1)).toBeNull();
  await expect(
    createPermissions().setup([none], { owner: await holding('db:space', 's1', ['own']) }),
  ).rejects.toThrow();
});

describe('a held entitlement is passed on as far as the schema reaches from it, like a table grant', () => {
  const manageS1 = entry('db:space', at('db:space', 's1'), ['manage']);
  const slackUnderS1 = entry('db:integration', at('db:space', 's1', 'space'), ['manage'], {
    field: 'provider',
    operator: Operator.equals,
    value: 'slack',
  });

  test('holding manage on s1 as an entitlement grants a copy of it, and manage on its integrations', async () => {
    const holder = createPermissions();
    await holder.setup([manageS1], { owner: await holding('db:space', 's1', ['own']) });
    expect(may(holder, manageS1, s1)).toBe(true);
    expect(may(holder, slackUnderS1, { ...integrationUnder(s1), provider: 'slack' })).toBe(true);
  });

  test('and not once its granter no longer backs manage on s1', async () => {
    const holder = createPermissions();
    await holder.setup([manageS1], { owner: await holding('db:space', 's1', ['read']) });
    expect(may(holder, slackUnderS1, { ...integrationUnder(s1), provider: 'slack' })).toBe(false);
  });

  test('the same manage on s1 in the table grants manage on its integrations', async () => {
    const writer = await holding('db:space', 's1', ['manage']);
    expect(may(writer, slackUnderS1, { ...integrationUnder(s1), provider: 'slack' })).toBe(true);
  });
});

describe('a delegated writer passes on what the schema says it can do: any subsection of what it holds', () => {
  const slackOnly = {
    rule: { field: 'integrationResource.provider', operator: Operator.equals, value: 'slack' },
  };
  const surfaces: RebacSchema = {
    permissions: {
      'db:integrationResource': { actions: { own: null, operate: 'own' } },
      'slack:channel': {
        actions: {
          '*': { all: [{ rel: 'integrationResource', action: 'operate' }, slackOnly] },
          'messages.*': '*',
          'messages.read': 'messages.*',
        },
      },
    },
  };
  const surfaceMap = mapOf({ 'slack:channel': { integrationResource: 'db:integrationResource' } });
  const canGrant = createCanGrantEntitlement(surfaceMap);
  const surfaceCheck = createRebacCheck(surfaceMap);
  const r1 = { id: 'r1', provider: 'slack' };
  const channel = { id: 'c1', integrationResourceId: 'r1', integrationResource: r1 };
  const operateOnR1 = entry('db:integrationResource', at('db:integrationResource', 'r1'), [
    'operate',
  ]);
  const onChannels = (actions: string[], where?: EntitlementEntry['where']) =>
    entry(
      'slack:channel',
      at('db:integrationResource', 'r1', 'integrationResource'),
      actions,
      where,
    );
  const holderOf = async (owner: Permix, ...held: EntitlementEntry[]) => {
    const holder = createPermissions();
    await holder.setup(held, { owner });
    holder.setActor({ model: 'Token', record: { id: 't1' } });
    return holder;
  };
  const operator = () => holding('db:integrationResource', 'r1', ['operate']);
  const grants = (writer: Permix, granted: EntitlementEntry) => {
    const placed = placeEntitlement(surfaceMap, granted, r1);
    return placed !== null && placed.every((record) => canGrant(writer, surfaces, granted, record));
  };
  const can = (permix: Permix, record: Row, action: string) =>
    surfaceCheck(permix, surfaces, { resource: 'slack:channel', record }, action);

  test('holding operate on the resource, a writer passes on the channel actions the schema implies from it', async () => {
    const writer = await holderOf(await operator(), operateOnR1);
    expect(can(writer, channel, 'messages.read')).toBe(true);
    expect(grants(writer, onChannels(['messages.read']))).toBe(true);
    expect(grants(writer, onChannels(['messages.*', '*']))).toBe(true);
  });

  test('holding only messages.read, it passes on messages.read and not messages.*', async () => {
    const writer = await holderOf(await operator(), onChannels(['messages.read']));
    expect(grants(writer, onChannels(['messages.read']))).toBe(true);
    expect(grants(writer, onChannels(['messages.*']))).toBe(false);
  });

  test('a held where bounds what is passed on: the implied action only with that where, or a narrower one', async () => {
    const general = { field: 'name', operator: Operator.equals, value: 'general' };
    const archived = { field: 'archived', operator: Operator.equals, value: false };
    const writer = await holderOf(await operator(), onChannels(['messages.*'], general));
    expect(can(writer, { ...channel, name: 'general' }, 'messages.read')).toBe(true);
    expect(grants(writer, onChannels(['messages.read']))).toBe(false);
    expect(grants(writer, onChannels(['messages.read'], general))).toBe(true);
    expect(grants(writer, onChannels(['messages.read'], { all: [general, archived] }))).toBe(true);
    expect(grants(writer, onChannels(['*'], general))).toBe(false);
  });

  test('a held where the placed record cannot decide is still passed on as a copy, lowered or not', async () => {
    const named = { field: 'name', operator: Operator.in, value: ['general', 'random'] };
    const writer = await holderOf(await operator(), onChannels(['messages.*'], named));
    expect(grants(writer, onChannels(['messages.read'], named))).toBe(true);
    expect(grants(writer, onChannels(['messages.*'], named))).toBe(true);
    expect(grants(writer, onChannels(['messages.read']))).toBe(false);
  });

  test('a writer whose owner lost operate can neither act nor pass on', async () => {
    const writer = await holderOf(
      await holding('db:integrationResource', 'r9', ['operate']),
      operateOnR1,
    );
    expect(can(writer, channel, 'messages.read')).toBe(false);
    expect(grants(writer, onChannels(['messages.read']))).toBe(false);
    expect(grants(writer, operateOnR1)).toBe(false);
  });

  test('a self-anchored entry is judged by its own where, not by the anchor row as it is today', async () => {
    const random = { field: 'name', operator: Operator.equals, value: 'random' };
    const general = { field: 'name', operator: Operator.equals, value: 'general' };
    const writer = await holderOf(await operator(), onChannels(['messages.*'], random));
    const c1 = { ...channel, name: 'random' };
    const onC1 = (where?: EntitlementEntry['where']) =>
      entry('slack:channel', at('slack:channel', 'c1'), ['messages.read'], where);
    const grantsOnC1 = (granted: EntitlementEntry) => {
      const placed = placeEntitlement(surfaceMap, granted, c1);
      return (
        placed !== null && placed.every((record) => canGrant(writer, surfaces, granted, record))
      );
    };
    expect(can(writer, { ...c1, name: 'general' }, 'messages.read')).toBe(false);
    expect(grantsOnC1(onC1(general))).toBe(false);
    expect(grantsOnC1(onC1({ field: 'name', operator: Operator.in, value: ['general'] }))).toBe(
      false,
    );
    expect(grantsOnC1(onC1({ field: 'name', operator: Operator.in, value: ['random'] }))).toBe(
      true,
    );
    expect(grantsOnC1(onC1(random))).toBe(true);
    expect(grantsOnC1(onC1())).toBe(true);
  });

  test('a self-anchored entry keeps its anchor id, pins its literal lists and leaves unknown the rest its where reads', () => {
    const c1 = { ...channel, name: 'random', topic: 'x' };
    const granted = entry('slack:channel', at('slack:channel', 'c1'), ['messages.read'], {
      all: [
        { field: 'name', operator: Operator.equals, value: 'general' },
        { field: 'topic', operator: Operator.in, value: ['y'] },
        { field: 'integrationResource.provider', operator: Operator.equals, value: 'slack' },
        { field: 'id', operator: Operator.equals, value: 'c9' },
      ],
    });
    expect(placeEntitlement(surfaceMap, granted, c1)).toEqual([
      {
        id: 'c1',
        name: 'general',
        topic: 'y',
        integrationResourceId: 'r1',
        integrationResource: { id: 'r1' },
      },
    ]);
    expect(c1.integrationResource).toEqual(r1);
  });

  test('a negated schema rule cannot be judged on a placed record: the grant walk refuses the schema', async () => {
    const unlocked = { field: 'locked', operator: Operator.notEquals, value: true };
    const negated: RebacSchema = {
      permissions: {
        ...surfaces.permissions,
        'slack:channel': {
          actions: {
            ...surfaces.permissions['slack:channel']?.actions,
            'messages.post': { all: ['messages.*', { rule: unlocked }] },
          },
        },
      },
    };
    const writer = await holderOf(await operator(), operateOnR1);
    const post = onChannels(['messages.post']);
    const [placed] = placeEntitlement(surfaceMap, post, r1) ?? [];
    expect(() => canGrant(writer, negated, post, placed as Row)).toThrow(
      /slack:channel.*messages\.post.*positive/,
    );
    expect(can(writer, { ...channel, locked: true }, 'messages.post')).toBe(false);
  });

  test('a list pin passes on at any depth: each hop names a subset of the list above it', async () => {
    const named = (...names: string[]) => ({ field: 'name', operator: Operator.in, value: names });
    const first = await holderOf(
      await operator(),
      onChannels(['messages.*'], named('general', 'random', 'ops')),
    );
    const second = await holderOf(first, onChannels(['messages.read'], named('general', 'random')));
    const third = await holderOf(second, onChannels(['messages.read'], named('general')));
    expect(grants(second, onChannels(['messages.read'], named('general', 'random')))).toBe(true);
    expect(grants(second, onChannels(['messages.read'], named('general')))).toBe(true);
    expect(
      grants(
        second,
        onChannels(['messages.read'], { field: 'name', operator: 'equals', value: 'random' }),
      ),
    ).toBe(true);
    expect(grants(second, onChannels(['messages.read'], named('general', 'ops')))).toBe(false);
    expect(grants(second, onChannels(['messages.read'], named('secret')))).toBe(false);
    expect(grants(second, onChannels(['messages.read']))).toBe(false);
    expect(grants(third, onChannels(['messages.read'], named('general')))).toBe(true);
    expect(grants(third, onChannels(['messages.read'], named('random')))).toBe(false);
    expect(grants(third, onChannels(['messages.*'], named('general')))).toBe(false);
  });

  test('a list narrowed to a subset is a narrowing even beside a condition the placed record cannot decide', async () => {
    const large = { field: 'members', operator: Operator.greaterThan, value: 5 };
    const named = (...names: string[]) => ({
      all: [large, { field: 'name', operator: Operator.in, value: names }],
    });
    const writer = await holderOf(
      await operator(),
      onChannels(['messages.read'], named('general', 'random')),
    );
    expect(grants(writer, onChannels(['messages.read'], named('general')))).toBe(true);
    expect(grants(writer, onChannels(['messages.read'], named('general', 'random')))).toBe(true);
    expect(grants(writer, onChannels(['messages.read'], named('general', 'secret')))).toBe(false);
    expect(
      grants(
        writer,
        onChannels(['messages.read'], { field: 'name', operator: Operator.in, value: ['general'] }),
      ),
    ).toBe(false);
  });

  test('a writer holding operate on another resource passes on nothing under r1', async () => {
    const writer = await holderOf(
      await holding('db:integrationResource', 'r9', ['operate']),
      entry('db:integrationResource', at('db:integrationResource', 'r9'), ['operate']),
    );
    expect(grants(writer, onChannels(['messages.read']))).toBe(false);
  });
});
