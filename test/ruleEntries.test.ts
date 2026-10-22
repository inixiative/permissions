import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  createRebacCheck,
  entitlementEntries,
  type RebacSchema,
  type ResolveRelation,
} from '../index';

const resolveRelation: ResolveRelation = (resource, segment) => {
  if (resource === 'db:contact' && segment === 'organization') return 'db:organization';
  if (resource === 'db:integration' && segment === 'organization') return 'db:organization';
  return null;
};

const schema: RebacSchema = {
  permissions: {
    'db:organization': {
      actions: { own: null, manage: 'own', operate: 'manage', read: 'operate' },
    },
    'db:contact': {
      actions: {
        read: { rel: 'organization', action: 'read' },
        manage: { rel: 'organization', action: 'manage' },
      },
    },
    'db:integration': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: [{ rel: 'organization', action: 'manage' }, 'own'] },
        read: { any: [{ rel: 'organization', action: 'read' }, 'manage'] },
      },
    },
  },
};

const check = createRebacCheck(resolveRelation);

const o1 = { id: 'o1' };
const o2 = { id: 'o2' };
const slackInO1 = { id: 'i1', provider: 'slack', organization: o1 };
const githubInO1 = { id: 'i2', provider: 'github', organization: o1 };
const slackInO2 = { id: 'i3', provider: 'slack', organization: o2 };

describe('rule-valued entries widen at the merge point', () => {
  test('an entry holding `own` as a rule over the row', async () => {
    const permix = createPermissions();
    await permix.setup([
      { resource: 'db:organization', id: 'o1', actions: { read: true } },
      ...entitlementEntries({
        'db:integration': {
          own: {
            rule: {
              all: [
                { field: 'provider', operator: Operator.equals, value: 'slack' },
                { field: 'organization.id', operator: Operator.equals, value: 'o1' },
              ],
            },
          },
        },
      }),
    ]);
    expect(check(permix, schema, { resource: 'db:integration', record: slackInO1 }, 'own')).toBe(
      true,
    );
    expect(check(permix, schema, { resource: 'db:integration', record: githubInO1 }, 'own')).toBe(
      false,
    );
    expect(check(permix, schema, { resource: 'db:integration', record: slackInO2 }, 'own')).toBe(
      false,
    );
    expect(check(permix, schema, { resource: 'db:integration', record: slackInO1 }, 'read')).toBe(
      true,
    );
  });

  test('an id-keyed rule entry applies to that row only', async () => {
    const permix = createPermissions();
    await permix.setup(
      entitlementEntries({
        'db:integration:i1': {
          manage: { rule: { field: 'provider', operator: Operator.equals, value: 'slack' } },
        },
      }),
    );
    expect(check(permix, schema, { resource: 'db:integration', record: slackInO1 }, 'manage')).toBe(
      true,
    );
    expect(check(permix, schema, { resource: 'db:integration', record: slackInO2 }, 'manage')).toBe(
      false,
    );
  });

  test('permix.rules lists the rule entries for a resource and action', async () => {
    const permix = createPermissions();
    await permix.setup(
      entitlementEntries({
        'db:integration': { read: 'manage' },
        'db:integration:i1': { read: { rule: { field: 'id', operator: Operator.exists } } },
      }),
    );
    expect(permix.rules('db:integration', 'read')).toEqual([
      { rule: 'manage' },
      { id: 'i1', rule: { rule: { field: 'id', operator: Operator.exists } } },
    ]);
    expect(permix.rules('db:integration', 'manage')).toEqual([]);
  });
});
