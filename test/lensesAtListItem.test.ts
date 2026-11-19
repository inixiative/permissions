import { describe, expect, test } from 'bun:test';
import { validateRuleInLens } from '@inixiative/json-rules';
import { lensesAtListItem, lensesAtRow, type SchemaMap } from '../index';

const map: SchemaMap = {
  resources: { org: 'Org', member: 'Member', user: 'User' },
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
    expect(reads(at.rule, '__actor.id')).toBe(true);
    expect(reads(at.lens, '__actor.id')).toBe(false);
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
