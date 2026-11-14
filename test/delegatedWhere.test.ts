import { describe, expect, test } from 'bun:test';
import { type Condition, Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  delegatedWhere,
  type EntitlementEntry,
  type Permix,
  placeEntitlement,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

const is = (field: string, value: string): Condition => ({
  field,
  operator: Operator.equals,
  value,
});
const slack = is('provider', 'slack');
const general = is('channel', 'general');
const team = is('team', 't1');
const both: Condition = { all: [slack, team] };

describe('delegatedWhere', () => {
  test('nothing added keeps the held where exactly; nothing held keeps what is added', () => {
    expect(delegatedWhere(slack)).toEqual(slack);
    expect(delegatedWhere(undefined, general)).toEqual(general);
    expect(delegatedWhere(undefined)).toBeUndefined();
    expect(delegatedWhere(null, general)).toEqual(general);
    expect(delegatedWhere(slack, null)).toEqual(slack);
  });

  test('added conditions come first, then the held conjuncts, flat and each kept intact', () => {
    expect(delegatedWhere(slack, general)).toEqual({ all: [general, slack] });
    expect(delegatedWhere(both, general)).toEqual({ all: [general, slack, team] });
    expect(delegatedWhere(slack, slack)).toEqual(slack);
  });
});

describe('the copy rule reads what delegatedWhere builds as narrowing the held where', () => {
  const schema: RebacSchema = {
    permissions: {
      'db:space': { actions: { own: null } },
      'db:integration': { actions: { read: { rel: 'space', action: 'own' } } },
    },
  };
  const map = mapOf({ 'db:integration': { space: 'db:space' } });
  const canGrant = createCanGrantEntitlement(map);
  const underS1 = (where?: Condition): EntitlementEntry => ({
    resource: 'db:integration',
    anchor: { resource: 'db:space', id: 's1', path: 'space' },
    actions: { read: true },
    ...(where === undefined ? {} : { where }),
  });

  const holderOf = async (held: Condition) => {
    const owner = createPermissions();
    await owner.setup({ resource: 'db:space', id: 's1', actions: { own: true } });
    const holder = createPermissions();
    await holder.setup(underS1(held), { owner });
    return holder;
  };

  const grants = async (held: Condition, entry: EntitlementEntry) => {
    const placed = placeEntitlement(map, entry, { id: 's1' }) as Row[];
    const holder = await holderOf(held);
    return placed.every((record) => canGrant(holder, schema, entry, record));
  };

  test('a held where narrowed by delegatedWhere is passed on; the held where dropped is not', async () => {
    expect(await grants(slack, underS1(delegatedWhere(slack, general)))).toBe(true);
    expect(await grants(both, underS1(delegatedWhere(both, general)))).toBe(true);
    expect(await grants(slack, underS1(general))).toBe(false);
  });

  test('the nested form is not a narrowing: a held all is spread, never nested', async () => {
    expect(await grants(both, underS1({ all: [general, both] }))).toBe(false);
  });
});

describe('a negated schema rule is refused in the grant walk too', () => {
  test('a negated rule on a field the placed record lacks throws instead of passing', async () => {
    const schema: RebacSchema = {
      permissions: {
        'db:space': { actions: { own: null } },
        'db:doc': {
          actions: {
            read: {
              all: [
                { rule: { field: 'secret', operator: Operator.notEquals, value: true } },
                { rel: 'space', action: 'own' },
              ],
            },
          },
        },
      },
    };
    const map = mapOf({ 'db:doc': { space: 'db:space' } });
    const writer = createPermissions();
    await writer.setup({ resource: 'db:space', id: 's1', actions: { own: true } });
    const entry: EntitlementEntry = {
      resource: 'db:doc',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      actions: { read: true },
    };
    const [placed] = placeEntitlement(map, entry, { id: 's1' }) as Row[];

    expect(() => createCanGrantEntitlement(map)(writer, schema, entry, placed as Row)).toThrow(
      'is not a positive schema rule',
    );
  });
});

describe('a list pin passes on at any depth: copies are judged by structure, the walk by the chain', () => {
  const schema: RebacSchema = {
    permissions: {
      'db:space': { actions: { own: null } },
      'db:thread': { actions: { read: { rel: 'space', action: 'own' } } },
    },
  };
  const map = mapOf({ 'db:thread': { space: 'db:space' } });
  const canGrant = createCanGrantEntitlement(map);
  const check = createRebacCheck(map);
  const threads = (where: Condition): EntitlementEntry => ({
    resource: 'db:thread',
    anchor: { resource: 'db:space', id: 's1', path: 'space' },
    actions: { read: true },
    where,
  });
  const listed = (...ids: string[]): Condition => ({
    field: 'id',
    operator: Operator.in,
    value: ids,
  });
  const grantable = (writer: Permix, entry: EntitlementEntry) =>
    (placeEntitlement(map, entry, { id: 's1' }) as Row[]).every((record) =>
      canGrant(writer, schema, entry, record),
    );
  const holding = async (owner: Permix, entry: EntitlementEntry) => {
    const holder = createPermissions();
    await holder.setup(entry, { owner });
    return holder;
  };
  const reads = (permix: Permix, id: string) =>
    check(
      permix,
      schema,
      { resource: 'db:thread', record: { id, spaceId: 's1', space: { id: 's1' } } },
      'read',
    );

  test('B pins [A, B], C copies it, D narrows to [A] beside it: each hop is granted, and reads only what every link allows', async () => {
    const owner = createPermissions();
    await owner.setup({ resource: 'db:space', id: 's1', actions: { own: true } });
    const pinned = threads(listed('tA', 'tB'));
    const b = await holding(owner, pinned);
    expect(grantable(b, pinned)).toBe(true);
    const c = await holding(b, pinned);
    const narrowed = threads(delegatedWhere(listed('tA', 'tB'), listed('tA')) as Condition);
    expect(grantable(c, pinned)).toBe(true);
    expect(grantable(c, narrowed)).toBe(true);
    const d = await holding(c, narrowed);

    expect([reads(c, 'tA'), reads(c, 'tB'), reads(c, 'tC')]).toEqual([true, true, false]);
    expect([reads(d, 'tA'), reads(d, 'tB')]).toEqual([true, false]);
    expect(grantable(c, threads(listed('tA', 'tC')))).toBe(false);
  });
});
