import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  type Actor,
  createRebacCheck,
  type PermixLike,
  type RebacSchema,
  recordWithActor,
  type SchemaMap,
  validateSchema,
} from '../index';
import { actorModels, stringColumn } from './schemaMaps';

const map: SchemaMap = {
  resources: { doc: 'Doc' },
  fieldMap: {
    models: {
      Doc: {
        fields: {
          id: stringColumn,
          ownerId: stringColumn,
          status: { kind: 'enum', type: 'Status' },
        },
      },
      ...actorModels,
    },
    enums: { Status: ['draft', 'live'] },
  },
  actors: {
    models: ['User', 'Token'],
    session: { fields: { impersonatedBy: stringColumn } },
  },
};
const check = createRebacCheck(map);
const as = (actor: Actor | null): PermixLike => ({ check: () => false, getActor: () => actor });
const user: Actor = { model: 'User', record: { id: 'u1' } };
const token: Actor = { model: 'Token', record: { id: 't1', userId: 'u1', ownerModel: 'User' } };
const schemaOf = (read: ActionRule): RebacSchema => ({
  permissions: { doc: { actions: { read } } },
});
const read = (rule: ActionRule, actor: Actor | null, record: Record<string, unknown>) =>
  check(as(actor), schemaOf(rule), { resource: 'doc', record }, 'read');
const issues = (rule: ActionRule) =>
  validateSchema(map, schemaOf(rule)).errors.map((issue) => issue.message);

describe('the actor: actor:<Model> over a supplied bridge', () => {
  test('a rule says the actor is there, then matches it', () => {
    const mine = {
      rule: {
        all: [
          { field: 'actor:User.id', operator: Operator.exists },
          { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
        ],
      },
    };
    expect(read(mine, user, { ownerId: 'u1' })).toBe(true);
    expect(read(mine, user, { ownerId: 'u2' })).toBe(false);
    expect(read(mine, token, { ownerId: null })).toBe(false);
    expect(read(mine, null, { ownerId: null })).toBe(false);
  });

  test('the engine floor: an actor not acting is unknown, even in an unguarded comparison', () => {
    const bare = { rule: { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' } };
    expect(read(bare, token, { ownerId: null })).toBe(false);
    expect(read(bare, null, { ownerId: null })).toBe(false);
  });

  test('a rule reads the acting row', () => {
    const delegateOfUser = {
      rule: { field: 'actor:Token.ownerModel', operator: Operator.equals, value: 'User' },
    };
    expect(read(delegateOfUser, token, {})).toBe(true);
    expect(read(delegateOfUser, user, {})).toBe(false);
  });

  test('a record can never carry an actor of its own', () => {
    const userOnly = { rule: { field: 'actor:User.id', operator: Operator.exists } };
    expect(read(userOnly, token, { 'actor:User': { id: 'forged' } })).toBe(false);
    expect(read(userOnly, null, { 'actor:User': { id: 'forged' } })).toBe(false);
    expect(recordWithActor(map, { 'actor:Token': { id: 'x' } }, user)).toEqual({
      'actor:User': { id: 'u1' },
      'actor:Token': undefined,
      'actor:Session': undefined,
    });
  });

  test('a map that declares no actors still drops an actor a record brought', () => {
    const { actors: _none, ...noActors } = map;
    expect(recordWithActor(noActors, { id: 'd', 'actor:User': { id: 'forged' } }, user)).toEqual({
      id: 'd',
    });
  });

  test('the session is its own supplied row', () => {
    const impersonated = {
      rule: { field: 'actor:Session.impersonatedBy', operator: Operator.exists },
    };
    expect(read(impersonated, { ...user, session: { impersonatedBy: 'admin' } }, {})).toBe(true);
    expect(read(impersonated, user, {})).toBe(false);
  });

  test("a rule reads the actor's own columns only, at the row it is read on", () => {
    expect(issues({ rule: { field: 'actor:User.id', operator: Operator.exists } })).toEqual([]);
    expect(issues({ rule: { field: 'actor:Usr.id', operator: Operator.exists } })[0]).toMatch(
      /not an actor the map declares/,
    );
    expect(issues({ rule: { field: 'actor:User.nope', operator: Operator.exists } })[0]).toMatch(
      /own columns only/,
    );
    expect(
      issues({ rule: { field: '__actor.model', operator: Operator.equals, value: 'User' } }),
    ).not.toEqual([]);
  });

  test('an acting model the map does not declare throws', () => {
    expect(() =>
      read(
        { rule: { field: 'actor:User.id', operator: Operator.exists } },
        { model: 'Robot', record: {} },
        {},
      ),
    ).toThrow('does not declare it');
  });

  test('an enum value the enum does not hold is a schema error', () => {
    expect(
      issues({ rule: { field: 'status', operator: Operator.equals, value: 'drafty' } }),
    ).not.toEqual([]);
    expect(
      issues({ rule: { field: 'status', operator: Operator.equals, value: 'draft' } }),
    ).toEqual([]);
  });
});
