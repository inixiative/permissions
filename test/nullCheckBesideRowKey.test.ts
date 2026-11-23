import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import { type Condition, Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  createPermissions,
  type EntitlementEntry,
  entitlementProblem,
  type PermissionEntry,
  pseudoRecordsOfEntitlement,
  type Row,
  type SchemaMap,
  validateSchema,
} from '../index';
import {
  actorData,
  canGrantWithRules,
  checkWithRules,
  mapOf,
  mapWith,
  type Rules,
} from './schemaMaps';

// A null check also holds where the value is missing, so it is accepted only beside an `exists` on
// the key of the row it reads (Aron, 2026-11-22: "`row exists and key is null` is another valid check").

const exists = (field: string) => ({ field, operator: Operator.exists });
const isNull = (field: string) => ({ field, operator: Operator.equals, value: null });
const rowIsThereAnd = (key: string, ...rules: Condition[]): ActionRule => ({
  rule: { all: [exists(key), ...rules] },
});

const map = mapOf(
  {
    'db:doc': { organization: 'db:organization' },
    'db:participant': { conversation: 'db:conversation' },
  },
  {
    'db:organization': ['deletedAt'],
    'db:doc': ['source'],
    'db:conversation': [],
    'db:participant': ['leftAt', 'userId'],
  },
  { 'db:conversation': { participants: { item: 'db:participant', down: [] } } },
);

const unlocked = {
  any: [isNull('source'), { field: 'source', operator: Operator.in, value: ['open'] }],
};
const actionsOf = (docRead: ActionRule, docManage: ActionRule): Rules => ({
  permissions: {
    'db:organization': { actions: { manage: null, read: 'manage' } },
    'db:doc': { actions: { manage: docManage, read: docRead } },
    'db:conversation': {
      actions: {
        chat: {
          rel: 'participants',
          arrayOperator: 'any',
          condition: {
            rule: {
              all: [
                exists('id'),
                isNull('leftAt'),
                exists('userId'),
                { field: 'userId', operator: Operator.equals, path: 'actor:User.id' },
              ],
            },
          },
        },
      },
    },
    'db:participant': { actions: {} },
  },
});
const schema = actionsOf(false, {
  all: [rowIsThereAnd('id', unlocked), { rel: 'organization', action: 'manage' }],
});

const rebac = checkWithRules(map);
const canGrantEntitlement = canGrantWithRules(map);
const check = (
  permix: Awaited<ReturnType<typeof holding>>,
  rules: Rules,
  resource: string,
  record: Row,
  action: string,
  data: Record<string, Row[]> = actorData('User', { id: 'u1' }),
) => rebac(permix, rules, { resource, record, data }, action);

const holding = async (entries: PermissionEntry[]) => {
  const permix = createPermissions();
  await permix.setup(entries);
  return permix;
};
const manager = () =>
  holding([{ resource: 'db:organization', id: 'o1', actions: { manage: true } }]);
const nobody = () => holding([]);

const o1 = { id: 'o1', deletedAt: null };
const doc = (fields: Row): Row => ({ id: 'd1', organizationId: 'o1', organization: o1, ...fields });

describe('a null check beside its row key', () => {
  test('a bare null check is refused in a schema rule', () => {
    const bare = actionsOf(false, {
      all: [{ rule: unlocked }, { rel: 'organization', action: 'manage' }],
    });
    expect(validateSchema(mapWith(map, bare)).ok).toBe(false);
    expect(validateSchema(mapWith(map, schema)).ok).toBe(true);
  });

  test('it holds on a row that is there with the column empty, and on no other', async () => {
    const writer = await manager();
    expect(check(writer, schema, 'db:doc', doc({ source: null }), 'manage')).toBe(true);
    expect(check(writer, schema, 'db:doc', doc({ source: 'open' }), 'manage')).toBe(true);
    expect(check(writer, schema, 'db:doc', doc({ source: 'locked' }), 'manage')).toBe(false);
  });

  test('a writer cannot grant over records it cannot be shown to hold: the stand-in has no key', async () => {
    const writer = await manager();
    const overTheOrganization = (where?: EntitlementEntry['where']): EntitlementEntry => ({
      resource: 'db:doc',
      anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
      actions: { manage: true },
      ...(where ? { where } : {}),
    });
    const granted = (entry: EntitlementEntry) =>
      (pseudoRecordsOfEntitlement(map, entry, o1) ?? [{}]).every((placed) =>
        canGrantEntitlement(writer, schema, entry, placed),
      );
    expect(granted(overTheOrganization())).toBe(false);
    expect(granted(overTheOrganization(isNull('source') as never))).toBe(false);
    expect(granted(overTheOrganization({ all: [exists('id'), isNull('source')] } as never))).toBe(
      false,
    );
    const pinsTheKey = overTheOrganization({ field: 'id', operator: Operator.equals, value: 'x' });
    expect(pseudoRecordsOfEntitlement(map, pinsTheKey, o1)).toEqual([
      { organizationId: 'o1', organization: o1 },
    ]);
    expect(granted(pinsTheKey)).toBe(false);
    const oneDoc: EntitlementEntry = {
      resource: 'db:doc',
      anchor: { resource: 'db:doc', id: 'd1' },
      actions: { manage: true },
    };
    expect(canGrantEntitlement(writer, schema, oneDoc, doc({ source: null }))).toBe(true);
    expect(canGrantEntitlement(writer, schema, oneDoc, doc({ source: 'locked' }))).toBe(false);
  });

  test('a stand-in never carries the key, even where a foreign key is the key', async () => {
    const plain = mapOf({}, { 'db:profile': ['source'], 'db:organization': [] });
    const keyedByItsOrganization = {
      kind: 'object',
      type: 'organization',
      isList: false,
      fromFields: ['id'],
      toFields: ['id'],
    } as const;
    const db = plain.maps.db as FieldMap;
    const profiles: SchemaMap = {
      ...plain,
      maps: {
        db: {
          ...db,
          models: {
            ...db.models,
            profile: {
              fields: {
                ...db.models.profile?.fields,
                organization: keyedByItsOrganization,
              },
            },
          },
        },
      },
    };
    const rules: Rules = {
      permissions: {
        'db:organization': { actions: { manage: null } },
        'db:profile': {
          actions: {
            manage: {
              all: [
                rowIsThereAnd('id', isNull('source')),
                { rel: 'organization', action: 'manage' },
              ],
            },
          },
        },
      },
    };
    const entry: EntitlementEntry = {
      resource: 'db:profile',
      anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
      actions: { manage: true },
    };
    const placed = pseudoRecordsOfEntitlement(profiles, entry, o1) ?? [];
    expect(placed.length).toBe(1);
    for (const record of placed) expect(record).not.toHaveProperty('id');
    const writer = await manager();
    expect(
      placed.every((record) => canGrantWithRules(profiles)(writer, rules, entry, record)),
    ).toBe(false);
  });

  test('on a supplied row: a row that is not given never passes', async () => {
    const rootKey = actionsOf(rowIsThereAnd('actor:Token.id', isNull('actor:Token.userId')), false);
    expect(validateSchema(mapWith(map, rootKey)).ok).toBe(true);
    const anyone = await nobody();
    const read = (data: Record<string, Row[]>) =>
      check(anyone, rootKey, 'db:doc', doc({}), 'read', data);
    expect(read(actorData('Token', { id: 't1', userId: null }))).toBe(true);
    expect(read(actorData('Token', { id: 't1', userId: 'u1' }))).toBe(false);
    expect(read(actorData('User', { id: 'u1' }))).toBe(false);
    expect(read({})).toBe(false);
    const keyOfAnotherRow = actionsOf(rowIsThereAnd('id', isNull('actor:Token.userId')), false);
    expect(validateSchema(mapWith(map, keyOfAnotherRow)).ok).toBe(false);
  });

  test('through a relation: a row that is not loaded never passes', async () => {
    const live = actionsOf(
      rowIsThereAnd('organization.id', isNull('organization.deletedAt')),
      false,
    );
    expect(validateSchema(mapWith(map, live)).ok).toBe(true);
    const anyone = await nobody();
    const read = (record: Row) => check(anyone, live, 'db:doc', record, 'read');
    expect(read(doc({}))).toBe(true);
    expect(read({ id: 'd1', organizationId: 'o1' })).toBe(false);
    expect(read({ id: 'd1', organizationId: null, organization: null })).toBe(false);
    expect(read(doc({ organization: { id: 'o1', deletedAt: '2026-01-01' } }))).toBe(false);
  });

  test('in a list arm: on the item, beside the item key', async () => {
    const anyone = await nobody();
    const chat = (participants: Row[]) =>
      check(anyone, schema, 'db:conversation', { id: 'c1', participants }, 'chat');
    expect(chat([{ id: 'p1', userId: 'u1', leftAt: null }])).toBe(true);
    expect(chat([{ id: 'p1', userId: 'u1', leftAt: '2026-01-01' }])).toBe(false);
    expect(chat([{ userId: 'u1' }])).toBe(false);
    expect(chat([{ id: 'p2', userId: 'u2', leftAt: null }])).toBe(false);
  });

  test('an entitlement where and a stored rule are judged by the same gate', async () => {
    const entry = (where: EntitlementEntry['where']): EntitlementEntry => ({
      resource: 'db:doc',
      anchor: { resource: 'db:organization', id: 'o1', path: 'organization' },
      actions: { read: true },
      where,
    });
    expect(entitlementProblem(entry(isNull('source') as never))).toMatch(/nullCheck|row's `id`/);
    expect(
      entitlementProblem(entry({ all: [exists('id'), isNull('source')] } as never)),
    ).toBeNull();
    const anyone = await nobody();
    const stored = (rule: ActionRule) => doc({ source: null, permissionRules: { read: rule } });
    expect(() =>
      check(anyone, schema, 'db:doc', stored({ rule: isNull('source') }), 'read'),
    ).toThrow();
    expect(
      check(anyone, schema, 'db:doc', stored(rowIsThereAnd('id', isNull('source'))), 'read'),
    ).toBe(true);
  });

  test('every other shape the gate refuses stays refused beside the key', () => {
    for (const refused of [
      { field: 'source', operator: Operator.notExists },
      { field: 'source', operator: Operator.isEmpty },
      { field: 'source', operator: Operator.notEquals, value: 'locked' },
      { field: 'source', operator: Operator.notIn, value: ['locked'] },
    ])
      expect(validateSchema(mapWith(map, actionsOf(rowIsThereAnd('id', refused), false))).ok).toBe(
        false,
      );
  });
});
