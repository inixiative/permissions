import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import type { PermixLike, RebacSchema, Row } from '../index';
import {
  createRebacCheck,
  createRebacPaths,
  validateSchema,
  validateTenantPermissionRules,
} from '../index';
import { mapOf } from './schemaMaps';

const actor = (id: string): PermixLike => ({
  check: () => false,
  isSuperadmin: () => false,
  getActor: () => ({ model: 'user', record: { id } }),
});

const ownerIsActor = {
  rule: { field: 'ownerId', operator: Operator.equals, path: '__actor.record.id' },
};

const schema: RebacSchema = {
  permissions: {
    organization: { actions: { own: ownerIsActor, read: 'own' } },
    space: {
      actions: { own: { rel: 'organization', action: 'own' }, read: 'own' },
      tenantPaths: ['organization'],
    },
    contact: {
      actions: {
        own: {
          any: [
            { rel: 'organization', action: 'own' },
            { rel: 'space', action: 'own' },
          ],
        },
        manage: 'own',
        read: 'manage',
      },
      tenantPaths: ['organization', 'space', 'space.organization'],
    },
    note: { actions: { read: { rel: 'organization', action: 'own' } } },
    token: {
      actions: { read: { rel: 'organization', action: 'own' } },
      tenantPaths: [
        'organization',
        { path: 'user', kinds: { field: 'ownerModel', values: ['user'] } },
      ],
    },
    user: { actions: { own: null } },
  },
};

const map = mapOf(
  {
    space: { organization: 'organization' },
    contact: { organization: 'organization', space: 'space' },
    note: { organization: 'organization' },
    token: { organization: 'organization', user: 'user' },
  },
  { organization: ['ownerId'], contact: ['label'], token: ['ownerModel'] },
);
const check = createRebacCheck(map);

const organization = (id: string, tenantPermissionRules?: unknown): Row => ({
  id,
  ownerId: `owner-of-${id}`,
  tenantPermissionRules,
});
const contactOf = (owner: Row, fields: Row = {}): Row => ({
  id: 'contact-1',
  organizationId: owner.id,
  organization: owner,
  ...fields,
});
const can = (record: Row, action: string, resource = 'contact') =>
  check(actor('stranger'), schema, { resource, record }, action);

describe("a tenant's rules for the records under it", () => {
  test('widen the action they name, on that resource, and nothing else', () => {
    const open = organization('org-1', { contact: { read: true } });
    expect(can(contactOf(organization('org-1')), 'read')).toBe(false);
    expect(can(contactOf(open), 'read')).toBe(true);
    expect(can(contactOf(open), 'manage')).toBe(false);
    expect(can({ id: 'note-1', organizationId: 'org-1', organization: open }, 'read', 'note')).toBe(
      false,
    );
  });

  test('open only the records under the tenant that holds them', () => {
    const open = organization('org-1', { contact: { read: true } });
    const closed = organization('org-2');
    expect(can(contactOf(open), 'read')).toBe(true);
    expect(can(contactOf(closed), 'read')).toBe(false);
  });

  test("a space's rules do not reach a sibling space", () => {
    const above = organization('org-1');
    const inSpace = (space: Row): Row => ({
      id: 'contact-1',
      spaceId: space.id,
      space: { ...space, organizationId: above.id, organization: above },
    });
    const open = { id: 'space-1', tenantPermissionRules: { contact: { read: true } } };
    expect(can(inSpace(open), 'read')).toBe(true);
    expect(can(inSpace({ id: 'space-2' }), 'read')).toBe(false);
  });

  test('reach every record up the owner chain: a space, and the organization above it', () => {
    const inSpace = (space: Row, above: Row): Row => ({
      id: 'contact-1',
      spaceId: space.id,
      space: { ...space, organizationId: above.id, organization: above },
    });
    const closed = organization('org-1');
    expect(can(inSpace({ id: 'space-1' }, closed), 'read')).toBe(false);
    expect(
      can(
        inSpace({ id: 'space-1', tenantPermissionRules: { contact: { read: true } } }, closed),
        'read',
      ),
    ).toBe(true);
    const openAbove = organization('org-1', { contact: { read: true }, space: { read: true } });
    expect(can(inSpace({ id: 'space-1' }, openAbove), 'read')).toBe(true);
    expect(
      can({ id: 'space-1', organizationId: 'org-1', organization: openAbove }, 'read', 'space'),
    ).toBe(true);
  });

  test('take a condition on the record and on who is acting', () => {
    const rules = {
      contact: {
        read: {
          any: [
            { rule: { field: 'label', operator: Operator.equals, value: 'public' } },
            { rule: { field: 'label', operator: Operator.equals, path: '__actor.record.id' } },
          ],
        },
      },
    };
    const owner = organization('org-1', rules);
    expect(can(contactOf(owner, { label: 'public' }), 'read')).toBe(true);
    expect(can(contactOf(owner, { label: 'stranger' }), 'read')).toBe(true);
    expect(can(contactOf(owner, { label: 'private' }), 'read')).toBe(false);
  });

  test("add to the record's own rule: either one opens the action", () => {
    const publicOnes = {
      contact: { read: { rule: { field: 'label', operator: Operator.equals, value: 'public' } } },
    };
    const owner = organization('org-1', publicOnes);
    const shared = { permissionRules: { read: true } };
    expect(can(contactOf(owner, { label: 'private' }), 'read')).toBe(false);
    expect(can(contactOf(owner, { label: 'public' }), 'read')).toBe(true);
    expect(can(contactOf(owner, { label: 'private', ...shared }), 'read')).toBe(true);
  });

  test('a kind-guarded path counts only on a record of that kind', () => {
    const open = { token: { read: true } };
    const tokenOf = (ownerModel: string, user: Row, above: Row): Row => ({
      id: 'token-1',
      ownerModel,
      userId: user.id,
      user,
      organizationId: above.id,
      organization: above,
    });
    const member = { id: 'user-1', tenantPermissionRules: open };
    const closed = organization('org-1');
    expect(can(tokenOf('user', member, closed), 'read', 'token')).toBe(true);
    expect(can(tokenOf('organizationUser', member, closed), 'read', 'token')).toBe(false);
    expect(
      can(
        tokenOf('organizationUser', { id: 'user-1' }, organization('org-1', open)),
        'read',
        'token',
      ),
    ).toBe(true);
  });

  test('admit a path the same way the check does', () => {
    const paths = createRebacPaths(map);
    const at = (owner: Row) =>
      paths(actor('stranger'), schema, { resource: 'contact', record: contactOf(owner) }, 'read');
    expect(at(organization('org-1'))).toHaveLength(0);
    expect(at(organization('org-1', { contact: { read: true } })).length).toBeGreaterThan(0);
  });

  test('widen nothing, and never throw, when a stored rule is one the core refuses', () => {
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
    expect(can(contactOf(organization('org-1', 'everything')), 'read')).toBe(false);
    expect(can(contactOf(organization('org-1', { contact: 'everything' })), 'read')).toBe(false);
  });
});

describe('validateTenantPermissionRules', () => {
  const issues = (rules: unknown) =>
    validateTenantPermissionRules(rules, { schema, map }).errors.map(
      (issue) => `${issue.path}: ${issue.code}`,
    );

  test('accepts nothing, and rules on the actions the schema has', () => {
    expect(issues(null)).toEqual([]);
    expect(
      issues({ contact: { read: true, manage: { rel: 'organization', action: 'read' } } }),
    ).toEqual([]);
  });

  test('refuses a resource, an action or a shape the schema does not have', () => {
    expect(issues('open')).toEqual(['$: tenantPermissionRules']);
    expect(issues({ invoice: { read: true } })).toEqual(['invoice: resource']);
    expect(issues({ note: { read: true } })).toEqual(['note: tenantPaths']);
    expect(issues({ contact: true })).toEqual(['contact: tenantPermissionRules']);
    expect(issues({ contact: { publish: true } })).toEqual(['contact.publish: action']);
  });

  test('refuses a rule that is negative, loops, or reads outside the lens', () => {
    expect(
      issues({
        contact: { read: { rule: { field: 'label', operator: Operator.notEquals, value: 'x' } } },
      }),
    ).toHaveLength(1);
    expect(issues({ contact: { read: 'read' } })).toEqual(['contact.read: cycle']);
    expect(issues({ contact: { read: 'publish' } })).toEqual(['contact.read: action']);
    expect(issues({ contact: { read: 'manage', manage: 'read' } })).toEqual([
      'contact.read: cycle',
      'contact.manage: cycle',
    ]);
    expect(
      issues({
        contact: { read: { rule: { field: 'secret', operator: Operator.equals, value: 'x' } } },
      }),
    ).toHaveLength(1);
  });
});

describe('validateTenantPermissionRules for one kind of tenant', () => {
  const issues = (rules: unknown, tenant: string) =>
    validateTenantPermissionRules(rules, { schema, map, tenant }).errors.map(
      (issue) => `${issue.path}: ${issue.code}`,
    );

  test('refuses a resource whose records never read that kind of tenant', () => {
    expect(issues({ space: { read: true } }, 'organization')).toEqual([]);
    expect(issues({ space: { read: true } }, 'space')).toEqual(['space: tenantPaths']);
    expect(issues({ contact: { read: true } }, 'space')).toEqual([]);
    expect(issues({ token: { read: true } }, 'user')).toEqual([]);
    expect(issues({ contact: { read: true } }, 'user')).toEqual(['contact: tenantPaths']);
  });
});

describe('validateSchema', () => {
  test('refuses a tenant path that is not a walk of to-one relations', () => {
    const broken: RebacSchema = {
      permissions: {
        ...schema.permissions,
        note: { actions: { read: null }, tenantPaths: ['owner'] },
      },
    };
    expect(validateSchema(map, schema).errors).toEqual([]);
    expect(
      validateSchema(map, broken).errors.map((issue) => `${issue.path}: ${issue.code}`),
    ).toEqual(['note.tenantPaths: tenantPaths']);
  });
});
