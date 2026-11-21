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
    actor: actorMap,
    device: { models: { Posture: { fields: { managed: stringColumn, risk: stringColumn } } } },
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

  test("a rule reads a supplied model's own columns, and only the models its map has", () => {
    expect(issues(ruleFieldEqualsPath('ownerId', 'actor:User.nope')).join('\n')).toMatch(
      /own columns only/,
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
    const clash = createRebacCheck({ ...map, supplied: { app: actorMap } });
    expect(() => clash(nobody, schemaOf(mine), { resource: 'doc', record: {} }, 'read')).toThrow(
      /a supplied map is named `app`/,
    );
  });
});
