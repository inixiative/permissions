import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import type { RebacSchema, ResolveRelation } from '../index';
import { createPermissions, createRebacCheck, defineActor } from '../index';

const schema: RebacSchema = {
  permissions: {
    organization: { actions: { own: null, manage: 'own', read: 'manage' } },
    integration: {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { rel: 'organization', action: 'manage' },
        read: { rel: 'organization', action: 'read' },
      },
      collections: {
        create: {
          all: [
            { rule: { field: 'ownerModel', operator: Operator.equals, value: 'Organization' } },
            'manage',
          ],
        },
        readMany: 'read',
      },
    },
    user: { actions: { own: null, read: 'own' } },
  },
};

const resolveRelation: ResolveRelation = (resource, segment) =>
  resource === 'integration' && segment === 'organization' ? 'organization' : null;
const check = createRebacCheck(resolveRelation, { selfResource: 'user' });

const org = { id: 'o1' };
const slack = { id: 'i1', provider: 'slack', organizationId: 'o1', organization: org };
const linear = { id: 'i2', provider: 'linear', organizationId: 'o1', organization: org };
const subject = (record: Record<string, unknown>) => ({ resource: 'integration', record });

const permix = async (entries: Parameters<ReturnType<typeof createPermissions>['setup']>[0]) => {
  const p = createPermissions();
  p.setActor(defineActor({ id: 't1', model: 'Token', principal: { model: 'User', id: 'u1' } }));
  await p.setup(entries);
  return p;
};

describe('permix expressions: several passes over one subject', () => {
  test('all: principal AND grant', async () => {
    const principal = await permix({ resource: 'organization', id: 'o1', actions: { own: true } });
    const viewer = await permix({ resource: 'organization', id: 'o1', actions: { read: true } });
    expect(check({ all: [principal, viewer] }, schema, subject(slack), 'read')).toBe(true);
    expect(check({ all: [principal, viewer] }, schema, subject(slack), 'manage')).toBe(false);
    expect(check(principal, schema, subject(slack), 'manage')).toBe(true);
  });

  test('a grant cannot widen past its principal', async () => {
    const reader = await permix({ resource: 'organization', id: 'o1', actions: { read: true } });
    const owner = await permix({ resource: 'organization', id: 'o1', actions: { own: true } });
    expect(check({ all: [reader, owner] }, schema, subject(slack), 'manage')).toBe(false);
  });

  test('any: an alternative pass widens', async () => {
    const none = await permix([]);
    const tenant = await permix({ resource: 'organization', id: 'o1', actions: { own: true } });
    const entitled = await permix({ resource: 'integration', actions: { manage: true } });
    const principal = { any: [none, { all: [tenant, entitled] }] };
    expect(check(principal, schema, subject(slack), 'manage')).toBe(true);
    const otherOrg = { ...slack, organizationId: 'o2', organization: { id: 'o2' } };
    expect(check(principal, schema, subject(otherOrg), 'manage')).toBe(false);
  });
});

describe('rule-valued grants at the merge point', () => {
  test('a resource-wide rule narrows its own pass', async () => {
    const grant = await permix({
      resource: 'integration',
      actions: { read: { rule: { field: 'provider', operator: Operator.equals, value: 'slack' } } },
    });
    expect(check(grant, schema, subject(slack), 'read')).toBe(true);
    expect(check(grant, schema, subject(linear), 'read')).toBe(false);
  });

  test('an id-keyed rule applies only to its row', async () => {
    const grant = await permix({
      resource: 'integration',
      id: 'i1',
      actions: { manage: true, read: 'manage' },
    });
    expect(check(grant, schema, subject(slack), 'read')).toBe(true);
    expect(check(grant, schema, subject(linear), 'read')).toBe(false);
  });

  test('a rule that delegates back to itself is a cycle, as a row rule is', async () => {
    const grant = await permix({ resource: 'integration', actions: { read: 'read' } });
    expect(() => check(grant, schema, subject(slack), 'read')).toThrow(/Cycle detected/);
  });

  test('a held true still short-circuits', async () => {
    const grant = await permix({ resource: 'integration', actions: { read: true } });
    expect(check(grant, schema, subject(linear), 'read')).toBe(true);
  });
});

describe('collections', () => {
  test('a collection rule is checked on the scope or draft row', async () => {
    const admin = await permix({ resource: 'organization', id: 'o1', actions: { manage: true } });
    const draft = { ownerModel: 'Organization', organizationId: 'o1', organization: org };
    expect(check(admin, schema, subject(draft), { collection: 'create' })).toBe(true);
    expect(
      check(admin, schema, subject({ ...draft, ownerModel: 'User' }), { collection: 'create' }),
    ).toBe(false);
    expect(
      check(admin, schema, subject({ organizationId: 'o1', organization: org }), {
        collection: 'readMany',
      }),
    ).toBe(true);
  });

  test('a collection the resource does not declare denies', async () => {
    const admin = await permix({ resource: 'organization', id: 'o1', actions: { own: true } });
    expect(
      check(admin, schema, { resource: 'user', record: { id: 'u1' } }, { collection: 'create' }),
    ).toBe(false);
  });

  test('a superadmin passes any collection', async () => {
    const admin = await permix([]);
    admin.setSuperadmin(true);
    expect(check(admin, schema, { resource: 'user', record: {} }, { collection: 'create' })).toBe(
      true,
    );
  });
});
