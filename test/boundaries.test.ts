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

// Scenarios, not the template's schema: a distributor, organizations, products, orders, and an
// org-to-org customer junction. Two kinds of junction reach a distributor:
// - an agent: the org holds a role at the distributor and acts for it (a membership);
// - a licensee: the distributor delegates actions on its products to the org (entitlements it owns),
//   the way an org delegates to its members.

const standard = (rel?: string) => ({
  own: rel ? { rel, action: 'own' } : null,
  manage: rel ? { any: ['own', { rel, action: 'manage' }] } : 'own',
  operate: rel ? { any: ['manage', { rel, action: 'operate' }] } : 'manage',
  read: rel ? { any: ['operate', { rel, action: 'read' }] } : 'operate',
});

const schema: RebacSchema = {
  permissions: {
    'db:distributor': { actions: standard() },
    'db:product': {
      actions: {
        ...standard('distributor'),
        resell: 'manage',
        order: 'resell',
        read: { any: ['operate', 'order', { rel: 'distributor', action: 'read' }] },
      },
    },
    'db:organization': {
      actions: { ...standard(), sell: 'own', purchase: { any: ['sell', 'manage'] } },
    },
    'db:order': {
      actions: {
        create: {
          all: [
            { rel: 'buyer', action: 'purchase' },
            { rel: 'product', action: 'order' },
          ],
        },
        resell: {
          all: [
            { rel: 'buyer', action: 'sell' },
            { rel: 'product', action: 'resell' },
          ],
        },
      },
    },
    'db:license': {
      actions: {
        create: { rel: 'distributor', action: 'operate' },
        read: { any: ['create', { rel: 'licensee', action: 'read' }] },
      },
    },
    'db:customer': {
      actions: {
        manage: { rel: 'vendor', action: 'manage' },
        read: {
          any: ['manage', { rel: 'vendor', action: 'read' }, { rel: 'buyer', action: 'read' }],
        },
      },
    },
  },
};
const map = mapOf({
  'db:product': { distributor: 'db:distributor' },
  'db:order': { buyer: 'db:organization', product: 'db:product' },
  'db:license': { distributor: 'db:distributor', licensee: 'db:organization' },
  'db:customer': { vendor: 'db:organization', buyer: 'db:organization' },
});
const check = createRebacCheck(map);
const canGrant = createCanGrantEntitlement(map);

const table = async (...entries: PermissionEntry[]) => {
  const permix = createPermissions();
  await permix.setup(entries);
  return permix;
};
const given = async (holder: Permix, owner: Permix, ...entries: EntitlementEntry[]) => {
  await holder.setup(entries, { owner });
  return holder;
};

const line = (value: string) => ({ field: 'line', operator: Operator.equals, value });
const color = (value: string) => ({ field: 'color', operator: Operator.equals, value });
const productsOf = (
  distributorId: string,
  actions: string[],
  where?: EntitlementEntry['where'],
): EntitlementEntry => ({
  resource: 'db:product',
  anchor: { resource: 'db:distributor', id: distributorId, path: 'distributor' },
  ...(where ? { where } : {}),
  actions: Object.fromEntries(actions.map((action) => [action, true])),
});

const at = (resource: string, id: string, ...actions: string[]): PermissionEntry =>
  ({ resource, id, actions: Object.fromEntries(actions.map((a) => [a, true])) }) as PermissionEntry;

const distributor = (...ids: string[]) =>
  table(...(ids.length ? ids : ['d']).map((id) => at('db:distributor', id, 'own')));
const organization = (id: string, role = 'own') => table(at('db:organization', id, role));

const product = (distributorId = 'd', productLine = 'tools', productColor = 'red') => ({
  id: 'p',
  line: productLine,
  color: productColor,
  distributorId,
  distributor: { id: distributorId },
});
const orderBy = (buyerId: string, p: Row = product()) => ({
  id: 'n',
  buyerId,
  buyer: { id: buyerId },
  productId: p.id,
  product: p,
});

const onProduct = (permix: Permix, action: string, p: Row = product()) =>
  check(permix, schema, { resource: 'db:product', record: p }, action);
const ordering = (permix: Permix, buyerId: string, p: Row = product()) =>
  check(permix, schema, { resource: 'db:order', record: orderBy(buyerId, p) }, 'create');
const reselling = (permix: Permix, buyerId: string, p: Row = product()) =>
  check(permix, schema, { resource: 'db:order', record: orderBy(buyerId, p) }, 'resell');
const grants = (writer: Permix, entry: EntitlementEntry) => {
  const placed = placeEntitlement(map, entry, { id: entry.anchor.id });
  return !!placed?.length && placed.every((record) => canGrant(writer, schema, entry, record));
};

const RETAIL = ['order'];
const WHOLESALE = ['resell'];
const licensee = async (
  id: string,
  actions: string[],
  issuer?: Permix,
  where?: EntitlementEntry['where'],
) =>
  given(await organization(id), issuer ?? (await distributor()), productsOf('d', actions, where));
const onDistributor = (permix: Permix, action: string, id = 'd') =>
  check(permix, schema, { resource: 'db:distributor', record: { id } }, action);

describe('two kinds of junction: an agent acts for the distributor, a licensee acts on its products', () => {
  test('an agent (operate at the distributor) operates and reads its products; it cannot buy them for itself', async () => {
    const agent = await table(
      at('db:organization', 'a', 'own'),
      at('db:distributor', 'd', 'operate'),
    );
    expect(
      ['operate', 'read', 'manage', 'order', 'resell'].map((a) => onProduct(agent, a)),
    ).toEqual([true, true, false, false, false]);
    expect([onDistributor(agent, 'read'), ordering(agent, 'a')]).toEqual([true, false]);
  });

  test('a wholesale licensee resells, orders and reads products; it never operates them', async () => {
    const wholesaler = await licensee('o1', WHOLESALE);
    expect(
      ['resell', 'order', 'read', 'operate', 'manage'].map((a) => onProduct(wholesaler, a)),
    ).toEqual([true, true, true, false, false]);
    expect(onDistributor(wholesaler, 'read')).toBe(false);
  });

  test('an org that is both: the union of the two, nothing more', async () => {
    const both = await given(
      await table(at('db:organization', 'o1', 'own'), at('db:distributor', 'd', 'read')),
      await distributor(),
      productsOf('d', RETAIL),
    );
    expect(onDistributor(both, 'read')).toBe(true);
    expect(['order', 'read', 'resell', 'operate'].map((a) => onProduct(both, a))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(ordering(both, 'o1')).toBe(true);
  });

  test('an agent that is also a licensee passes its license on, though its role could not', async () => {
    const both = await given(
      await table(at('db:organization', 'o1', 'own'), at('db:distributor', 'd', 'operate')),
      await distributor(),
      productsOf('d', WHOLESALE),
    );
    const agentOnly = await table(at('db:distributor', 'd', 'operate'));
    expect([
      grants(both, productsOf('d', WHOLESALE)),
      grants(agentOnly, productsOf('d', RETAIL)),
    ]).toEqual([true, false]);
  });

  test('either junction reaches only its own distributor', async () => {
    const agent = await table(at('db:distributor', 'd', 'operate'));
    const wholesaler = await licensee('o1', WHOLESALE, await distributor('d', 'd2'));
    expect([
      onProduct(agent, 'read', product('d2')),
      onProduct(wholesaler, 'read', product('d2')),
    ]).toEqual([false, false]);
  });
});

describe('a license: the org’s side and the distributor’s side both say yes', () => {
  test('retail orders, wholesale resells, the org side decides who inside the org may', async () => {
    const retail = await licensee('o1', RETAIL);
    expect([ordering(retail, 'o1'), reselling(retail, 'o1')]).toEqual([true, false]);
    const wholesale = await licensee('o1', WHOLESALE);
    expect(reselling(wholesale, 'o1')).toBe(true);
    const admin = await given(
      await organization('o1', 'manage'),
      wholesale,
      productsOf('d', WHOLESALE),
    );
    const reader = await given(
      await organization('o1', 'read'),
      wholesale,
      productsOf('d', WHOLESALE),
    );
    expect([ordering(admin, 'o1'), reselling(admin, 'o1')]).toEqual([true, false]);
    expect([onProduct(reader, 'read'), ordering(reader, 'o1')]).toEqual([true, false]);
  });

  test('wholesale drops to retail: resell stops, order and read stay (R111)', async () => {
    const wholesale = await licensee('o1', WHOLESALE);
    const member = await given(await organization('o1'), wholesale, productsOf('d', WHOLESALE));
    expect(reselling(member, 'o1')).toBe(true);
    const dropped = await licensee('o1', RETAIL);
    const sameMember = await given(await organization('o1'), dropped, productsOf('d', WHOLESALE));
    expect([
      reselling(sameMember, 'o1'),
      ordering(sameMember, 'o1'),
      onProduct(sameMember, 'read'),
    ]).toEqual([false, true, true]);
  });

  test('revoked: the license, every share of it, and passing it on are dead', async () => {
    const revoked = await given(
      await organization('o1'),
      await organization('o1'),
      productsOf('d', WHOLESALE),
    );
    const member = await given(await organization('o1'), revoked, productsOf('d', WHOLESALE));
    expect([onProduct(revoked, 'read'), onProduct(member, 'read')]).toEqual([false, false]);
    expect(grants(revoked, productsOf('d', RETAIL))).toBe(false);
  });

  test('a line license: that line only; passed on narrower, never wider', async () => {
    const tools = await licensee('o1', RETAIL, undefined, line('tools'));
    expect([onProduct(tools, 'order'), onProduct(tools, 'order', product('d', 'paint'))]).toEqual([
      true,
      false,
    ]);
    expect(grants(tools, productsOf('d', RETAIL, line('tools')))).toBe(true);
    expect(grants(tools, productsOf('d', RETAIL, { all: [line('tools'), color('red')] }))).toBe(
      true,
    );
    expect(grants(tools, productsOf('d', RETAIL))).toBe(false);
    expect(grants(tools, productsOf('d', RETAIL, line('paint')))).toBe(false);
  });

  test('last mile: a member’s share anchored at d misses a product moved to d2, though the org licenses both', async () => {
    const both = await given(
      await organization('o1'),
      await distributor('d', 'd2'),
      productsOf('d', WHOLESALE),
      productsOf('d2', WHOLESALE),
    );
    const member = await given(await organization('o1'), both, productsOf('d', WHOLESALE));
    expect([
      onProduct(both, 'order', product('d2')),
      onProduct(member, 'order', product('d2')),
    ]).toEqual([true, false]);
    expect(onProduct(member, 'order', product('d'))).toBe(true);
  });

  test('two distributors: each license lives and dies on its own', async () => {
    const d = await distributor('d');
    const d2 = await distributor('d2');
    const vendor = await given(
      await given(await organization('v'), d, productsOf('d', WHOLESALE)),
      d2,
      productsOf('d2', RETAIL),
    );
    const buyer = await given(
      await organization('b'),
      vendor,
      productsOf('d', RETAIL),
      productsOf('d2', RETAIL),
    );
    expect([ordering(buyer, 'b'), ordering(buyer, 'b', product('d2'))]).toEqual([true, true]);
    expect(grants(vendor, productsOf('d2', WHOLESALE))).toBe(false);
    const withoutD = await given(await organization('v'), d2, productsOf('d2', RETAIL));
    const sameBuyer = await given(
      await organization('b'),
      withoutD,
      productsOf('d', RETAIL),
      productsOf('d2', RETAIL),
    );
    expect([ordering(sameBuyer, 'b'), ordering(sameBuyer, 'b', product('d2'))]).toEqual([
      false,
      true,
    ]);
  });
});

describe('several boundaries in one chain: distributor → vendor org → (customer) → buyer org → member → token', () => {
  const chain = async ({
    vendorLicense = WHOLESALE as string[] | null,
    sublicense = RETAIL as string[] | null,
    memberShare = RETAIL as string[] | null,
    tokenShare = RETAIL as string[] | null,
  } = {}) => {
    const vendor = await organization('v');
    if (vendorLicense) await given(vendor, await distributor(), productsOf('d', vendorLicense));
    const buyer = await organization('b');
    if (sublicense) await given(buyer, vendor, productsOf('d', sublicense));
    const member = await organization('b');
    if (memberShare) await given(member, buyer, productsOf('d', memberShare));
    const token = await organization('b');
    if (tokenShare) await given(token, member, productsOf('d', tokenShare));
    return { vendor, buyer, member, token };
  };

  test('every link holds: the token orders for the buyer; it resells only if every link holds resell', async () => {
    const { token } = await chain();
    expect([ordering(token, 'b'), reselling(token, 'b')]).toEqual([true, false]);
    const resale = await chain({
      sublicense: WHOLESALE,
      memberShare: WHOLESALE,
      tokenShare: WHOLESALE,
    });
    expect(reselling(resale.token, 'b')).toBe(true);
    const oneLinkRetail = await chain({ memberShare: WHOLESALE, tokenShare: WHOLESALE });
    expect([reselling(oneLinkRetail.token, 'b'), ordering(oneLinkRetail.token, 'b')]).toEqual([
      false,
      true,
    ]);
  });

  test('the vendor drops to retail: its customers still order (order is at or below retail)', async () => {
    expect(ordering((await chain({ vendorLicense: RETAIL })).token, 'b')).toBe(true);
  });

  test.each([
    ['the vendor’s license is revoked', { vendorLicense: null }],
    [
      'the vendor delists the buyer (the customer row and the sublicense it carries go)',
      { sublicense: null },
    ],
    ['the buyer takes it back from the member', { memberShare: null }],
    ['the member takes it back from the token', { tokenShare: null }],
  ])('cut one link (%s): the token orders nothing', async (_, cut) => {
    const { token } = await chain(cut);
    expect([ordering(token, 'b'), onProduct(token, 'read')]).toEqual([false, false]);
  });

  test('down the chain, each holder passes on only what it holds', async () => {
    const { vendor, buyer, member } = await chain();
    expect([
      grants(vendor, productsOf('d', WHOLESALE)),
      grants(vendor, productsOf('d', RETAIL)),
    ]).toEqual([true, true]);
    expect([
      grants(buyer, productsOf('d', RETAIL)),
      grants(buyer, productsOf('d', WHOLESALE)),
    ]).toEqual([true, false]);
    expect([
      grants(member, productsOf('d', RETAIL)),
      grants(member, productsOf('d', WHOLESALE)),
    ]).toEqual([true, false]);
  });
});

describe('cycles between orgs', () => {
  test('two orgs licensing each other with no distributor behind them hold nothing; a root gives exactly the root’s level', async () => {
    const v = await organization('v');
    const b = await organization('b');
    await given(v, b, productsOf('d', WHOLESALE));
    await given(b, v, productsOf('d', WHOLESALE));
    expect([
      onProduct(v, 'read'),
      onProduct(b, 'read'),
      grants(b, productsOf('d', RETAIL)),
    ]).toEqual([false, false, false]);
    await given(v, await distributor(), productsOf('d', RETAIL));
    expect([ordering(b, 'b'), reselling(b, 'b')]).toEqual([true, false]);
  });
});

describe('an agent issues a license by writing the License row; the license is the distributor’s (R124)', () => {
  const license = (distributorId = 'd', licenseeId = 'o1') => ({
    id: 'l',
    distributorId,
    distributor: { id: distributorId },
    licenseeId,
    licensee: { id: licenseeId },
  });
  const onLicense = (permix: Permix, action: string, row: Row = license()) =>
    check(permix, schema, { resource: 'db:license', record: row }, action);

  test('an operating agent writes a License row for its distributor only; a reading agent and the licensee cannot', async () => {
    const agent = await table(at('db:distributor', 'd', 'operate'));
    const reader = await table(at('db:distributor', 'd', 'read'));
    const holder = await organization('o1');
    expect([onLicense(agent, 'create'), onLicense(agent, 'create', license('d2'))]).toEqual([
      true,
      false,
    ]);
    expect([onLicense(reader, 'create'), onLicense(holder, 'create')]).toEqual([false, false]);
    expect([onLicense(holder, 'read'), onLicense(await organization('x'), 'read')]).toEqual([
      true,
      false,
    ]);
  });
});

describe('the customer junction itself: a record between two orgs, with permissions of its own', () => {
  const customer = {
    id: 'c',
    vendorId: 'v',
    vendor: { id: 'v' },
    buyerId: 'b',
    buyer: { id: 'b' },
  };
  const on = (permix: Permix, action: string) =>
    check(permix, schema, { resource: 'db:customer', record: customer }, action);

  test('the vendor’s managers manage it, both sides read it, a stranger sees nothing', async () => {
    const vendorAdmin = await organization('v', 'manage');
    const vendorReader = await organization('v', 'read');
    const buyerOwner = await organization('b');
    const stranger = await organization('x');
    expect([
      on(vendorAdmin, 'manage'),
      on(vendorReader, 'manage'),
      on(vendorReader, 'read'),
    ]).toEqual([true, false, true]);
    expect([on(buyerOwner, 'read'), on(buyerOwner, 'manage'), on(stranger, 'read')]).toEqual([
      true,
      false,
      false,
    ]);
  });
});
