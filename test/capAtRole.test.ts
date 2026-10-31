import { describe, expect, test } from 'bun:test';
import { capAtRole, type PermissionEntry, type RebacSchema } from '../index';

// own ⊇ manage ⊇ operate ⊇ read on each tenant; a user has no operate.
const schema: RebacSchema = {
  permissions: {
    'db:organization': {
      actions: { own: null, manage: 'own', operate: 'manage', read: 'operate' },
    },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        operate: { any: ['manage', { rel: 'organization', action: 'operate' }] },
        read: { any: ['operate', { rel: 'organization', action: 'read' }] },
      },
    },
    'db:user': { actions: { own: null, read: 'own' } },
  },
};

const org = (actions: Record<string, boolean>) => ({
  resource: 'db:organization',
  id: 'o1',
  actions,
});

describe('capAtRole: an entry kept at a ceiling by the schema chain', () => {
  test('own capped at operate keeps read and operate', () => {
    expect(capAtRole(schema, org({ own: true }), 'operate')).toEqual(
      org({ operate: true, read: true }),
    );
  });

  test('read capped at operate keeps read', () => {
    expect(capAtRole(schema, org({ read: true }), 'operate')).toEqual(org({ read: true }));
  });

  test('a ceiling above what the entry holds keeps only what it holds and implies', () => {
    expect(capAtRole(schema, org({ manage: true }), 'own')).toEqual(
      org({ manage: true, operate: true, read: true }),
    );
  });

  test('the chain comes from the resource: a space capped at operate', () => {
    expect(
      capAtRole(schema, { resource: 'db:space', id: 's1', actions: { own: true } }, 'read'),
    ).toEqual({ resource: 'db:space', id: 's1', actions: { read: true } });
  });

  test('a resource without the ceiling action: dropped', () => {
    expect(
      capAtRole(schema, { resource: 'db:user', id: 'u1', actions: { own: true } }, 'operate'),
    ).toBeNull();
  });

  test('nothing held at or under the ceiling: dropped', () => {
    expect(capAtRole(schema, org({ own: false }), 'read')).toBeNull();
    expect(capAtRole(schema, org({}), 'read')).toBeNull();
  });

  test('a conditional action is not held, so it never becomes unconditional', () => {
    expect(
      capAtRole(
        schema,
        { resource: 'db:organization', id: 'o1', actions: { own: () => true } },
        'read',
      ),
    ).toBeNull();
  });

  test('an action outside the schema is kept only at that very ceiling', () => {
    const entry = { resource: 'db:organization', id: 'o1', actions: { audit: true } };
    expect(capAtRole(schema, entry, 'audit')).toEqual(entry);
    expect(capAtRole(schema, entry, 'read')).toBeNull();
  });

  test('a resource-wide entry stays resource-wide; an entitlement keeps its anchor and where', () => {
    expect(
      capAtRole(schema, { resource: 'db:organization', actions: { own: true } }, 'read'),
    ).toEqual({ resource: 'db:organization', actions: { read: true } });
    const anchor = { resource: 'db:space', id: 's1' };
    const where = { field: 'name', operator: 'equals' as const, value: 'x' };
    const entitlement: PermissionEntry = {
      resource: 'db:space',
      anchor,
      where,
      actions: { manage: true },
    };
    expect(capAtRole(schema, entitlement, 'operate')).toEqual({
      resource: 'db:space',
      anchor,
      where,
      actions: { operate: true, read: true },
    });
  });
});
