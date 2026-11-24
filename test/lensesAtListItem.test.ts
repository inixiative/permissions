import { describe, expect, test } from 'bun:test';
import { validateRuleInLens } from '@inixiative/json-rules';
import {
  declaredListsOf,
  lensesAtListItem,
  lensesAtRow,
  relationHopsFrom,
  type SchemaMap,
  validateActionRule,
} from '../index';
import { actorMap, declaringSuppliedBridges, mapWith, type Rules } from './schemaMaps';

const schemaMap: SchemaMap = declaringSuppliedBridges({
  permissions: {},
  suppliedFieldMaps: { actor: actorMap },
  fieldMaps: {
    db: {
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
  },
});

const reads = (lens: ReturnType<typeof lensesAtRow>['rule'], field: string) =>
  lens ? validateRuleInLens({ field, operator: 'equals', value: 'x' }, lens).ok : false;

describe('lensesAtRow / lensesAtListItem', () => {
  test("a row's rule lens carries the actor, its lens does not", () => {
    const at = lensesAtRow(schemaMap, 'db:Member');
    expect(reads(at.rule, 'actor:User.id')).toBe(true);
    expect(reads(at.rule, '__actor.id')).toBe(false);
    expect(reads(at.lens, 'actor:User.id')).toBe(false);
    expect(reads(at.lens, 'user.email')).toBe(true);
  });

  test('an item of a declared list is judged in what its `down` paths load', () => {
    const item = lensesAtListItem(schemaMap, 'db:Org', 'members');
    expect(item?.resource).toBe('db:Member');
    expect(item?.under?.list).toBe('db:Org.members');
    expect(reads(item?.lens ?? null, 'user.email')).toBe(true);
  });

  test('a list that is not declared has no item lenses', () => {
    expect(lensesAtListItem(schemaMap, 'db:Org', 'guests')).toBeNull();
    expect(lensesAtListItem(schemaMap, 'db:Org', 'name')).toBeNull();
  });
});

describe('relationHopsFrom / declaredListsOf', () => {
  const schema = {
    permissions: {
      'db:Org': { actions: { read: true } },
      'db:Member': { actions: { read: 'read' } },
    },
  };
  test('a row offers its followed to-one relations, each with where it lands', () => {
    const hops = relationHopsFrom(mapWith(schemaMap, schema), lensesAtRow(schemaMap, 'db:Member'));
    expect(hops).toEqual([
      { segment: 'org', resource: 'db:Org', bridge: false },
      { segment: 'user', resource: 'db:User', bridge: false },
    ]);
  });
  test('a hop past a walked path is offered from where it lands, never back to a model passed', () => {
    const hops = relationHopsFrom(
      mapWith(schemaMap, schema),
      lensesAtRow(schemaMap, 'db:Member'),
      'org',
    );
    expect(hops).toEqual([]);
  });
  test('declared lists only', () => {
    expect(declaredListsOf(schemaMap, 'db:Org')).toEqual(['members']);
  });
  test('an inline rule reading outside the lens has issues', () => {
    const issues = validateActionRule(
      { rule: { field: 'org.members.role', operator: 'equals', value: 'x' } },
      { schemaMap: mapWith(schemaMap, schema), resource: 'db:Member' },
    ).errors;
    expect(issues.length).toBeGreaterThan(0);
  });
});

describe('relationHopsFrom over bridges and a self relation', () => {
  const dbMap: SchemaMap = {
    permissions: {},
    fieldMaps: {
      db: {
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
    },
  };
  const schema: Rules = {
    bridges: [
      {
        endpoints: [
          { fieldMap: 'db', model: 'Org', on: 'accountId' },
          { fieldMap: 'crm', model: 'Account', on: 'id' },
        ],
        cardinality: 'oneToOne',
      },
    ],
    permissions: {
      'db:Org': { actions: { read: true } },
      'crm:Account': { actions: { read: true } },
    },
  };
  test('a one-hop self relation and a bridge are offered; past a bridge, only bridges', () => {
    const at = lensesAtRow(dbMap, 'db:Org');
    expect(relationHopsFrom(mapWith(dbMap, schema), at)).toEqual([
      { segment: 'parent', resource: 'db:Org', bridge: false },
      { segment: 'crm:Account', resource: 'crm:Account', bridge: true },
    ]);
    // The far end is not in the map, so it has no relations of its own: only the bridge back.
    expect(relationHopsFrom(mapWith(dbMap, schema), at, 'crm:Account')).toEqual([
      { segment: 'db:Org', resource: 'db:Org', bridge: true },
    ]);
  });
});
