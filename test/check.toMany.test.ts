import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { createPermissions } from '../index';
import { checkWithRules, mapOf, type Rules } from './schemaMaps';

const check = checkWithRules(
  mapOf(
    { 'db:document': { teams: 'db:team' } },
    { 'db:team': ['public'], 'db:document': ['public'] },
  ),
);

describe('intra-map relation checks accept single records only', () => {
  const schema: Rules = {
    permissions: {
      'db:document': { actions: { read: { rel: 'teams', action: 'read' } } },
      'db:team': { actions: { read: null } },
    },
  };

  test('an empty list cannot inherit a resource-wide grant', async () => {
    const permix = createPermissions();
    await permix.setup([{ resource: 'db:team', actions: { read: true } }]);
    expect(
      check(
        permix,
        schema,
        {
          resource: 'db:document',
          record: { id: 'd1', teams: [] },
        },
        'read',
      ),
    ).toBe(false);
  });

  test('a populated list is rejected instead of being treated as a related record', async () => {
    const permix = createPermissions();
    await permix.setup([{ resource: 'db:team', actions: { read: true } }]);
    expect(
      check(
        permix,
        schema,
        {
          resource: 'db:document',
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
          resource: 'db:document',
          record: { id: 'd1', teams: { id: 't1' } },
        },
        'read',
      ),
    ).toBe(true);
  });

  test('a list cannot reach a scalar ABAC rule and throw', () => {
    const abacSchema: Rules = {
      permissions: {
        ...schema.permissions,
        'db:team': {
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
          resource: 'db:document',
          record: { id: 'd1', teams: [{ id: 't1', public: true }] },
        },
        'read',
      ),
    ).toBe(false);
  });
});
