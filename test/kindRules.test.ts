import { describe, expect, test } from 'bun:test';
import {
  type ActionRule,
  type Actor,
  createRebacCheck,
  makeKindRules,
  type PermixLike,
  type RebacSchema,
  type SchemaMap,
  validateSchema,
} from '../index';
import { stringColumn } from './schemaMaps';

const toOne = (type: string, key: string) =>
  ({ kind: 'object', type, isList: false, fromFields: [key], toFields: ['id'] }) as const;

// A token owned by an organization, a space (with its organization), a user, or no one (`default`).
const map: SchemaMap = {
  resources: {
    'db:token': 'Token',
    'db:organization': 'Organization',
    'db:space': 'Space',
    'db:user': 'User',
  },
  fieldMap: {
    models: {
      Token: {
        fields: {
          id: stringColumn,
          ownerModel: { kind: 'enum', type: 'TokenOwner' },
          organizationId: stringColumn,
          organization: toOne('Organization', 'organizationId'),
          spaceId: stringColumn,
          space: toOne('Space', 'spaceId'),
          userId: stringColumn,
          user: toOne('User', 'userId'),
        },
      },
      Organization: { fields: { id: stringColumn } },
      Space: { fields: { id: stringColumn } },
      User: { fields: { id: stringColumn } },
    },
    enums: { TokenOwner: ['Organization', 'Space', 'User', 'default'] },
  },
  polymorphism: {
    Token: {
      axes: [
        {
          field: 'ownerModel',
          fkMap: {
            Organization: ['organizationId'],
            Space: ['organizationId', 'spaceId'],
            User: ['userId'],
            default: [],
          },
        },
      ],
    },
  },
  actors: { models: ['User'], pseudo: ['Internal'] },
};
const kind = makeKindRules(map);
const check = createRebacCheck(map);
const as = (actor: Actor | null): PermixLike => ({
  check: (resource, action) => resource === 'db:organization' && action === 'manage',
  getActor: () => actor,
});
const user: Actor = { model: 'User', record: { id: 'u1' } };
const schemaOf = (manage: ActionRule): RebacSchema => ({
  permissions: {
    'db:token': { actions: { manage } },
    'db:organization': { actions: { manage: false } },
    'db:space': { actions: { manage: false } },
    'db:user': { actions: { manage: false } },
  },
});
const manage = (rule: ActionRule, actor: Actor | null, record: Record<string, unknown>) =>
  check(as(actor), schemaOf(rule), { resource: 'db:token', record }, 'manage');

describe('the fan-out: each branch checks its own kind first', () => {
  const rule = kind.ruleForEachKind('db:token', 'ownerModel', {
    Organization: { rel: 'organization', action: 'manage' },
    User: kind.ruleActorIdMatches('userId', 'User'),
    default: true,
  });

  test('builds one positive branch per kind given', () => {
    expect(rule).toEqual({
      any: [
        {
          all: [
            { rule: { field: 'ownerModel', operator: 'equals', value: 'Organization' } },
            { rel: 'organization', action: 'manage' },
          ],
        },
        {
          all: [
            { rule: { field: 'ownerModel', operator: 'equals', value: 'User' } },
            {
              all: [
                { rule: { field: 'actor:Acting.model', operator: 'equals', value: 'User' } },
                { rule: { field: 'actor:User.id', operator: 'exists' } },
                { rule: { field: 'userId', operator: 'equals', path: 'actor:User.id' } },
              ],
            },
          ],
        },
        { rule: { field: 'ownerModel', operator: 'equals', value: 'default' } },
      ],
    });
    expect(validateSchema(map, schemaOf(rule)).errors).toEqual([]);
  });

  test("a branch holds only on its own kind: a space-owned row never takes the organization's branch", () => {
    const org = { id: 'o1' };
    expect(
      manage(rule, user, { ownerModel: 'Organization', organizationId: 'o1', organization: org }),
    ).toBe(true);
    expect(
      manage(rule, user, {
        ownerModel: 'Space',
        organizationId: 'o1',
        organization: org,
        spaceId: 's1',
        space: { id: 's1' },
      }),
    ).toBe(false);
    expect(manage(rule, user, { ownerModel: 'User', userId: 'u1', user: { id: 'u1' } })).toBe(true);
    expect(manage(rule, user, { ownerModel: 'User', userId: null })).toBe(false);
    expect(manage(rule, null, { ownerModel: 'User', userId: 'u1', user: { id: 'u1' } })).toBe(
      false,
    );
    expect(manage(rule, null, { ownerModel: 'default' })).toBe(true);
  });

  test('the same action through each kind, from the registry: a kind with no relation is left out', () => {
    expect(
      kind.ruleActionThroughEachKind('db:token', 'ownerModel', 'manage', [
        'Organization',
        'default',
      ]),
    ).toEqual({
      any: [
        {
          all: [
            { rule: { field: 'ownerModel', operator: 'equals', value: 'Organization' } },
            { rel: 'organization', action: 'manage' },
          ],
        },
      ],
    });
  });

  test('kind membership, on a side and on the actor', () => {
    expect(kind.ruleKindIsOneOf('db:token', 'ownerModel', ['Organization', 'Space'])).toEqual({
      rule: { field: 'ownerModel', operator: 'in', value: ['Organization', 'Space'] },
    });
    const userOrInternal = kind.ruleActorKindIsOneOf(['User', 'Internal']);
    expect(manage(userOrInternal, user, {})).toBe(true);
    expect(manage(userOrInternal, { model: 'Internal' }, {})).toBe(true);
    expect(manage(userOrInternal, null, {})).toBe(false);
    const actorFan = kind.ruleForEachActorKind({
      Internal: true,
      User: kind.ruleActorIdMatches('userId', 'User'),
    });
    expect(manage(actorFan, { model: 'Internal' }, {})).toBe(true);
    expect(manage(actorFan, user, { userId: 'u1' })).toBe(true);
    expect(manage(actorFan, user, { userId: 'u2' })).toBe(false);
  });

  test('a kind the map does not have, or no kind at all, throws when the rule is built', () => {
    expect(() => kind.ruleKindIsOneOf('db:token', 'ownerModel', ['Bogus'])).toThrow(
      'has no kind `Bogus`',
    );
    expect(() => kind.ruleKindIsOneOf('db:token', 'ownerModel', [])).toThrow('names no kind');
    expect(() => kind.ruleKindIsOneOf('db:token', 'nope', ['User'])).toThrow('no polymorphic axis');
    expect(() => kind.ruleActorKindIsOneOf(['Robot'])).toThrow('has no kind `Robot`');
    expect(() => kind.ruleActorIdMatches('userId', 'Internal')).toThrow(
      'not an actor model with a row',
    );
  });
});
