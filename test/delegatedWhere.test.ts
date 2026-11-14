import { describe, expect, test } from 'bun:test';
import { type Condition, Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createPermissions,
  delegatedWhere,
  type EntitlementEntry,
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

describe('the grant walk refuses a schema rule it cannot judge on a placed record', () => {
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
      'cannot be judged on a placed record',
    );
  });
});
