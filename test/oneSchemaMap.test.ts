import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import { type Bridge, Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  makeKindRules,
  makeRebacCheck,
  type PermixLike,
  type Row,
  ruleFieldEqualsPath,
  type SchemaMap,
  validateActionRule,
  validateSchemaMap,
} from '../index';
import {
  actorData,
  declaringSuppliedBridges,
  type SchemaMapWithSuppliedGroup,
  stringColumn,
} from './schemaMaps';

const toOne = (type: string, key: string) =>
  ({ kind: 'object', type, isList: false, fromFields: [key], toFields: ['id'] }) as const;

const db: FieldMap = {
  models: {
    Doc: {
      fields: {
        id: stringColumn,
        ownerId: stringColumn,
        accountId: stringColumn,
        orgId: stringColumn,
        org: toOne('Org', 'orgId'),
        ownerModel: { kind: 'enum', type: 'OwnerModel', isList: false },
        userId: stringColumn,
        user: toOne('User', 'userId'),
      },
    },
    Org: { fields: { id: stringColumn, ownerId: stringColumn } },
    User: { fields: { id: stringColumn } },
  },
  enums: { OwnerModel: ['User', 'Org'] },
};

const actor: FieldMap = {
  models: {
    Acting: { fields: { model: { kind: 'enum', type: 'ActingKind', isList: false } } },
    User: { fields: { id: stringColumn, deviceSerial: stringColumn } },
    Token: {
      fields: { id: stringColumn, ownerModel: { kind: 'enum', type: 'OwnerModel', isList: false } },
    },
  },
  enums: { ActingKind: ['User', 'Token'], OwnerModel: ['User', 'Org'] },
};

const sec: FieldMap = {
  models: { Device: { fields: { serial: stringColumn, risk: stringColumn } } },
};

const withoutPermissions: Omit<SchemaMapWithSuppliedGroup, 'permissions'> = {
  fieldMaps: { db },
  suppliedFieldMaps: { actor },
  polymorphismRegistries: {
    db: { Doc: { axes: [{ field: 'ownerModel', fkMap: { User: ['userId'], Org: ['orgId'] } }] } },
  },
};

const mapOfRead = (read: ActionRule, more: Partial<SchemaMapWithSuppliedGroup> = {}): SchemaMap =>
  declaringSuppliedBridges({
    ...withoutPermissions,
    ...more,
    permissions: {
      'db:Doc': { actions: { read } },
      'db:Org': { actions: { read: false } },
      'db:User': { actions: { read: false } },
      ...more.permissions,
    },
  });

const nobody: PermixLike = { check: () => false };
const reads = (schemaMap: SchemaMap, record: Row, data?: Record<string, Row[]>) =>
  makeRebacCheck(schemaMap)(
    nobody,
    { resource: 'db:Doc', record, ...(data ? { bridgeData: data } : {}) },
    'read',
  );
const mine = ruleFieldEqualsPath('ownerId', 'actor:User.id');
const has = (field: string): ActionRule => ({ rule: { field, operator: Operator.exists } });
const valueIs = (field: string, value: string): ActionRule => ({
  rule: {
    all: [
      { field, operator: Operator.exists },
      { field, operator: Operator.equals, value },
    ],
  },
});

describe('one schema map: maps, supplied, bridges, polymorphism, permissions', () => {
  test('a check takes the one map: the rules, the records and the supplied rows are in it', () => {
    const schemaMap = mapOfRead(mine);
    expect(reads(schemaMap, { ownerId: 'u1' }, actorData('User', { id: 'u1' }))).toBe(true);
    expect(reads(schemaMap, { ownerId: 'u2' }, actorData('User', { id: 'u1' }))).toBe(false);
    expect(validateSchemaMap(schemaMap).errors).toEqual([]);
  });

  test('a supplied map goes by any name, `app` included', () => {
    const schemaMap = mapOfRead(ruleFieldEqualsPath('ownerId', 'app:User.id'), {
      suppliedFieldMaps: { app: actor },
    });
    expect(reads(schemaMap, { ownerId: 'u1' }, { 'app:User': [{ id: 'u1' }] })).toBe(true);
  });

  test('a supplied bridge that ends in a map of records throws, and validateSchemaMap reports it', () => {
    const schemaMap = mapOfRead(mine, {
      bridges: [
        {
          endpoints: [
            { fieldMap: 'db', model: 'Doc' },
            { fieldMap: 'db', model: 'User' },
          ],
          cardinality: 'oneToOne',
        },
      ],
    });
    const refusal = /has no join, so its far end is supplied, but `db` holds records/;
    expect(() => reads(schemaMap, {})).toThrow(refusal);
    expect(
      validateSchemaMap(schemaMap)
        .errors.map((issue) => issue.message)
        .join(),
    ).toMatch(refusal);
  });

  test('a name with no map is refused: there is no map to default to', () => {
    const schemaMap = mapOfRead(true);
    expect(() =>
      makeRebacCheck(schemaMap)(nobody, { resource: 'Doc', record: {} }, 'read'),
    ).toThrow(/`Doc` names no map: a resource is `map:Model`/);
    const bare = mapOfRead(true, { permissions: { Doc: { actions: { read: true } } } });
    expect(validateSchemaMap(bare).errors.map((issue) => issue.message)).toContain(
      '`Doc` names no map: a resource is `map:Model`',
    );
  });

  test('a subject whose map has no such model throws: a misspelt name never denies quietly', () => {
    const check = makeRebacCheck(mapOfRead(true));
    expect(() => check(nobody, { resource: 'db:Dok', record: {} }, 'read')).toThrow(
      /`db:Dok` is not a model of the map `db`/,
    );
  });

  test('validateSchemaMap reports every name and bridge problem of a map that cannot be indexed', () => {
    const schemaMap = mapOfRead(mine, {
      fieldMaps: { db, 'bad:name': db },
      polymorphismRegistries: { nope: {} },
      bridges: [
        {
          endpoints: [
            { fieldMap: 'db', model: 'Doc' },
            { fieldMap: 'crm', model: 'Account' },
          ],
          cardinality: 'oneToOne',
        },
      ],
    });
    expect(() => reads(schemaMap, {})).toThrow(/a map is named `bad:name`/);
    const messages = validateSchemaMap(schemaMap).errors.map((issue) => issue.message);
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatch(/^a map is named `bad:name`/);
    expect(messages[1]).toMatch(
      /^`polymorphismRegistries` names the map `nope`, which is not a field map of records/,
    );
    expect(messages[2]).toMatch(
      /^a bridge between `db:Doc` and `crm:Account` ends in the map `crm`, which is not in `fieldMaps`/,
    );
    expect(validateSchemaMap(schemaMap).errors.map((issue) => issue.path)).toEqual(['$', '$', '$']);
  });

  test('polymorphism names a map in `fieldMaps` and a model of it', () => {
    const reading = (polymorphismRegistries: SchemaMap['polymorphismRegistries']) => () =>
      reads(mapOfRead(true, { polymorphismRegistries }), {});
    const axes = [{ field: 'ownerModel', fkMap: { User: ['userId'] } }];
    expect(reading({ zz: { Doc: { axes } } })).toThrow(
      /`polymorphismRegistries` names the map `zz`, which is not a field map of records/,
    );
    expect(reading({ Doc: { axes } } as never)).toThrow(
      /`polymorphismRegistries` names the map `Doc`, which is not a field map of records/,
    );
    expect(reading({ db: { Dok: { axes } } })).toThrow(
      /`polymorphismRegistries` names `db:Dok`, which is not a model of the map `db`/,
    );
  });

  test('every model of a map in `fieldMaps` is a resource: a relation to it is followed', () => {
    const schemaMap = mapOfRead(valueIs('org.ownerId', 'u1'), {
      permissions: { 'db:Org': undefined },
    });
    expect(validateSchemaMap(schemaMap).errors).toEqual([]);
    expect(reads(schemaMap, { orgId: 'o1', org: { id: 'o1', ownerId: 'u1' } })).toBe(true);
  });

  test('a name whose map has no such model is an error, not a resource with no lens', () => {
    const typo = mapOfRead(true, { permissions: { 'db:Dok': { actions: { read: true } } } });
    expect(validateSchemaMap(typo).errors.map((issue) => issue.message)).toContain(
      '`db:Dok` is not a model of the map `db`',
    );
  });

  test('`db:User` and `actor:User` are two models: a relation leads to the one in its own map', () => {
    const schemaMap = mapOfRead(
      { rel: 'user', action: 'read' },
      {
        permissions: { 'db:User': { actions: { read: valueIs('actor:User.id', 'u1') } } },
      },
    );
    const record = { userId: 'x', user: { id: 'x' } };
    expect(reads(schemaMap, record, actorData('User', { id: 'u1' }))).toBe(true);
    expect(reads(schemaMap, record, actorData('User', { id: 'u2' }))).toBe(false);
  });

  test('kind rules are built from the map before it has rules, a record side and a supplied side', () => {
    const kind = makeKindRules(
      declaringSuppliedBridges({ ...withoutPermissions, permissions: {} }),
    );
    expect(kind.ruleKindIsOneOf('db:Doc', 'ownerModel', ['Org'])).toEqual({
      rule: { field: 'ownerModel', operator: Operator.equals, value: 'Org' },
    });
    expect(kind.ruleKindIsOneOf('actor:Token', 'ownerModel', ['User'])).toEqual({
      rule: { field: 'actor:Token.ownerModel', operator: Operator.equals, value: 'User' },
    });
    expect(kind.ruleActionThroughEachKind('db:Doc', 'ownerModel', 'read')).toEqual({
      any: [
        {
          all: [
            { rule: { field: 'ownerModel', operator: Operator.equals, value: 'User' } },
            { rel: 'user', action: 'read' },
          ],
        },
        {
          all: [
            { rule: { field: 'ownerModel', operator: Operator.equals, value: 'Org' } },
            { rel: 'org', action: 'read' },
          ],
        },
      ],
    });
  });
});

describe('one list of bridges', () => {
  const deviceOfActor: Bridge = {
    endpoints: [
      { fieldMap: 'actor', model: 'User', on: 'deviceSerial' },
      { fieldMap: 'sec', model: 'Device', on: 'serial' },
    ],
    cardinality: 'oneToOne',
  };
  const accountOfDoc: Bridge = {
    endpoints: [
      { fieldMap: 'crm', model: 'Account', on: 'id' },
      { fieldMap: 'db', model: 'Doc', on: 'accountId' },
    ],
    cardinality: 'oneToMany',
  };

  test('a bridge between supplied maps is read by a rule; one from a record is crossed by a rel', () => {
    const schemaMap = mapOfRead(
      {
        all: [valueIs('actor:User.sec:Device.risk', 'low'), { rel: 'crm:Account', action: 'own' }],
      },
      {
        suppliedFieldMaps: { actor, sec },
        bridges: [deviceOfActor, accountOfDoc],
        permissions: { 'crm:Account': { actions: { own: null } } },
      },
    );
    const owner: PermixLike = {
      check: (resource, action, id) =>
        resource === 'crm:Account' && action === 'own' && id === 'a1',
    };
    const data = (risk: string) => ({
      'actor:User': [{ id: 'u1', deviceSerial: 's1' }],
      'sec:Device': [{ serial: 's1', risk }],
      'crm:Account': [{ id: 'a1' }],
    });
    const check = makeRebacCheck(schemaMap);
    const subject = (risk: string) => ({
      resource: 'db:Doc',
      record: { id: 'd1', accountId: 'a1' },
      bridgeData: data(risk),
    });
    expect(check(owner, subject('low'), 'read')).toBe(true);
    expect(check(owner, subject('high'), 'read')).toBe(false);
    expect(check(nobody, subject('low'), 'read')).toBe(false);
    expect(validateSchemaMap(schemaMap).errors).toEqual([]);
  });

  for (const [what, bridge] of [
    [
      'joined',
      {
        endpoints: [
          { fieldMap: 'actor', model: 'User', on: 'id' },
          { fieldMap: 'db', model: 'Doc', on: 'ownerId' },
        ],
        cardinality: 'oneToMany',
      },
    ],
  ] as [string, Bridge][])
    test(`a bridge ${what} with one end supplied and one a record is refused: no chain leads from a supplied row into the records`, () => {
      const schemaMap = mapOfRead(mine, { bridges: [bridge] });
      const refusal = /a bridge between `\w+:\w+` and `\w+:\w+` has one end supplied/;
      expect(() => reads(schemaMap, {})).toThrow(refusal);
      expect(
        validateSchemaMap(schemaMap)
          .errors.map((issue) => issue.message)
          .join(),
      ).toMatch(refusal);
    });

  test('a bridge with no join is a supplied bridge: its far end has a field map', () => {
    const schemaMap = mapOfRead(true, {
      bridges: [
        {
          endpoints: [
            { fieldMap: 'db', model: 'Doc' },
            { fieldMap: 'crm', model: 'Account' },
          ],
          cardinality: 'oneToOne',
        },
      ],
    });
    expect(
      validateSchemaMap(schemaMap)
        .errors.map((issue) => issue.message)
        .join(),
    ).toMatch(
      /a bridge between `db:Doc` and `crm:Account` ends in the map `crm`, which is not in `fieldMaps`/,
    );
  });
});

describe('validateActionRule answers what a check refuses, in one call', () => {
  const schemaMap = mapOfRead(true, {
    permissions: {
      'db:Doc': { actions: { read: true, write: 'read' } },
      'db:Org': { actions: { read: true } },
    },
  });
  const codes = (rule: unknown, more: object = {}) =>
    validateActionRule(rule, { schemaMap, resource: 'db:Doc', action: 'read', ...more }).errors.map(
      (issue) => issue.code,
    );

  test('a good rule passes', () => {
    expect(codes({ all: [mine, { rel: 'org', action: 'read' }] })).toEqual([]);
  });

  test('a column the record does not have', () => {
    expect(codes(has('noSuchColumn'))).toEqual(['lens']);
  });

  test('a relation the record does not have', () => {
    expect(codes({ rel: 'noSuchRelation', action: 'read' })).toEqual(['relation']);
  });

  test('a negation', () => {
    expect(codes({ rule: { field: 'ownerId', operator: Operator.notEquals, value: 'x' } })).toEqual(
      ['notPositive'],
    );
  });

  test('a cycle, through the map, the row rules and the additional rules', () => {
    expect(codes('write')).toEqual(['cycle']);
    expect(codes('edit', { rowRules: { edit: 'read' } })).toEqual(['cycle']);
    expect(codes('edit', { additionalRules: [{ edit: 'read' }] })).toEqual(['cycle']);
  });

  test('a cycle and a missing column are both reported', () => {
    expect(codes({ any: ['write', has('noSuchColumn')] })).toEqual(['cycle', 'lens']);
  });

  test('what a check tolerates is not reported: an action that does not exist denies', () => {
    expect(codes({ rel: 'org', action: 'noSuchAction' })).toEqual([]);
    expect(codes('noSuchAction')).toEqual([]);
  });

  test('with no action there is no cycle to find; reads are still judged', () => {
    const at = { schemaMap, resource: 'db:Doc' };
    expect(validateActionRule('write', at).errors).toEqual([]);
    expect(validateActionRule(has('noSuchColumn'), at).errors.map((i) => i.code)).toEqual(['lens']);
  });

  test('validateSchemaMap reports a read outside the lens once', () => {
    const bad = mapOfRead(has('noSuchColumn'));
    expect(validateSchemaMap(bad).errors).toHaveLength(1);
  });
});

describe('what a check freezes', () => {
  test('the rules and the bridges, never the field maps', () => {
    const schemaMap = mapOfRead(mine, { fieldMaps: { db: structuredClone(db) }, bridges: [] });
    reads(schemaMap, { ownerId: 'u1' }, actorData('User', { id: 'u1' }));
    expect(Object.isFrozen(schemaMap.permissions)).toBe(true);
    expect(Object.isFrozen(schemaMap.bridges)).toBe(true);
    expect(Object.isFrozen(schemaMap.fieldMaps.db)).toBe(false);
    expect(Object.isFrozen(schemaMap)).toBe(false);
  });
});
