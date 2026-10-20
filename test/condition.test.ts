import { describe, expect, test } from 'bun:test';
import { type Condition, Operator } from '@inixiative/json-rules';
import type { RebacSchema, ResolveRelation } from '../index';
import {
  createConditionCompiler,
  createPermissions,
  defineActor,
  implies,
  prefixCondition,
} from '../index';

const schema: RebacSchema = {
  bridges: [
    {
      endpoints: [
        { fieldMap: 'crm', model: 'account', on: 'id' },
        { fieldMap: 'db', model: 'contact', on: 'accountId' },
      ],
      cardinality: 'oneToMany',
    },
  ],
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:space': {
      actions: { own: { rel: 'organization', action: 'own' }, manage: 'own', read: 'manage' },
    },
    'db:contact': {
      actions: {
        read: {
          any: [
            { rel: 'organization', action: 'read' },
            { rel: 'space', action: 'read' },
            { self: 'userId', action: 'read' },
          ],
        },
        personal: {
          all: [{ actor: { field: 'model', operator: Operator.equals, value: 'User' } }, 'read'],
        },
        public: { rule: { field: 'isPublic', operator: Operator.equals, value: true } },
        viaOrgRule: { rel: 'organization', action: 'big' },
        tags: { rel: 'tags', action: 'read' },
        crm: { rel: 'crm:account', action: 'read' },
      },
    },
    'db:user': { actions: { own: null, read: 'own' } },
  },
};
(schema.permissions['db:organization'] as { actions: Record<string, unknown> }).actions.big = {
  rule: { field: 'size', operator: Operator.greaterThan, value: 10 },
};

const relations: Record<string, Record<string, string>> = {
  'db:contact': { organization: 'db:organization', space: 'db:space', tags: 'db:tag' },
  'db:space': { organization: 'db:organization' },
};
const resolveRelation: ResolveRelation = (resource, segment) =>
  relations[resource]?.[segment] ?? null;
const { toCondition } = createConditionCompiler({
  resolveRelation,
  isToMany: (resource, segment) => resource === 'db:contact' && segment === 'tags',
  hasRowRules: (resource) => resource === 'db:contact',
  selfResource: 'db:user',
});

const permix = async (
  entries: Parameters<ReturnType<typeof createPermissions>['setup']>[0],
  actor = defineActor({ id: 'u1' }),
) => {
  const p = createPermissions();
  p.setActor(actor);
  await p.setup(entries);
  return p;
};

const orgToken = defineActor({
  id: 't1',
  model: 'Token',
  principal: { model: 'Organization', id: 'o1' },
});

describe('toCondition', () => {
  test('an owner reaches org- and space-owned rows; an admin only org-owned', async () => {
    const owner = await permix(
      { resource: 'db:organization', id: 'o1', actions: { own: true } },
      orgToken,
    );
    const admin = await permix(
      { resource: 'db:organization', id: 'o1', actions: { manage: true } },
      orgToken,
    );
    const ownerReach = toCondition(owner, schema, 'db:contact', 'read', 'under');
    expect(ownerReach).toEqual({
      any: [
        { field: 'organization.id', operator: 'in', value: ['o1'] },
        { field: 'space.organization.id', operator: 'in', value: ['o1'] },
      ],
    });
    const adminReach = toCondition(admin, schema, 'db:contact', 'read', 'under');
    expect(adminReach).toEqual({ field: 'organization.id', operator: 'in', value: ['o1'] });
    expect(implies(ownerReach, adminReach)).toBe(false);
    expect(implies(adminReach, ownerReach)).toBe(true);
  });

  test('a self arm is the field equal to the person, when the self action holds', async () => {
    const person = await permix({ resource: 'db:user', id: 'u1', actions: { own: true } });
    expect(toCondition(person, schema, 'db:contact', 'read', 'under')).toEqual({
      field: 'userId',
      operator: 'equals',
      value: 'u1',
    });
    const noPerson = await permix([], orgToken);
    expect(toCondition(noPerson, schema, 'db:contact', 'read', 'under')).toBe(false);
  });

  test('an actor arm is a constant for the request', async () => {
    const person = await permix({ resource: 'db:contact', actions: { read: true } });
    expect(toCondition(person, schema, 'db:contact', 'personal', 'under')).toBe(true);
    const token = await permix({ resource: 'db:contact', actions: { read: true } }, orgToken);
    expect(toCondition(token, schema, 'db:contact', 'personal', 'under')).toBe(false);
  });

  test('rule conditions are rebased through the relation walk', async () => {
    const p = await permix([]);
    expect(toCondition(p, schema, 'db:contact', 'viaOrgRule', 'under')).toEqual({
      field: 'organization.size',
      operator: Operator.greaterThan,
      value: 10,
    });
    expect(toCondition(p, schema, 'db:contact', 'public', 'under')).toEqual({
      field: 'isPublic',
      operator: Operator.equals,
      value: true,
    });
  });

  test('to-many walks are false; bridges and row rules are inexact', async () => {
    const p = await permix([]);
    expect(toCondition(p, schema, 'db:contact', 'tags', 'over')).toBe(true); // row rules on contact
    expect(toCondition(p, schema, 'db:contact', 'crm', 'over')).toBe(true);
    expect(toCondition(p, schema, 'db:contact', 'crm', 'under')).toBe(false);
    expect(toCondition(p, schema, 'db:space', 'read', 'over')).toBe(false); // no row rules on space
  });

  test('held resource-wide and superadmin are true', async () => {
    const wide = await permix({ resource: 'db:contact', actions: { read: true } });
    expect(toCondition(wide, schema, 'db:contact', 'read', 'under')).toBe(true);
    const admin = await permix([]);
    admin.setSuperadmin(true);
    expect(toCondition(admin, schema, 'db:contact', 'read', 'under')).toBe(true);
  });

  test('rule-valued grants compile, id-keyed ones bound to their row', async () => {
    const p = await permix(
      [
        {
          resource: 'db:contact',
          actions: { read: { rule: { field: 'kind', operator: Operator.equals, value: 'lead' } } },
        },
        { resource: 'db:contact', id: 'c1', actions: { read: 'public' } },
      ],
      orgToken,
    );
    expect(toCondition(p, schema, 'db:contact', 'read', 'under')).toEqual({
      any: [
        { field: 'kind', operator: Operator.equals, value: 'lead' },
        {
          all: [
            { field: 'id', operator: 'equals', value: 'c1' },
            { field: 'isPublic', operator: Operator.equals, value: true },
          ],
        },
      ],
    });
  });

  test('an expression compiles each pass and combines them', async () => {
    const owner = await permix(
      { resource: 'db:organization', id: 'o1', actions: { own: true } },
      orgToken,
    );
    const grant = await permix({ resource: 'db:space', actions: { read: true } }, orgToken);
    const none = await permix([], orgToken);
    expect(toCondition({ all: [owner, none] }, schema, 'db:space', 'read', 'under')).toBe(false);
    expect(toCondition({ all: [owner, grant] }, schema, 'db:space', 'read', 'under')).toEqual({
      field: 'organization.id',
      operator: 'in',
      value: ['o1'],
    });
  });

  test('a stored rule that loops compiles to false', async () => {
    const p = await permix({ resource: 'db:space', actions: { read: 'read' } }, orgToken);
    expect(toCondition(p, schema, 'db:space', 'read', 'under')).toBe(false);
  });

  test('a schema cycle throws, like the engine', async () => {
    const looping: RebacSchema = { permissions: { 'db:x': { actions: { a: 'b', b: 'a' } } } };
    const p = await permix([]);
    expect(() => toCondition(p, looping, 'db:x', 'a', 'under')).toThrow(/Cycle detected/);
  });
});

describe('implies', () => {
  const inSet = (field: string, value: string[]): Condition => ({
    field,
    operator: Operator.in,
    value,
  });

  test('constants', () => {
    expect(implies(false, inSet('id', ['a']))).toBe(true);
    expect(implies(inSet('id', ['a']), true)).toBe(true);
    expect(implies(true, inSet('id', ['a']))).toBe(false);
  });

  test('membership compares as sets', () => {
    expect(implies(inSet('id', ['a']), inSet('id', ['a', 'b']))).toBe(true);
    expect(implies(inSet('id', ['a', 'c']), inSet('id', ['a', 'b']))).toBe(false);
    expect(
      implies({ field: 'id', operator: Operator.equals, value: 'a' }, inSet('id', ['a'])),
    ).toBe(true);
    expect(implies(inSet('other', ['a']), inSet('id', ['a']))).toBe(false);
  });

  test('any on the left needs every arm; on the right one arm', () => {
    const a = inSet('id', ['a']);
    const b = inSet('kind', ['x']);
    expect(implies({ any: [a, b] }, { any: [b, a] })).toBe(true);
    expect(implies({ any: [a, b] }, a)).toBe(false);
    expect(implies(a, { any: [b, a] })).toBe(true);
  });

  test('all on the right needs every conjunct; on the left one', () => {
    const a = inSet('id', ['a']);
    const b = inSet('kind', ['x']);
    expect(implies({ all: [a, b] }, a)).toBe(true);
    expect(implies(a, { all: [a, b] })).toBe(false);
    expect(implies({ all: [a, b] }, { all: [b, a] })).toBe(true);
  });
});

describe('prefixCondition', () => {
  test('rebases fields and paths, leaves element conditions alone', () => {
    expect(
      prefixCondition(
        {
          all: [
            { field: 'email', operator: Operator.notEquals, path: 'user.email' },
            {
              field: 'tags',
              arrayOperator: 'any',
              condition: { field: 'name', operator: Operator.equals, value: 'x' },
            },
          ],
        } as Condition,
        'contact.',
      ),
    ).toEqual({
      all: [
        { field: 'contact.email', operator: Operator.notEquals, path: 'contact.user.email' },
        {
          field: 'contact.tags',
          arrayOperator: 'any',
          condition: { field: 'name', operator: Operator.equals, value: 'x' },
        },
      ],
    });
  });
});
