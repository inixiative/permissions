import { describe, expect, test } from 'bun:test';
import { type Condition, Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  delegatedWhere,
  type EntitlementEntry,
  type Permix,
  pseudoRecordsOfEntitlement,
  type Row,
} from '../index';
import { canGrantWithRules, checkWithRules, mapOf, type Rules } from './schemaMaps';

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
  const schema: Rules = {
    permissions: {
      'db:space': { actions: { own: null } },
      'db:integration': { actions: { read: { rel: 'space', action: 'own' } } },
    },
  };
  const schemaMap = mapOf(
    { 'db:integration': { space: 'db:space' } },
    {
      'db:integration': ['provider', 'channel', 'team', 'secret'],
      'db:doc': ['provider', 'channel', 'team', 'secret'],
      'db:thread': ['provider', 'channel', 'team'],
      'db:space': ['hidden'],
    },
  );
  const canGrant = canGrantWithRules(schemaMap);
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
    const pseudoRecord = pseudoRecordsOfEntitlement(schemaMap, entry, { id: 's1' }) as Row[];
    const holder = await holderOf(held);
    return pseudoRecord.every((record) => canGrant(holder, schema, entry, record));
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
  test('a negated rule on a field the pseudoRecord record lacks throws instead of passing', async () => {
    const schema: Rules = {
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
    const schemaMap = mapOf(
      { 'db:doc': { space: 'db:space' } },
      {
        'db:integration': ['provider', 'channel', 'team', 'secret'],
        'db:doc': ['provider', 'channel', 'team', 'secret'],
        'db:thread': ['provider', 'channel', 'team'],
        'db:space': ['hidden'],
      },
    );
    const writer = createPermissions();
    await writer.setup({ resource: 'db:space', id: 's1', actions: { own: true } });
    const entry: EntitlementEntry = {
      resource: 'db:doc',
      anchor: { resource: 'db:space', id: 's1', path: 'space' },
      actions: { read: true },
    };
    const [pseudoRecord] = pseudoRecordsOfEntitlement(schemaMap, entry, { id: 's1' }) as Row[];

    expect(() => canGrantWithRules(schemaMap)(writer, schema, entry, pseudoRecord as Row)).toThrow(
      'is not a well-formed positive rule',
    );
  });
});

describe('a list pin passes on at any depth: copies are judged by structure, the walk by the chain', () => {
  const schema: Rules = {
    permissions: {
      'db:space': { actions: { own: null } },
      'db:thread': { actions: { read: { rel: 'space', action: 'own' } } },
    },
  };
  const schemaMap = mapOf(
    { 'db:thread': { space: 'db:space' } },
    {
      'db:integration': ['provider', 'channel', 'team', 'secret'],
      'db:doc': ['provider', 'channel', 'team', 'secret'],
      'db:thread': ['provider', 'channel', 'team'],
      'db:space': ['hidden'],
    },
  );
  const canGrant = canGrantWithRules(schemaMap);
  const check = checkWithRules(schemaMap);
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
    (pseudoRecordsOfEntitlement(schemaMap, entry, { id: 's1' }) as Row[]).every((record) =>
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

describe('liveness asks the anchor and the action along the chain, never a where', () => {
  const schema: Rules = {
    permissions: {
      'db:space': { actions: { own: null } },
      'db:thread': { actions: { read: { rel: 'space', action: 'own' } } },
    },
  };
  const schemaMap = mapOf(
    { 'db:thread': { space: 'db:space' } },
    {
      'db:integration': ['provider', 'channel', 'team', 'secret'],
      'db:doc': ['provider', 'channel', 'team', 'secret'],
      'db:thread': ['provider', 'channel', 'team'],
      'db:space': ['hidden'],
    },
  );
  const canGrant = canGrantWithRules(schemaMap);
  const check = checkWithRules(schemaMap);
  const threads = (spaceId: string, where?: Condition): EntitlementEntry => ({
    resource: 'db:thread',
    anchor: { resource: 'db:space', id: spaceId, path: 'space' },
    actions: { read: true },
    ...(where === undefined ? {} : { where }),
  });
  const pinned: Condition = { field: 'id', operator: Operator.in, value: ['tA'] };
  const grantable = (writer: Permix, entry: EntitlementEntry, spaceId: string) =>
    (pseudoRecordsOfEntitlement(schemaMap, entry, { id: spaceId }) as Row[]).every((record) =>
      canGrant(writer, schema, entry, record),
    );
  const held = async (owner: Permix, entry: EntitlementEntry) => {
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

  test('a granter limited by a where counts as live; reads through that chain still apply it', async () => {
    const root = createPermissions();
    await root.setup({ resource: 'db:space', id: 's1', actions: { own: true } });
    const granter = await held(root, threads('s1', pinned));
    const writer = await held(granter, threads('s1'));

    expect(grantable(writer, threads('s1'), 's1')).toBe(true);
    const copy = await held(writer, threads('s1'));
    expect([reads(copy, 'tA'), reads(copy, 'tB')]).toEqual([true, false]);
  });

  test('a granter whose anchor no longer reaches the record backs nothing', async () => {
    const elsewhere = createPermissions();
    await elsewhere.setup({ resource: 'db:space', id: 's9', actions: { own: true } });
    const writer = await held(elsewhere, threads('s1'));

    expect(grantable(writer, threads('s1'), 's1')).toBe(false);
  });
});

describe('a negated schema rule throws for every caller', () => {
  test('a superadmin and a holder of a direct grant are refused the same as anyone', async () => {
    const schema: Rules = {
      permissions: {
        'db:space': {
          actions: {
            read: { rule: { field: 'hidden', operator: Operator.notEquals, value: true } },
          },
        },
      },
    };
    const check = checkWithRules(
      mapOf(
        { 'db:space': {} },
        {
          'db:integration': ['provider', 'channel', 'team', 'secret'],
          'db:doc': ['provider', 'channel', 'team', 'secret'],
          'db:thread': ['provider', 'channel', 'team'],
          'db:space': ['hidden'],
        },
      ),
    );
    const subject = { resource: 'db:space', record: { id: 's1' } };
    const superadmin = createPermissions();
    superadmin.setSuperadmin(true);
    const granted = createPermissions();
    await granted.setup({ resource: 'db:space', actions: { read: true } });
    for (const permix of [superadmin, granted, createPermissions()])
      expect(() => check(permix, schema, subject, 'read')).toThrow(
        'not a well-formed positive rule',
      );
  });
});
