import { describe, expect, test } from 'bun:test';
import {
  createRebacCheck,
  type Delegation,
  delegate,
  type EntitlementEntry,
  type Permissions,
  permixOf,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

// own ⊇ manage ⊇ operate ⊇ read on each tenant; a user has no operate.
const schema: RebacSchema = {
  permissions: {
    'db:organization': {
      actions: { own: null, manage: 'own', operate: 'manage', read: 'operate' },
    },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        operate: { any: ['manage', { rel: 'organization', action: 'operate' }] },
        read: { any: ['operate', { rel: 'organization', action: 'read' }] },
      },
    },
    'db:user': { actions: { own: null, read: 'own' } },
  },
};
const check = createRebacCheck(mapOf({ 'db:space': { organization: 'db:organization' } }));

const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const s2 = { id: 's2', organizationId: 'o1', organization: o1 };

const can = async (table: Permissions, resource: string, record: Row, action: string) =>
  check(await permixOf(table), schema, { resource, record }, action);

const grants = (...entries: Permissions[number]['entries']): Permissions[number] => ({ entries });
const onOrg = (actions: Record<string, boolean>) => ({
  resource: 'db:organization',
  id: 'o1',
  actions,
});
const onSpace = (id: string, actions: Record<string, boolean>): EntitlementEntry => ({
  resource: 'db:space',
  anchor: { resource: 'db:space', id },
  actions,
});

const organizationOwner: Permissions = [grants(onOrg({ own: true }))];
// A member: manages o1 by role, and owns s2 by an entitlement the organization granted.
const member: Permissions = [
  grants(onOrg({ manage: true })),
  { entries: [onSpace('s2', { own: true })], owner: organizationOwner },
];
const reader: Permissions = [grants(onOrg({ read: true }))];

describe('delegate: a delegate resolves to permissions from its owner', () => {
  test('full: the owner whole, its entitlements included', async () => {
    const table = delegate(schema, member, { full: true });
    expect(table).toBe(member);
    expect(await can(table, 'db:space', s2, 'own')).toBe(true);
    expect(await can(table, 'db:organization', o1, 'manage')).toBe(true);
  });

  test('full wins over a ceiling and entitlements beside it', () => {
    expect(
      delegate(schema, member, {
        full: true,
        ceiling: 'read',
        entitlements: [onSpace('s1', { read: true })],
      }),
    ).toBe(member);
  });

  test("a ceiling caps the owner's table grants by the schema chain", () => {
    const owner: Permissions = [
      grants(
        onOrg({ own: true }),
        { resource: 'db:space', id: 's1', actions: { read: true } },
        { resource: 'db:user', id: 'u1', actions: { own: true } },
      ),
      grants({ resource: 'db:user', id: 'u1', actions: { own: true } }),
    ];
    expect(delegate(schema, owner, { ceiling: 'operate' })).toEqual([
      grants(onOrg({ operate: true, read: true }), {
        resource: 'db:space',
        id: 's1',
        actions: { read: true },
      }),
    ]);
  });

  test("a ceiling never carries the owner's entitlements", async () => {
    const table = delegate(schema, member, { ceiling: 'own' });
    expect(table).toEqual([grants(onOrg({ manage: true, operate: true, read: true }))]);
    expect(await can(table, 'db:space', s2, 'own')).toBe(false);
    expect(await can(table, 'db:space', s2, 'manage')).toBe(true);
  });

  test('stored entitlements are backed by the owner and re-checked live', async () => {
    const entitlements = [onSpace('s1', { manage: true })];
    const managed = delegate(schema, member, { entitlements });
    expect(managed).toEqual([{ entries: entitlements, owner: member }]);
    expect(await can(managed, 'db:space', s1, 'manage')).toBe(true);
    expect(await can(managed, 'db:organization', o1, 'read')).toBe(false);

    const lost = delegate(schema, reader, { entitlements });
    expect(await can(lost, 'db:space', s1, 'manage')).toBe(false);
    expect(await can(lost, 'db:space', s1, 'read')).toBe(true);
  });

  test('a ceiling and entitlements together: the capped table plus the entitlements', async () => {
    const table = delegate(schema, member, {
      ceiling: 'read',
      entitlements: [onSpace('s1', { manage: true })],
    });
    expect(await can(table, 'db:organization', o1, 'read')).toBe(true);
    expect(await can(table, 'db:organization', o1, 'operate')).toBe(false);
    expect(await can(table, 'db:space', s1, 'manage')).toBe(true);
    expect(await can(table, 'db:space', s2, 'manage')).toBe(false);
  });

  test('silence never widens: nothing set is nothing', () => {
    const silent: Delegation[] = [
      {},
      { full: false },
      { entitlements: [] },
      { full: false, entitlements: [] },
    ];
    for (const d of silent) expect(delegate(schema, member, d)).toEqual([]);
  });

  test('a ceiling the owner holds nothing under is nothing', () => {
    expect(
      delegate(schema, [grants({ resource: 'db:user', id: 'u1', actions: { own: true } })], {
        ceiling: 'operate',
      }),
    ).toEqual([]);
  });
});

describe('delegate chaining: a token on an integration of a member', () => {
  test("a full token on a full integration resolves to the member's table", async () => {
    const token = delegate(schema, delegate(schema, member, { full: true }), { full: true });
    expect(token).toBe(member);
    expect(await can(token, 'db:space', s2, 'own')).toBe(true);
  });

  test("a role token on a full integration caps the member's table", async () => {
    const integration = delegate(schema, member, { full: true });
    const token = delegate(schema, integration, { ceiling: 'read' });
    expect(token).toEqual(delegate(schema, member, { ceiling: 'read' }));
    expect(await can(token, 'db:organization', o1, 'read')).toBe(true);
    expect(await can(token, 'db:organization', o1, 'manage')).toBe(false);
    expect(await can(token, 'db:space', s2, 'own')).toBe(false);
  });

  test("a full token on a role integration is the integration's capped table", async () => {
    const integration = delegate(schema, member, { ceiling: 'operate' });
    const token = delegate(schema, integration, { full: true });
    expect(token).toEqual([grants(onOrg({ operate: true, read: true }))]);
    expect(await can(token, 'db:space', s1, 'operate')).toBe(true);
    expect(await can(token, 'db:space', s1, 'manage')).toBe(false);
  });

  test('a role token on a role integration: the lower ceiling', () => {
    const integration = delegate(schema, member, { ceiling: 'operate' });
    expect(delegate(schema, integration, { ceiling: 'manage' })).toEqual(integration);
    expect(delegate(schema, integration, { ceiling: 'read' })).toEqual([
      grants(onOrg({ read: true })),
    ]);
  });

  test("entitlements on a token over an integration are backed by the integration's table", async () => {
    const entitlements = [onSpace('s1', { manage: true })];
    const capped = delegate(schema, delegate(schema, member, { ceiling: 'operate' }), {
      entitlements,
    });
    expect(await can(capped, 'db:space', s1, 'manage')).toBe(false);
    expect(await can(capped, 'db:space', s1, 'operate')).toBe(true);

    const full = delegate(schema, delegate(schema, member, { full: true }), { entitlements });
    expect(await can(full, 'db:space', s1, 'manage')).toBe(true);
    expect(await can(full, 'db:space', s2, 'manage')).toBe(false);
  });

  test("a token's entitlements reach through the integration to the member's own entitlements", async () => {
    const integration = delegate(schema, member, { full: true });
    const token = delegate(schema, integration, { entitlements: [onSpace('s2', { own: true })] });
    expect(await can(token, 'db:space', s2, 'own')).toBe(true);
    const roleIntegration = delegate(schema, member, { ceiling: 'own' });
    const roleToken = delegate(schema, roleIntegration, {
      entitlements: [onSpace('s2', { own: true })],
    });
    expect(await can(roleToken, 'db:space', s2, 'own')).toBe(false);
  });
});
