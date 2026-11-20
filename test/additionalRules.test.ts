import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import type { AdditionalRules, PermixLike, RebacSchema, Row } from '../index';
import { createRebacCheck, createRebacPaths } from '../index';
import { mapOf } from './schemaMaps';

const actor = (id: string): PermixLike => ({
  check: () => false,
  isSuperadmin: () => false,
  getActor: () => ({ model: 'User', record: { id } }),
});

const schema: RebacSchema = {
  permissions: {
    organization: {
      actions: {
        own: {
          rule: {
            all: [
              { field: 'actor:User.id', operator: Operator.exists },
              { field: 'ownerId', operator: Operator.equals, path: 'actor:User.id' },
            ],
          },
        },
        read: 'own',
      },
    },
    contact: {
      actions: { own: { rel: 'organization', action: 'own' }, manage: 'own', read: 'manage' },
    },
  },
};

const map = mapOf(
  { contact: { organization: 'organization' } },
  { organization: ['ownerId'], contact: ['label'] },
);

// The app's side: a record takes the rules its organization holds for its resource.
const rulesOfTheOrganization: AdditionalRules = (resource, record) => [
  ((record.organization as Row | undefined)?.rules as Record<string, never> | undefined)?.[
    resource
  ],
];
const check = createRebacCheck(map, { additionalRules: rulesOfTheOrganization });

const organization = (id: string, rules?: unknown): Row => ({ id, ownerId: `owner-${id}`, rules });
const contactOf = (owner: Row, fields: Row = {}): Row => ({
  id: 'contact-1',
  organizationId: owner.id,
  organization: owner,
  ...fields,
});
const can = (record: Row, action: string, resource = 'contact') =>
  check(actor('stranger'), schema, { resource, record }, action);

describe('additional rules for a record', () => {
  test('widen the action they name on that record, and nothing else', () => {
    const open = organization('org-1', { contact: { read: true } });
    expect(can(contactOf(organization('org-1')), 'read')).toBe(false);
    expect(can(contactOf(open), 'read')).toBe(true);
    expect(can(contactOf(open), 'manage')).toBe(false);
    expect(can(contactOf(organization('org-2')), 'read')).toBe(false);
    expect(can(open, 'read', 'organization')).toBe(false);
  });

  test('are asked for every record the walk reaches, not only the first', () => {
    const viaOrganization: RebacSchema = {
      permissions: {
        ...schema.permissions,
        contact: { actions: { read: { rel: 'organization', action: 'read' } } },
      },
    };
    const selfOpening: AdditionalRules = (resource, record) =>
      resource === 'organization' ? [record.rules as Record<string, never>] : [];
    const walked = createRebacCheck(map, { additionalRules: selfOpening });
    const at = (owner: Row) =>
      walked(
        actor('stranger'),
        viaOrganization,
        { resource: 'contact', record: contactOf(owner) },
        'read',
      );
    expect(at(organization('org-1'))).toBe(false);
    expect(at(organization('org-1', { read: true }))).toBe(true);
  });

  test('take a condition on the record and on who is acting', () => {
    const owner = organization('org-1', {
      contact: {
        read: {
          any: [
            { rule: { field: 'label', operator: Operator.equals, value: 'public' } },
            {
              rule: {
                all: [
                  { field: 'actor:User.id', operator: Operator.exists },
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
      contact: { read: { rule: { field: 'label', operator: Operator.equals, value: 'public' } } },
    });
    expect(can(contactOf(owner, { label: 'private' }), 'read')).toBe(false);
    expect(
      can(contactOf(owner, { label: 'private', permissionRules: { read: true } }), 'read'),
    ).toBe(true);
  });

  test('widen nothing, and never throw, when a rule is one the core refuses', () => {
    const stored = (rule: unknown, fields: Row = {}) =>
      can(contactOf(organization('org-1', { contact: { read: rule } }), fields), 'read');
    expect(stored('read')).toBe(false);
    expect(stored({ rule: { field: 'label', operator: Operator.notEquals, value: 'x' } })).toBe(
      false,
    );
    expect(stored({ rule: { field: 'secret', operator: Operator.equals, value: 'x' } })).toBe(
      false,
    );
    expect(stored('manage', { permissionRules: { manage: 'read' } })).toBe(false);
    expect(can(contactOf(organization('org-1', { contact: 'everything' })), 'read')).toBe(false);
  });

  test('admit a path the same way the check does', () => {
    const paths = createRebacPaths(map, { additionalRules: rulesOfTheOrganization });
    const at = (owner: Row) =>
      paths(actor('stranger'), schema, { resource: 'contact', record: contactOf(owner) }, 'read');
    expect(at(organization('org-1'))).toHaveLength(0);
    expect(at(organization('org-1', { contact: { read: true } })).length).toBeGreaterThan(0);
  });
});
