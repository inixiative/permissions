import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import { type Bridge, Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  createRebacCheck,
  makeKindRules,
  type PermixLike,
  type Row,
  ruleFieldEqualsPath,
  type SchemaMap,
  type SchemaMapWithoutPermissions,
  validateActionRule,
  validateSchema,
} from '../index';
import { actorData, stringColumn } from './schemaMaps';

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

const withoutPermissions: SchemaMapWithoutPermissions = {
  maps: { db },
  supplied: { actor },
  polymorphism: {
    db: { Doc: { axes: [{ field: 'ownerModel', fkMap: { User: ['userId'], Org: ['orgId'] } }] } },
  },
};

const mapOfRead = (read: ActionRule, more: Partial<SchemaMap> = {}): SchemaMap => ({
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
const reads = (map: SchemaMap, record: Row, data?: Record<string, Row[]>) =>
  createRebacCheck(map)(nobody, { resource: 'db:Doc', record, ...(data ? { data } : {}) }, 'read');
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
    const map = mapOfRead(mine);
    expect(reads(map, { ownerId: 'u1' }, actorData('User', { id: 'u1' }))).toBe(true);
    expect(reads(map, { ownerId: 'u2' }, actorData('User', { id: 'u1' }))).toBe(false);
    expect(validateSchema(map).errors).toEqual([]);
  });

  test('a supplied map goes by any name, `app` included', () => {
    const map = mapOfRead(ruleFieldEqualsPath('ownerId', 'app:User.id'), {
      supplied: { app: actor },
    });
    expect(reads(map, { ownerId: 'u1' }, { 'app:User': [{ id: 'u1' }] })).toBe(true);
  });

  test('a map name in both `maps` and `supplied` throws, and validateSchema reports it', () => {
    const map = mapOfRead(mine, { supplied: { db: actor } });
    expect(() => reads(map, {})).toThrow(/`db` is in both `maps` and `supplied`/);
    expect(validateSchema(map).errors.map((issue) => issue.message)).toEqual([
      '`db` is in both `maps` and `supplied`: a map is one or the other',
    ]);
  });

  test('a name with no map is refused: there is no map to default to', () => {
    const map = mapOfRead(true);
    expect(() => createRebacCheck(map)(nobody, { resource: 'Doc', record: {} }, 'read')).toThrow(
      /`Doc` names no map: a resource is `map:Model`/,
    );
    const bare = mapOfRead(true, { permissions: { Doc: { actions: { read: true } } } });
    expect(validateSchema(bare).errors.map((issue) => issue.message)).toContain(
      '`Doc` names no map: a resource is `map:Model`',
    );
  });

  test('a subject whose map has no such model throws: a misspelt name never denies quietly', () => {
    const check = createRebacCheck(mapOfRead(true));
    expect(() => check(nobody, { resource: 'db:Dok', record: {} }, 'read')).toThrow(
      /`db:Dok` is not a model of the map `db`/,
    );
  });

  test('validateSchema reports every name and bridge problem of a map that cannot be indexed', () => {
    const map = mapOfRead(mine, {
      supplied: { db: actor },
      polymorphism: { nope: {} },
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
    expect(() => reads(map, {})).toThrow(/`polymorphism` names the map `nope`/);
    expect(validateSchema(map).errors.map((issue) => issue.message.split(':')[0])).toEqual([
      '`polymorphism` names the map `nope`, which is not in `maps`',
      '`db` is in both `maps` and `supplied`',
      'a bridge between `db',
    ]);
  });

  test('polymorphism names a map in `maps` and a model of it', () => {
    const reading = (polymorphism: SchemaMap['polymorphism']) => () =>
      reads(mapOfRead(true, { polymorphism }), {});
    const axes = [{ field: 'ownerModel', fkMap: { User: ['userId'] } }];
    expect(reading({ zz: { Doc: { axes } } })).toThrow(
      /`polymorphism` names the map `zz`, which is not in `maps`/,
    );
    expect(reading({ Doc: { axes } } as never)).toThrow(
      /`polymorphism` names the map `Doc`, which is not in `maps`/,
    );
    expect(reading({ db: { Dok: { axes } } })).toThrow(
      /`polymorphism` names `db:Dok`, which is not a model of the map `db`/,
    );
  });

  test('every model of a map in `maps` is a resource: a relation to it is followed', () => {
    const map = mapOfRead(valueIs('org.ownerId', 'u1'), { permissions: { 'db:Org': undefined } });
    expect(validateSchema(map).errors).toEqual([]);
    expect(reads(map, { orgId: 'o1', org: { id: 'o1', ownerId: 'u1' } })).toBe(true);
  });

  test('a name whose map has no such model is an error, not a resource with no lens', () => {
    const typo = mapOfRead(true, { permissions: { 'db:Dok': { actions: { read: true } } } });
    expect(validateSchema(typo).errors.map((issue) => issue.message)).toContain(
      '`db:Dok` is not a model of the map `db`',
    );
  });

  test('`db:User` and `actor:User` are two models: a relation leads to the one in its own map', () => {
    const map = mapOfRead(
      { rel: 'user', action: 'read' },
      {
        permissions: { 'db:User': { actions: { read: valueIs('actor:User.id', 'u1') } } },
      },
    );
    const record = { userId: 'x', user: { id: 'x' } };
    expect(reads(map, record, actorData('User', { id: 'u1' }))).toBe(true);
    expect(reads(map, record, actorData('User', { id: 'u2' }))).toBe(false);
  });

  test('kind rules are built from the map before it has rules, a record side and a supplied side', () => {
    const kind = makeKindRules(withoutPermissions);
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
    const map = mapOfRead(
      {
        all: [valueIs('actor:User.sec:Device.risk', 'low'), { rel: 'crm:Account', action: 'own' }],
      },
      {
        supplied: { actor, sec },
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
    const check = createRebacCheck(map);
    const subject = (risk: string) => ({
      resource: 'db:Doc',
      record: { id: 'd1', accountId: 'a1' },
      data: data(risk),
    });
    expect(check(owner, subject('low'), 'read')).toBe(true);
    expect(check(owner, subject('high'), 'read')).toBe(false);
    expect(check(nobody, subject('low'), 'read')).toBe(false);
    expect(validateSchema(map).errors).toEqual([]);
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
    [
      'with no join',
      {
        endpoints: [
          { fieldMap: 'db', model: 'Doc' },
          { fieldMap: 'actor', model: 'User' },
        ],
        cardinality: 'oneToOne',
      },
    ],
  ] as [string, Bridge][])
    test(`a bridge ${what} with one end supplied and one a record is refused: no chain leads from a supplied row into the records`, () => {
      const map = mapOfRead(mine, { bridges: [bridge] });
      const refusal = /a bridge between `\w+:\w+` and `\w+:\w+` has one end supplied/;
      expect(() => reads(map, {})).toThrow(refusal);
      expect(
        validateSchema(map)
          .errors.map((issue) => issue.message)
          .join(),
      ).toMatch(refusal);
    });

  test('a bridge crossed by a rel is joined', () => {
    const map = mapOfRead(true, {
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
      validateSchema(map)
        .errors.map((issue) => issue.message)
        .join(),
    ).toMatch(
      /a bridge between `db:Doc` and `crm:Account` has no join: only a bridge between supplied maps is given its row/,
    );
  });
});

describe('validateActionRule answers what a check refuses, in one call', () => {
  const map = mapOfRead(true, {
    permissions: {
      'db:Doc': { actions: { read: true, write: 'read' } },
      'db:Org': { actions: { read: true } },
    },
  });
  const codes = (rule: unknown, more: object = {}) =>
    validateActionRule(rule, { map, resource: 'db:Doc', action: 'read', ...more }).errors.map(
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
    const at = { map, resource: 'db:Doc' };
    expect(validateActionRule('write', at).errors).toEqual([]);
    expect(validateActionRule(has('noSuchColumn'), at).errors.map((i) => i.code)).toEqual(['lens']);
  });

  test('validateSchema reports a read outside the lens once', () => {
    const bad = mapOfRead(has('noSuchColumn'));
    expect(validateSchema(bad).errors).toHaveLength(1);
  });
});

describe('what a check freezes', () => {
  test('the rules and the bridges, never the field maps', () => {
    const map = mapOfRead(mine, { maps: { db: structuredClone(db) }, bridges: [] });
    reads(map, { ownerId: 'u1' }, actorData('User', { id: 'u1' }));
    expect(Object.isFrozen(map.permissions)).toBe(true);
    expect(Object.isFrozen(map.bridges)).toBe(true);
    expect(Object.isFrozen(map.maps.db)).toBe(false);
    expect(Object.isFrozen(map)).toBe(false);
  });
});
