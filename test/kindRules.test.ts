import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  createRebacCheck,
  makeKindRules,
  type PermixLike,
  type RebacSchema,
  type Row,
  ruleFieldEqualsPath,
  type SchemaMap,
  validateSchema,
} from '../index';
import { actorData, actorMap, stringColumn } from './schemaMaps';

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
  supplied: { maps: { actor: actorMap } },
};
const kind = makeKindRules(map);
const check = createRebacCheck(map);
const permix: PermixLike = {
  check: (resource, action) => resource === 'db:organization' && action === 'manage',
};
const user = actorData('User', { id: 'u1' });
const internal = actorData('Internal');
const nobody = actorData(null);
const schemaOf = (manage: ActionRule): RebacSchema => ({
  permissions: {
    'db:token': { actions: { manage } },
    'db:organization': { actions: { manage: false } },
    'db:space': { actions: { manage: false } },
    'db:user': { actions: { manage: false } },
  },
});
const manage = (rule: ActionRule, data: Record<string, Row[]>, record: Row) =>
  check(permix, schemaOf(rule), { resource: 'db:token', record, data }, 'manage');
const isKind = (field: string, value: string): ActionRule => ({
  rule: { field, operator: Operator.equals, value },
});

describe('the fan-out: each branch checks its own kind first', () => {
  const rule = kind.ruleForEachKind('db:token', 'ownerModel', {
    Organization: { rel: 'organization', action: 'manage' },
    User: ruleFieldEqualsPath('userId', 'actor:User.id'),
    default: true,
  });

  test('builds one positive branch per kind given, the match checking its field exists', () => {
    expect(rule).toEqual({
      any: [
        {
          all: [isKind('ownerModel', 'Organization'), { rel: 'organization', action: 'manage' }],
        },
        {
          all: [
            isKind('ownerModel', 'User'),
            {
              rule: {
                all: [
                  { field: 'userId', operator: 'exists' },
                  { field: 'userId', operator: 'equals', path: 'actor:User.id' },
                ],
              },
            },
          ],
        },
        isKind('ownerModel', 'default'),
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
    expect(manage(rule, nobody, { ownerModel: 'User', userId: 'u1', user: { id: 'u1' } })).toBe(
      false,
    );
    expect(manage(rule, nobody, { ownerModel: 'default' })).toBe(true);
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
          all: [isKind('ownerModel', 'Organization'), { rel: 'organization', action: 'manage' }],
        },
      ],
    });
  });

  test("kind membership, on a resource's side and on a supplied model's enum, read the same way", () => {
    expect(kind.ruleKindIsOneOf('db:token', 'ownerModel', ['Organization', 'Space'])).toEqual({
      rule: { field: 'ownerModel', operator: 'in', value: ['Organization', 'Space'] },
    });
    const userOrInternal = kind.ruleKindIsOneOf('actor:Acting', 'model', ['User', 'Internal']);
    expect(manage(userOrInternal, user, {})).toBe(true);
    expect(manage(userOrInternal, internal, {})).toBe(true);
    expect(manage(userOrInternal, nobody, {})).toBe(false);
    const actorFan = kind.ruleForEachKind('actor:Acting', 'model', {
      Internal: true,
      User: ruleFieldEqualsPath('userId', 'actor:User.id'),
    });
    expect(manage(actorFan, internal, {})).toBe(true);
    expect(manage(actorFan, user, { userId: 'u1' })).toBe(true);
    expect(manage(actorFan, user, { userId: 'u2' })).toBe(false);
  });

  test('a kind the map does not have, or no kind at all, throws when the rule is built', () => {
    expect(() => kind.ruleKindIsOneOf('db:token', 'ownerModel', ['Bogus'])).toThrow(
      'has no kind `Bogus`',
    );
    expect(() => kind.ruleKindIsOneOf('db:token', 'ownerModel', [])).toThrow('names no kind');
    expect(() => kind.ruleKindIsOneOf('db:token', 'nope', ['User'])).toThrow('no polymorphic axis');
    expect(() => kind.ruleKindIsOneOf('actor:Acting', 'model', ['Robot'])).toThrow(
      'has no kind `Robot`',
    );
    expect(() => kind.ruleKindIsOneOf('actor:User', 'id', ['x'])).toThrow(
      'not an enum field of a supplied model',
    );
  });
});
