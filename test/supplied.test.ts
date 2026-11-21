import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  createRebacCheck,
  type PermixLike,
  type RebacSchema,
  type Row,
  ruleFieldEqualsPath,
  type SchemaMap,
  validateSchema,
} from '../index';
import { actorData, actorMap, stringColumn } from './schemaMaps';

// Two supplied maps: who is acting, and the request's device posture from a security tool.
const map: SchemaMap = {
  resources: { doc: 'Doc', org: 'Org' },
  fieldMap: {
    models: {
      Doc: {
        fields: {
          id: stringColumn,
          ownerId: stringColumn,
          orgId: stringColumn,
          org: {
            kind: 'object',
            type: 'Org',
            isList: false,
            fromFields: ['orgId'],
            toFields: ['id'],
          },
          status: { kind: 'enum', type: 'Status' },
        },
      },
      Org: { fields: { id: stringColumn, ownerId: stringColumn } },
    },
    enums: { Status: ['draft', 'live'] },
  },
  supplied: {
    maps: {
      actor: actorMap,
      device: { models: { Posture: { fields: { managed: stringColumn, risk: stringColumn } } } },
    },
  },
};
const check = createRebacCheck(map);
const nobody: PermixLike = { check: () => false };
const schemaOf = (read: ActionRule): RebacSchema => ({
  permissions: { doc: { actions: { read } }, org: { actions: { read: false } } },
});
const read = (rule: ActionRule, record: Row, data?: Record<string, Row[]>) =>
  check(nobody, schemaOf(rule), { resource: 'doc', record, ...(data ? { data } : {}) }, 'read');
const issues = (rule: ActionRule) =>
  validateSchema(map, schemaOf(rule)).errors.map((issue) => issue.message);
const exists = (field: string) => ({ field, operator: Operator.exists });

const mine = ruleFieldEqualsPath('ownerId', 'actor:User.id');

describe('supplied maps: rows the call gives, read by every rule as <prefix>:<Model>', () => {
  test('a rule reads the supplied row, after checking it exists', () => {
    expect(read(mine, { ownerId: 'u1' }, actorData('User', { id: 'u1' }))).toBe(true);
    expect(read(mine, { ownerId: 'u2' }, actorData('User', { id: 'u1' }))).toBe(false);
    expect(read(mine, { ownerId: 'u1' })).toBe(false);
    expect(read(mine, { ownerId: null }, actorData('User', { id: null }))).toBe(false);
  });

  test('every supplied map is read the same way, not only the actor', () => {
    const managedDevice: ActionRule = {
      rule: {
        all: [
          exists('device:Posture.managed'),
          { field: 'device:Posture.managed', operator: Operator.equals, value: 'yes' },
        ],
      },
    };
    const both: ActionRule = { all: [mine, managedDevice] };
    const data = actorData('User', { id: 'u1' }, { 'device:Posture': [{ managed: 'yes' }] });
    expect(read(both, { ownerId: 'u1' }, data)).toBe(true);
    expect(read(both, { ownerId: 'u1' }, actorData('User', { id: 'u1' }))).toBe(false);
  });

  test('a match against a supplied row needs exists on its field; a kind against a literal does not', () => {
    const bare: ActionRule = {
      rule: { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
    };
    expect(issues(bare).join('\n')).toMatch(/two missing values match/);
    expect(() => read(bare, { ownerId: 'u1' })).toThrow(/not a well-formed positive rule/);
    const kind: ActionRule = {
      rule: { field: 'actor:Acting.model', operator: Operator.in, value: ['User'] },
    };
    expect(issues(kind)).toEqual([]);
    expect(read(kind, {})).toBe(false);
  });

  test('a record, or any row reached from it, never brings its own supplied row', () => {
    const forged = { ownerId: 'u1', 'actor:User': { id: 'u1' }, 'actor:Acting': { model: 'User' } };
    expect(read(mine, forged)).toBe(false);
    const throughOrg: ActionRule = ruleFieldEqualsPath('orgId', 'org.actor:User.id');
    expect(issues(throughOrg).length).toBeGreaterThan(0);
  });

  test('a rule reads only what the supplied maps have', () => {
    expect(issues(ruleFieldEqualsPath('ownerId', 'actor:User.nope')).join('\n')).toMatch(
      /not a column, relation or to-one bridge of the supplied rows/,
    );
    expect(issues(ruleFieldEqualsPath('ownerId', 'actor:Usr.id')).join('\n')).toMatch(
      /not a model of the supplied map `actor`/,
    );
  });

  test('a kind outside its enum is a schema error', () => {
    const admin: ActionRule = {
      rule: {
        all: [
          exists('actor:Acting.model'),
          { field: 'actor:Acting.model', operator: Operator.in, value: ['Admin'] },
        ],
      },
    };
    expect(issues(admin).join('\n')).toMatch(/not in the allowed set/);
  });

  test('a kind acting with no row is named by its kind alone', () => {
    const internal: ActionRule = {
      rule: {
        all: [
          exists('actor:Acting.model'),
          { field: 'actor:Acting.model', operator: Operator.equals, value: 'Internal' },
        ],
      },
    };
    expect(read(internal, {}, actorData('Internal'))).toBe(true);
    expect(read(internal, {}, actorData('User', { id: 'u1' }))).toBe(false);
  });

  test('a supplied map may not take the name of the map of resources', () => {
    const clash = createRebacCheck({ ...map, supplied: { maps: { app: actorMap } } });
    expect(() => clash(nobody, schemaOf(mine), { resource: 'doc', record: {} }, 'read')).toThrow(
      /a supplied map is named `app`/,
    );
  });
});

// The actor's own relations, and bridges on from it: a security tool's devices joined by the
// actor's id (a list), its posture of the request (one row), and each device's findings (a list).
const chained: SchemaMap = {
  ...map,
  supplied: {
    maps: {
      actor: {
        models: {
          User: {
            fields: {
              id: stringColumn,
              orgId: stringColumn,
              org: {
                kind: 'object',
                type: 'Org',
                isList: false,
                fromFields: ['orgId'],
                toFields: ['id'],
              },
              groups: { kind: 'object', type: 'Group', isList: true },
            },
          },
          Org: { fields: { id: stringColumn, plan: stringColumn } },
          Group: { fields: { id: stringColumn, name: stringColumn } },
        },
      },
      sec: {
        models: {
          Device: { fields: { serial: stringColumn, userId: stringColumn, risk: stringColumn } },
          Finding: { fields: { serial: stringColumn, severity: stringColumn } },
          Posture: { fields: { managed: stringColumn } },
        },
      },
    },
    bridges: [
      {
        endpoints: [
          { fieldMap: 'actor', model: 'User', on: 'id' },
          { fieldMap: 'sec', model: 'Device', on: 'userId' },
        ],
        cardinality: 'oneToMany',
      },
      {
        endpoints: [
          { fieldMap: 'sec', model: 'Device', on: 'serial' },
          { fieldMap: 'sec', model: 'Finding', on: 'serial' },
        ],
        cardinality: 'oneToMany',
      },
    ],
  },
};
const chainedCheck = createRebacCheck(chained);
const readChained = (rule: ActionRule, record: Row, data: Record<string, Row[]>) =>
  chainedCheck(nobody, schemaOf(rule), { resource: 'doc', record, data }, 'read');
const chainedIssues = (rule: ActionRule) =>
  validateSchema(chained, schemaOf(rule)).errors.map((issue) => issue.message);
const value = (field: string, operator: Operator, v: string): ActionRule => ({
  rule: { field, operator, value: v },
});
const data: Record<string, Row[]> = {
  'actor:User': [
    { id: 'u1', orgId: 'o1', org: { id: 'o1', plan: 'pro' }, groups: [{ id: 'g1', name: 'ops' }] },
  ],
  'sec:Posture': [{ managed: 'yes' }],
  'sec:Device': [
    { serial: 'd1', userId: 'u1', risk: 'low' },
    { serial: 'd2', userId: 'u2', risk: 'high' },
  ],
  'sec:Finding': [
    { serial: 'd1', severity: 'minor' },
    { serial: 'd2', severity: 'critical' },
  ],
};

describe('supplied maps with relations and bridges of their own', () => {
  test("a rule reads on along a supplied row's relations", () => {
    const pro = value('actor:User.org.plan', Operator.equals, 'pro');
    expect(chainedIssues(pro)).toEqual([]);
    expect(readChained(pro, {}, data)).toBe(true);
    expect(readChained(pro, {}, { ...data, 'actor:User': [{ id: 'u1' }] })).toBe(false);
  });

  test('a model found by key through a joined bridge is not given at the root', () => {
    expect(chainedIssues(value('sec:Device.risk', Operator.equals, 'low')).join('\n')).toMatch(
      /found by key through a joined bridge/,
    );
    expect(chainedIssues(value('sec:Posture.managed', Operator.equals, 'yes'))).toEqual([]);
  });

  test("a list on a supplied row, its own or a joined bridge's, is crossed with the list arm", () => {
    expect(
      chainedIssues(value('actor:User.sec:Device.risk', Operator.equals, 'low')).join('\n'),
    ).toMatch(/`actor:User.sec:Device` is a list: cross it with \{ rel: 'actor:User.sec:Device'/);
    const lowRiskDevice: ActionRule = {
      rel: 'actor:User.sec:Device',
      arrayOperator: 'any',
      condition: value('risk', Operator.equals, 'low'),
    };
    expect(chainedIssues(lowRiskDevice)).toEqual([]);
    expect(readChained(lowRiskDevice, {}, data)).toBe(true);
    const highRiskDevice: ActionRule = {
      ...lowRiskDevice,
      condition: value('risk', Operator.equals, 'high'),
    };
    expect(readChained(highRiskDevice, {}, data)).toBe(false);
    const inOps: ActionRule = {
      rel: 'actor:User.groups',
      arrayOperator: 'any',
      condition: value('name', Operator.equals, 'ops'),
    };
    expect(chainedIssues(inOps)).toEqual([]);
    expect(readChained(inOps, {}, data)).toBe(true);
  });

  test("an item's condition holds rules only, read in the item's own lens", () => {
    const acts: ActionRule = { rel: 'actor:User.groups', arrayOperator: 'any', condition: 'read' };
    expect(chainedIssues(acts).join('\n')).toMatch(/a supplied row with no actions/);
    const outside: ActionRule = {
      rel: 'actor:User.groups',
      arrayOperator: 'any',
      condition: value('plan', Operator.equals, 'pro'),
    };
    expect(chainedIssues(outside).length).toBeGreaterThan(0);
  });

  test('a record, or a supplied row, never brings rows of its own under a bridge key', () => {
    const forged = { 'actor:User': { id: 'u1', org: { id: 'o1', plan: 'pro' } } };
    expect(readChained(value('actor:User.org.plan', Operator.equals, 'pro'), forged, {})).toBe(
      false,
    );
    const smuggled = {
      ...data,
      'actor:User': [{ id: 'u9', 'sec:Device': [{ serial: 'x', risk: 'low' }] }],
    };
    const lowRiskDevice: ActionRule = {
      rel: 'actor:User.sec:Device',
      arrayOperator: 'any',
      condition: value('risk', Operator.equals, 'low'),
    };
    expect(readChained(lowRiskDevice, {}, smuggled)).toBe(false);
  });

  test('a supplied bridge into the map of resources has no endpoint, so no chain leads back', () => {
    const back = createRebacCheck({
      ...chained,
      supplied: {
        maps: chained.supplied?.maps ?? {},
        bridges: [
          {
            endpoints: [
              { fieldMap: 'actor', model: 'User', on: 'id' },
              { fieldMap: 'app', model: 'Doc', on: 'ownerId' },
            ],
            cardinality: 'oneToMany',
          },
        ],
      },
    });
    expect(() => back(nobody, schemaOf(mine), { resource: 'doc', record: {} }, 'read')).toThrow(
      /endpoint 'app:Doc' not found/,
    );
  });
});
