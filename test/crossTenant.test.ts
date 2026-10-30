import { describe, expect, test } from 'bun:test';
import {
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  type RebacSchema,
} from '../index';
import { mapOf } from './schemaMaps';

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
  },
};
const check = createRebacCheck(mapOf({ 'db:space': { organization: 'db:organization' } }));
const o2 = { id: 'o2' };
const s = { id: 's', organizationId: 'o2', organization: o2 };

const granterAt = async (action: string) => {
  const granter = createPermissions();
  await granter.setup({
    resource: 'db:organization',
    id: 'o2',
    actions: { [action]: true },
  } as PermissionEntry);
  return granter;
};
const holderOf = async (held: string, granterAction: string) => {
  const holder = createPermissions();
  const entitlement: EntitlementEntry = {
    resource: 'db:space',
    anchor: { resource: 'db:space', id: 's' },
    actions: { [held]: true },
  };
  await holder.setup([entitlement], { owner: await granterAt(granterAction) });
  return (action: string) => check(holder, schema, { resource: 'db:space', record: s }, action);
};

describe('a cross-tenant entitlement holds an action only while the entitlement and its granter both say yes (R111)', () => {
  test('entitlement manage, granter degraded to read: manage no, operate no, read yes, own no', async () => {
    const may = await holderOf('manage', 'read');
    expect(may('manage')).toBe(false);
    expect(may('operate')).toBe(false);
    expect(may('read')).toBe(true);
    expect(may('own')).toBe(false);
  });

  test('entitlement manage, granter still own: everything up to manage, not own', async () => {
    const may = await holderOf('manage', 'own');
    expect(may('manage')).toBe(true);
    expect(may('read')).toBe(true);
    expect(may('own')).toBe(false);
  });

  test('entitlement read, granter own: read yes, manage no', async () => {
    const may = await holderOf('read', 'own');
    expect(may('read')).toBe(true);
    expect(may('manage')).toBe(false);
  });
});

describe('three sides: every granter down the chain must say yes too (R112)', () => {
  const spaceEntitlement = (action: string): EntitlementEntry => ({
    resource: 'db:space',
    anchor: { resource: 'db:space', id: 's' },
    actions: { [action]: true },
  });

  test('holder ← granter (entitlement manage) ← its granter (role read at the tenant): read yes, manage no', async () => {
    const granter = createPermissions();
    await granter.setup([spaceEntitlement('manage')], { owner: await granterAt('read') });
    const holder = createPermissions();
    await holder.setup([spaceEntitlement('manage')], { owner: granter });
    const may = (action: string) =>
      check(holder, schema, { resource: 'db:space', record: s }, action);
    expect(may('read')).toBe(true);
    expect(may('manage')).toBe(false);
  });
});

describe('two jumps: a user token reaches a distributor product through the org the user is in (R113)', () => {
  const chainSchema: RebacSchema = {
    permissions: {
      'db:distributor': {
        actions: { own: null, manage: 'own', operate: 'manage', read: 'operate' },
      },
      'db:product': {
        actions: {
          own: { rel: 'distributor', action: 'own' },
          manage: { any: ['own', { rel: 'distributor', action: 'manage' }] },
          operate: { any: ['manage', { rel: 'distributor', action: 'operate' }] },
          read: { any: ['operate', { rel: 'distributor', action: 'read' }] },
        },
      },
    },
  };
  const chainCheck = createRebacCheck(mapOf({ 'db:product': { distributor: 'db:distributor' } }));
  const productOf = (distributorId: string) => ({
    id: 'p',
    distributorId,
    distributor: { id: distributorId },
  });
  const readProducts: EntitlementEntry = {
    resource: 'db:product',
    anchor: { resource: 'db:distributor', id: 'd', path: 'distributor' },
    actions: { read: true },
  };

  const chain = async ({ distributorBacks = true, orgHolds = true, userHolds = true } = {}) => {
    const distributor = createPermissions();
    if (distributorBacks)
      await distributor.setup({
        resource: 'db:distributor',
        id: 'd',
        actions: { own: true },
      } as PermissionEntry);
    const organization = createPermissions();
    if (orgHolds) await organization.setup([readProducts], { owner: distributor });
    const user = createPermissions();
    if (userHolds) await user.setup([readProducts], { owner: organization });
    const token = createPermissions();
    await token.setup([readProducts], { owner: user });
    return (record: ReturnType<typeof productOf>, action: string) =>
      chainCheck(token, chainSchema, { resource: 'db:product', record }, action);
  };

  test('every jump holds: the token reads the product, and no more', async () => {
    const may = await chain();
    expect(may(productOf('d'), 'read')).toBe(true);
    expect(may(productOf('d'), 'manage')).toBe(false);
  });

  test('the distributor no longer backs it (the bridge into the org): nothing', async () => {
    expect((await chain({ distributorBacks: false }))(productOf('d'), 'read')).toBe(false);
  });

  test('the org no longer holds it (the jump to the user): nothing', async () => {
    expect((await chain({ orgHolds: false }))(productOf('d'), 'read')).toBe(false);
  });

  test('the user no longer holds it (the token’s own link): nothing', async () => {
    expect((await chain({ userHolds: false }))(productOf('d'), 'read')).toBe(false);
  });

  test('the last mile: the product moved to another distributor, so the token reaches nothing', async () => {
    expect((await chain())(productOf('d2'), 'read')).toBe(false);
  });
});
