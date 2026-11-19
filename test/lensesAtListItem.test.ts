import { describe, expect, test } from 'bun:test';
import { validateRuleInLens } from '@inixiative/json-rules';
import {
  declaredListsOf,
  issuesForRuleReadsOutsideLens,
  lensesAtListItem,
  lensesAtRow,
  type RebacSchema,
  relationHopsFrom,
  type SchemaMap,
} from '../index';

const map: SchemaMap = {
  resources: { org: 'Org', member: 'Member', user: 'User' },
  actors: { models: ['User'] },
  fieldMap: {
    models: {
      Org: {
        fields: {
          id: { kind: 'scalar', type: 'String', isId: true },
          name: { kind: 'scalar', type: 'String' },
          members: {
            kind: 'object',
            type: 'Member',
            isList: true,
            relationName: 'OrgMembers',
            annotations: { permissions: { down: ['user'] } },
          },
          guests: { kind: 'object', type: 'Member', isList: true, relationName: 'OrgGuests' },
        },
      },
      Member: {
        fields: {
          id: { kind: 'scalar', type: 'String', isId: true },
          role: { kind: 'scalar', type: 'String' },
          orgId: { kind: 'scalar', type: 'String' },
          org: {
            kind: 'object',
            type: 'Org',
            relationName: 'OrgMembers',
            fromFields: ['orgId'],
            toFields: ['id'],
          },
          userId: { kind: 'scalar', type: 'String' },
          user: {
            kind: 'object',
            type: 'User',
            relationName: 'MemberUser',
            fromFields: ['userId'],
            toFields: ['id'],
          },
        },
      },
      User: {
        fields: {
          id: { kind: 'scalar', type: 'String', isId: true },
          email: { kind: 'scalar', type: 'String' },
        },
      },
    },
  },
};

const reads = (lens: ReturnType<typeof lensesAtRow>['rule'], field: string) =>
  lens ? validateRuleInLens({ field, operator: 'equals', value: 'x' }, lens).ok : false;

describe('lensesAtRow / lensesAtListItem', () => {
  test("a row's rule lens carries the actor, its lens does not", () => {
    const at = lensesAtRow(map, 'member');
    expect(reads(at.rule, 'actor:User.email')).toBe(true);
    expect(reads(at.rule, '__actor.id')).toBe(false);
    expect(reads(at.lens, 'actor:User.email')).toBe(false);
    expect(reads(at.lens, 'user.email')).toBe(true);
  });

  test('an item of a declared list is judged in what its `down` paths load', () => {
    const item = lensesAtListItem(map, 'org', 'members');
    expect(item?.resource).toBe('member');
    expect(item?.under?.list).toBe('org.members');
    expect(reads(item?.lens ?? null, 'user.email')).toBe(true);
  });

  test('a list that is not declared has no item lenses', () => {
    expect(lensesAtListItem(map, 'org', 'guests')).toBeNull();
    expect(lensesAtListItem(map, 'org', 'name')).toBeNull();
  });
});

describe('relationHopsFrom / declaredListsOf', () => {
  const schema = {
    permissions: { org: { actions: { read: true } }, member: { actions: { read: 'read' } } },
  };
  test('a row offers its followed to-one relations, each with where it lands', () => {
    const hops = relationHopsFrom(map, schema, lensesAtRow(map, 'member'));
    expect(hops).toEqual([
      { segment: 'org', resource: 'org', bridge: false },
      { segment: 'user', resource: 'user', bridge: false },
    ]);
  });
  test('a hop past a walked path is offered from where it lands, never back to a model passed', () => {
    const hops = relationHopsFrom(map, schema, lensesAtRow(map, 'member'), 'org');
    expect(hops).toEqual([]);
  });
  test('declared lists only', () => {
    expect(declaredListsOf(map, 'org')).toEqual(['members']);
  });
  test('an inline rule reading outside the lens has issues', () => {
    const issues = issuesForRuleReadsOutsideLens(map, schema, 'member', {
      rule: { field: 'org.members.role', operator: 'equals', value: 'x' },
    });
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('relationHopsFrom over bridges and a self relation', () => {
  const dbMap: SchemaMap = {
    resources: { 'db:org': 'Org' },
    fieldMap: {
      models: {
        Org: {
          fields: {
            id: { kind: 'scalar', type: 'String', isId: true },
            parentId: { kind: 'scalar', type: 'String' },
            parent: {
              kind: 'object',
              type: 'Org',
              relationName: 'tree',
              fromFields: ['parentId'],
              toFields: ['id'],
            },
            children: { kind: 'object', type: 'Org', isList: true, relationName: 'tree' },
            accountId: { kind: 'scalar', type: 'String' },
          },
        },
      },
    },
  };
  const schema: RebacSchema = {
    bridges: [
      {
        endpoints: [
          { fieldMap: 'db', model: 'org', on: 'accountId' },
          { fieldMap: 'crm', model: 'Account', on: 'id' },
        ],
        cardinality: 'oneToOne',
      },
    ],
    permissions: {
      'db:org': { actions: { read: true } },
      'crm:Account': { actions: { read: true } },
    },
  };
  test('a one-hop self relation and a bridge are offered; past a bridge, only bridges', () => {
    const at = lensesAtRow(dbMap, 'db:org');
    expect(relationHopsFrom(dbMap, schema, at)).toEqual([
      { segment: 'parent', resource: 'db:org', bridge: false },
      { segment: 'crm:Account', resource: 'crm:Account', bridge: true },
    ]);
    // The far end is not in the map, so it has no relations of its own: only the bridge back.
    expect(relationHopsFrom(dbMap, schema, at, 'crm:Account')).toEqual([
      { segment: 'db:org', resource: 'db:org', bridge: true },
    ]);
  });
});
