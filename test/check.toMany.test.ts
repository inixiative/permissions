import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { createPermissions, createRebacCheck, type RebacSchema } from '../index';

const check = createRebacCheck((resource, segment) =>
  resource === 'document' && segment === 'teams' ? 'team' : null,
);

describe('intra-map relation checks accept single records only', () => {
  const schema: RebacSchema = {
    permissions: {
      document: { actions: { read: { rel: 'teams', action: 'read' } } },
      team: { actions: { read: null } },
    },
  };

  test('an empty list cannot inherit a resource-wide grant', async () => {
    const permix = createPermissions();
    await permix.setup([{ resource: 'team', actions: { read: true } }]);
    expect(
      check(
        permix,
        schema,
        {
          resource: 'document',
          record: { id: 'd1', teams: [] },
        },
        'read',
      ),
    ).toBe(false);
  });

  test('a populated list is rejected instead of being treated as a related record', async () => {
    const permix = createPermissions();
    await permix.setup([{ resource: 'team', actions: { read: true } }]);
    expect(
      check(
        permix,
        schema,
        {
          resource: 'document',
          record: { id: 'd1', teams: [{ id: 't1' }] },
        },
        'read',
      ),
    ).toBe(false);
    expect(
      check(
        permix,
        schema,
        {
          resource: 'document',
          record: { id: 'd1', teams: { id: 't1' } },
        },
        'read',
      ),
    ).toBe(true);
  });

  test('a list cannot reach a scalar ABAC rule and throw', () => {
    const abacSchema: RebacSchema = {
      permissions: {
        ...schema.permissions,
        team: {
          actions: {
            read: {
              rule: {
                field: 'public',
                operator: Operator.equals,
                value: true,
              },
            },
          },
        },
      },
    };
    expect(
      check(
        createPermissions(),
        abacSchema,
        {
          resource: 'document',
          record: { id: 'd1', teams: [{ id: 't1', public: true }] },
        },
        'read',
      ),
    ).toBe(false);
  });
});
