import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import type { AdditionalRules, PermixLike, Row } from '../index';
import { actorData, checkWithRules, mapOf, pathsWithRules, type Rules } from './schemaMaps';

const permix: PermixLike = {
  check: () => false,
  isSuperadmin: () => false,
};
const stranger = actorData('User', { id: 'stranger' });

const schema: Rules = {
  permissions: {
    'db:organization': {
      actions: {
        own: {
          rule: {
            all: [
              { field: 'ownerId', operator: Operator.exists },
              { field: 'actor:User.id', operator: Operator.exists },
              { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
            ],
          },
        },
        read: 'own',
      },
    },
    'db:contact': {
      actions: { own: { rel: 'organization', action: 'own' }, manage: 'own', read: 'manage' },
    },
  },
};

const map = mapOf(
  { 'db:contact': { organization: 'db:organization' } },
  { 'db:organization': ['ownerId'], 'db:contact': ['label'] },
);

// The app's side: a record takes the rules its organization holds for its resource.
const rulesOfTheOrganization: AdditionalRules = (resource, record) => [
  ((record.organization as Row | undefined)?.rules as Record<string, never> | undefined)?.[
    resource
  ],
];
const check = checkWithRules(map, { additionalRules: rulesOfTheOrganization });

const organization = (id: string, rules?: unknown): Row => ({ id, ownerId: `owner-${id}`, rules });
const contactOf = (owner: Row, fields: Row = {}): Row => ({
  id: 'contact-1',
  organizationId: owner.id,
  organization: owner,
  ...fields,
});
const can = (record: Row, action: string, resource = 'db:contact') =>
  check(permix, schema, { resource, record, data: stranger }, action);

describe('additional rules for a record', () => {
  test('widen the action they name on that record, and nothing else', () => {
    const open = organization('org-1', { 'db:contact': { read: true } });
    expect(can(contactOf(organization('org-1')), 'read')).toBe(false);
    expect(can(contactOf(open), 'read')).toBe(true);
    expect(can(contactOf(open), 'manage')).toBe(false);
    expect(can(contactOf(organization('org-2')), 'read')).toBe(false);
    expect(can(open, 'read', 'db:organization')).toBe(false);
  });

  test('are asked for every record the walk reaches, not only the first', () => {
    const viaOrganization: Rules = {
      permissions: {
        ...schema.permissions,
        'db:contact': { actions: { read: { rel: 'organization', action: 'read' } } },
      },
    };
    const selfOpening: AdditionalRules = (resource, record) =>
      resource === 'db:organization' ? [record.rules as Record<string, never>] : [];
    const walked = checkWithRules(map, { additionalRules: selfOpening });
    const at = (owner: Row) =>
      walked(
        permix,
        viaOrganization,
        { resource: 'db:contact', record: contactOf(owner), data: stranger },
        'read',
      );
    expect(at(organization('org-1'))).toBe(false);
    expect(at(organization('org-1', { read: true }))).toBe(true);
  });

  test('take a condition on the record and on who is acting', () => {
    const owner = organization('org-1', {
      'db:contact': {
        read: {
          any: [
            { rule: { field: 'label', operator: Operator.equals, value: 'public' } },
            {
              rule: {
                all: [
                  { field: 'actor:User.id', operator: Operator.exists },
                  { field: 'label', operator: Operator.exists },
                  { field: 'label', operator: Operator.equals, path: 'actor:User.id' },
                ],
              },
            },
          ],
        },
      },
    });
    expect(can(contactOf(owner, { label: 'public' }), 'read')).toBe(true);
    expect(can(contactOf(owner, { label: 'stranger' }), 'read')).toBe(true);
    expect(can(contactOf(owner, { label: 'private' }), 'read')).toBe(false);
  });

  test("add to the record's own rule: either one opens the action", () => {
    const owner = organization('org-1', {
      'db:contact': {
        read: { rule: { field: 'label', operator: Operator.equals, value: 'public' } },
      },
    });
    expect(can(contactOf(owner, { label: 'private' }), 'read')).toBe(false);
    expect(
      can(contactOf(owner, { label: 'private', permissionRules: { read: true } }), 'read'),
    ).toBe(true);
  });

  test('are refused, by a throw, when a rule is one the core refuses', () => {
    const stored =
      (rule: unknown, fields: Row = {}) =>
      () =>
        can(contactOf(organization('org-1', { 'db:contact': { read: rule } }), fields), 'read');
    expect(stored('read')).toThrow('stored outside the map');
    expect(stored({ rule: { field: 'label', operator: Operator.notEquals, value: 'x' } })).toThrow(
      'stored outside the map',
    );
    expect(stored({ rule: { field: 'secret', operator: Operator.equals, value: 'x' } })).toThrow(
      'stored outside the map',
    );
    expect(() =>
      can(
        contactOf(organization('org-1', { 'db:contact': { read: 'manage' } }), {
          permissionRules: { manage: 'read' },
        }),
        'read',
      ),
    ).toThrow('stored outside the map');
    expect(can(contactOf(organization('org-1', { 'db:contact': 'everything' })), 'read')).toBe(
      false,
    );
  });

  test('admit a path the same way the check does', () => {
    const paths = pathsWithRules(map, { additionalRules: rulesOfTheOrganization });
    const at = (owner: Row) =>
      paths(
        permix,
        schema,
        { resource: 'db:contact', record: contactOf(owner), data: stranger },
        'read',
      );
    expect(at(organization('org-1'))).toHaveLength(0);
    expect(at(organization('org-1', { 'db:contact': { read: true } })).length).toBeGreaterThan(0);
  });
});
