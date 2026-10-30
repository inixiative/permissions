import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  type Permix,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

const verbs = (on: string) => ({
  resell: { rel: on, action: 'resell' },
  order: { any: ['resell', { rel: on, action: 'order' }] },
  read: { any: ['order', { rel: on, action: 'read' }] },
});

const schema: RebacSchema = {
  permissions: {
    'db:distributor': {
      actions: { own: null, resell: 'own', order: 'resell', read: 'order' },
    },
    'db:product': { actions: verbs('distributor') },
    'db:organization': {
      actions: {
        own: null,
        manage: 'own',
        read: 'manage',
        'distributor.resell': 'own',
        'distributor.order': { any: ['distributor.resell', 'manage'] },
        'distributor.read': { any: ['distributor.order', 'read'] },
      },
    },
    'db:space': {
      actions: {
        manage: { rel: 'organization', action: 'manage' },
        'distributor.resell': { rel: 'organization', action: 'distributor.resell' },
        'distributor.order': {
          any: [
            'distributor.resell',
            'manage',
            { rel: 'organization', action: 'distributor.order' },
          ],
        },
      },
    },
    'db:order': {
      actions: {
        create: {
          all: [
            { rel: 'space', action: 'distributor.order' },
            { rel: 'product', action: 'order' },
          ],
        },
        resell: {
          all: [
            { rel: 'space', action: 'distributor.resell' },
            { rel: 'product', action: 'resell' },
          ],
        },
      },
    },
  },
};
const check = createRebacCheck(
  mapOf({
    'db:product': { distributor: 'db:distributor' },
    'db:space': { organization: 'db:organization' },
    'db:order': { space: 'db:space', product: 'db:product' },
  }),
);

type Level = 'retail' | 'wholesale';
type License = { distributorId: string; level?: Level; line?: string };

const LEVEL_ACTION: Record<Level, string> = { retail: 'order', wholesale: 'resell' };
const distributorAnchor = (id: string) => ({ resource: 'db:distributor', id, path: 'distributor' });
const productsOf = (distributorId: string, action: string, line?: string): EntitlementEntry => ({
  resource: 'db:product',
  anchor: distributorAnchor(distributorId),
  ...(line ? { where: { field: 'line', operator: Operator.equals, value: line } } : {}),
  actions: { [action]: true },
});
const table = async (...entries: PermissionEntry[]) => {
  const permix = createPermissions();
  await permix.setup(entries);
  return permix;
};

const distributorOf = (id: string) =>
  table({ resource: 'db:distributor', id, actions: { own: true } });

const organizationFrom = async (licenses: License[]) => {
  const organization = await table({
    resource: 'db:organization',
    id: 'o1',
    actions: { own: true },
  });
  for (const { distributorId, level, line } of licenses) {
    if (level)
      await organization.setup({
        resource: 'db:distributor',
        id: distributorId,
        actions: { [LEVEL_ACTION[level]]: true },
      });
    if (line)
      await organization.setup([productsOf(distributorId, 'order', line)], {
        owner: await distributorOf(distributorId),
      });
  }
  return organization;
};

const shareFrom = async (holder: Permix, organization: Permix, distributorIds = ['d']) => {
  await holder.setup(
    distributorIds.map((id) => productsOf(id, 'resell')),
    { owner: organization },
  );
  return holder;
};
const memberOf = async (organization: Permix, role: 'own' | 'manage' | 'read') =>
  shareFrom(
    await table({ resource: 'db:organization', id: 'o1', actions: { [role]: true } }),
    organization,
  );

const o1 = { id: 'o1' };
const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
const s2 = { id: 's2', organizationId: 'o1', organization: o1 };
const product = (distributorId = 'd', line = 'tools') => ({
  id: 'p',
  line,
  distributorId,
  distributor: { id: distributorId },
});
const orderOf = (p: Row, space: Row = s1) => ({
  id: 'n',
  spaceId: space.id,
  space,
  productId: p.id,
  product: p,
});

const can = (
  permix: Permix,
  action: 'read' | 'order' | 'resell',
  p: Row = product(),
  space?: Row,
) =>
  action === 'read'
    ? check(permix, schema, { resource: 'db:product', record: p }, 'read')
    : check(
        permix,
        schema,
        { resource: 'db:order', record: orderOf(p, space) },
        action === 'order' ? 'create' : 'resell',
      );

describe('a license is a junction: the org’s side and the distributor’s side must both say yes (R113, R116, R118)', () => {
  test('1. retail: the org owner reads and orders, not resell; wholesale: resells too', async () => {
    const retail = await memberOf(
      await organizationFrom([{ distributorId: 'd', level: 'retail' }]),
      'own',
    );
    expect([can(retail, 'read'), can(retail, 'order'), can(retail, 'resell')]).toEqual([
      true,
      true,
      false,
    ]);
    const wholesale = await memberOf(
      await organizationFrom([{ distributorId: 'd', level: 'wholesale' }]),
      'own',
    );
    expect(can(wholesale, 'resell')).toBe(true);
  });

  test('2. both sides: an admin orders under the license; a reader does not, though the license allows it', async () => {
    const organization = await organizationFrom([{ distributorId: 'd', level: 'wholesale' }]);
    const admin = await memberOf(organization, 'manage');
    const reader = await memberOf(organization, 'read');
    expect([can(admin, 'order'), can(admin, 'resell')]).toEqual([true, false]);
    expect([can(reader, 'read'), can(reader, 'order')]).toEqual([true, false]);
  });

  test('3. a space admin orders in their space through its delegated distributor.order, capped by the license', async () => {
    const spaceAdmin = async (licenses: License[]) =>
      shareFrom(
        await table({ resource: 'db:space', id: 's1', actions: { manage: true } }),
        await organizationFrom(licenses),
      );
    const licensed = await spaceAdmin([{ distributorId: 'd', level: 'retail' }]);
    expect(can(licensed, 'order', product(), s1)).toBe(true);
    expect(can(licensed, 'order', product(), s2)).toBe(false);
    expect(can(await spaceAdmin([]), 'order', product(), s1)).toBe(false);
  });

  test('4. license revoked: the member keeps its share, and it reaches nothing', async () => {
    const owner = await memberOf(await organizationFrom([]), 'own');
    expect([can(owner, 'read'), can(owner, 'order')]).toEqual([false, false]);
  });

  test('5. wholesale drops to retail: resell stops, order and read stay (R111)', async () => {
    const owner = await memberOf(
      await organizationFrom([{ distributorId: 'd', level: 'retail' }]),
      'own',
    );
    expect([can(owner, 'resell'), can(owner, 'order'), can(owner, 'read')]).toEqual([
      false,
      true,
      true,
    ]);
  });

  test('6. an entitlement license: order on one line, read through it, nothing else; gone when revoked', async () => {
    const owner = await memberOf(
      await organizationFrom([{ distributorId: 'd', line: 'tools' }]),
      'own',
    );
    expect([can(owner, 'order'), can(owner, 'read'), can(owner, 'resell')]).toEqual([
      true,
      true,
      false,
    ]);
    expect(can(owner, 'order', product('d', 'paint'))).toBe(false);
    expect(can(await memberOf(await organizationFrom([]), 'own'), 'order')).toBe(false);
  });

  test('7. a token holds only what it was given: order, not the resell its member can', async () => {
    const organization = await organizationFrom([{ distributorId: 'd', level: 'wholesale' }]);
    const member = await memberOf(organization, 'own');
    const token = await table({ resource: 'db:organization', id: 'o1', actions: { own: true } });
    await token.setup([productsOf('d', 'order')], { owner: member });
    expect([can(token, 'order'), can(token, 'resell')]).toEqual([true, false]);
    expect(can(member, 'resell')).toBe(true);
  });

  test('8. last mile: a product moved to another distributor is out of reach, even one the org also licenses', async () => {
    const owner = await memberOf(
      await organizationFrom([
        { distributorId: 'd', level: 'wholesale' },
        { distributorId: 'd2', level: 'wholesale' },
      ]),
      'own',
    );
    expect(can(owner, 'order', product('d'))).toBe(true);
    expect(can(owner, 'order', product('d2'))).toBe(false);
  });
});
