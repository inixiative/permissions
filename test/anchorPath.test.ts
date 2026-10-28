import { describe, expect, test } from 'bun:test';
import {
  type Anchor,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  type PermissionEntry,
  type PermixLike,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
      },
    },
    'db:integration': {
      actions: {
        own: { rel: 'space', action: 'own' },
        manage: { any: ['own', { rel: 'space', action: 'manage' }] },
        read: { any: ['manage', { rel: 'space', action: 'read' }] },
        connect: { rel: 'space', action: 'manage' },
      },
    },
    'db:inquiry': {
      actions: {
        read: {
          any: [
            { rel: 'sourceOrganization', action: 'read' },
            { rel: 'targetOrganization', action: 'read' },
          ],
        },
      },
    },
  },
};

const relations: Record<string, Record<string, string>> = {
  'db:space': { organization: 'db:organization' },
  'db:integration': {
    space: 'db:space',
    organization: 'db:organization',
    replacedBy: 'db:integration',
  },
  'db:inquiry': { sourceOrganization: 'db:organization', targetOrganization: 'db:organization' },
};
const check = createRebacCheck(mapOf(relations));

const o1 = { id: 'o1' };
const o2 = { id: 'o2' };
const space = (id: string, organization: Row) => ({
  id,
  organizationId: organization.id,
  organization,
});
const integration = (id: string, s: Row) => ({
  id,
  spaceId: s.id,
  space: s,
  organizationId: (s.organization as Row).id,
  organization: s.organization,
});
const inquiry = (id: string, source: Row, target: Row) => ({
  id,
  sourceOrganizationId: source.id,
  sourceOrganization: source,
  targetOrganizationId: target.id,
  targetOrganization: target,
});

const s1 = space('s1', o1);
const s2 = space('s2', o1);
const s1moved = space('s1', o2);

const at = (resource: string, id: string, path?: string): Anchor =>
  ({ resource, id, ...(path === undefined ? {} : { path }) }) as Anchor;

const table = async (...entries: PermissionEntry[]) => {
  const permix = createPermissions();
  await permix.setup(entries);
  return permix;
};
const owns = (resource: string, id: string) => table({ resource, id, actions: { own: true } });

const holderOf = async (entry: EntitlementEntry, owner: PermixLike) => {
  const holder = createPermissions();
  await holder.setup([entry], { owner });
  return holder;
};
const entitlement = (resource: string, anchor: Anchor, action: string): EntitlementEntry => ({
  resource,
  anchor,
  actions: { [action]: true },
});

describe('the anchor reaches the record along its path: relation names, only the anchor id is fixed', () => {
  test('integrations of o1’s spaces, by space.organization: not o2’s', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s1) },
        'manage',
      ),
    ).toBe(true);
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i3', space('s3', o2)) },
        'manage',
      ),
    ).toBe(false);
  });

  test('an integration moved to another space of o1 is still reached: access on the new side', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s2) },
        'manage',
      ),
    ).toBe(true);
  });

  test('a space transferred out of o1: an entitlement anchored at o1 stops reaching it', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s1moved) },
        'manage',
      ),
    ).toBe(false);
  });

  test('a space transferred out of o1: anchored at the space and capped by the space’s owner, it follows the space', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:space', 's1', 'space'), 'manage'),
      await owns('db:space', 's1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s1moved) },
        'manage',
      ),
    ).toBe(true);
  });

  test('a space transferred out of o1: anchored at the space but capped by o1’s owner, nothing', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:space', 's1', 'space'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s1moved) },
        'manage',
      ),
    ).toBe(false);
  });

  test('sides: anchored at o1 by targetOrganization reaches what o1 received, not what o1 sent', async () => {
    const holder = await holderOf(
      entitlement('db:inquiry', at('db:organization', 'o1', 'targetOrganization'), 'read'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(holder, schema, { resource: 'db:inquiry', record: inquiry('q1', o2, o1) }, 'read'),
    ).toBe(true);
    expect(
      check(holder, schema, { resource: 'db:inquiry', record: inquiry('q2', o1, o2) }, 'read'),
    ).toBe(false);
  });

  test('the action is checked on the record, never asked of the anchor', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'connect'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s1) },
        'connect',
      ),
    ).toBe(true);
  });

  test('a path through a list relation grants nothing', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:space', 's1', 'space'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: { ...integration('i1', s1), space: [s1] } },
        'manage',
      ),
    ).toBe(false);
  });

  test('a hydrated relation the path does not name is not the anchor', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:space', 's2', 'space'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    const replaced = { ...integration('i1', s1), replacedBy: integration('i9', s2) };
    expect(check(holder, schema, { resource: 'db:integration', record: replaced }, 'manage')).toBe(
      false,
    );
  });

  test('a path that is not hydrated on the record grants nothing', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space.organization'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: { id: 'i1', spaceId: 's1' } },
        'manage',
      ),
    ).toBe(false);
  });

  test('a path that lands on another model grants nothing', async () => {
    const holder = await holderOf(
      entitlement('db:integration', at('db:organization', 'o1', 'space'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(
      check(
        holder,
        schema,
        { resource: 'db:integration', record: integration('i1', s1) },
        'manage',
      ),
    ).toBe(false);
  });
});

describe('a self anchor has no path; every other anchor has one', () => {
  test('a self anchor reaches the record itself', async () => {
    const holder = await holderOf(
      entitlement('db:space', at('db:space', 's1'), 'manage'),
      await owns('db:organization', 'o1'),
    );
    expect(check(holder, schema, { resource: 'db:space', record: s1 }, 'manage')).toBe(true);
    expect(check(holder, schema, { resource: 'db:space', record: s2 }, 'manage')).toBe(false);
  });

  test('a self anchor with a path is refused when it is installed', async () => {
    await expect(
      holderOf(
        entitlement('db:space', at('db:space', 's1', 'organization'), 'manage'),
        await owns('db:organization', 'o1'),
      ),
    ).rejects.toThrow();
  });

  test('an anchor on another model without a path is refused when it is installed', async () => {
    await expect(
      holderOf(
        entitlement('db:integration', at('db:space', 's1'), 'manage'),
        await owns('db:organization', 'o1'),
      ),
    ).rejects.toThrow();
  });
});
