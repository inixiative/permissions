import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import { Operator } from '@inixiative/json-rules';
import {
  createPermissions,
  type EntitlementEntry,
  type PermissionEntry,
  pseudoRecordsBelowAnchor,
  pseudoRecordsOfEntitlement,
  type Row,
  type SchemaMap,
} from '../index';
import {
  canGrantWithRules,
  checkWithRules,
  type Rules,
  stringColumn as scalar,
} from './schemaMaps';

const toOne = (type: string, fromFields: string[], toFields: string[]) =>
  ({ kind: 'object', type, isList: false, fromFields, toFields }) as const;

const fieldMap: FieldMap = {
  models: {
    Organization: { fields: { id: scalar, name: scalar } },
    Space: {
      fields: {
        id: scalar,
        organizationId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
      },
    },
    OrganizationUser: {
      fields: {
        id: scalar,
        organizationId: scalar,
        userId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
      },
    },
    SpaceUser: {
      fields: {
        id: scalar,
        organizationId: scalar,
        spaceId: scalar,
        userId: scalar,
        space: toOne('Space', ['organizationId', 'spaceId'], ['organizationId', 'id']),
        organizationUser: toOne(
          'OrganizationUser',
          ['organizationId', 'userId'],
          ['organizationId', 'userId'],
        ),
      },
    },
    Integration: {
      fields: {
        id: scalar,
        ownerModel: scalar,
        organizationId: scalar,
        spaceId: scalar,
        userId: scalar,
        organization: toOne('Organization', ['organizationId'], ['id']),
        space: toOne('Space', ['organizationId', 'spaceId'], ['organizationId', 'id']),
        organizationUser: toOne(
          'OrganizationUser',
          ['organizationId', 'userId'],
          ['organizationId', 'userId'],
        ),
        spaceUser: toOne(
          'SpaceUser',
          ['organizationId', 'spaceId', 'userId'],
          ['organizationId', 'spaceId', 'userId'],
        ),
      },
    },
  },
};

const map: SchemaMap = {
  permissions: {},
  maps: { db: fieldMap },
  polymorphism: {
    db: {
      Integration: {
        axes: [
          {
            field: 'ownerModel',
            fkMap: {
              Organization: ['organizationId'],
              Space: ['organizationId', 'spaceId'],
              OrganizationUser: ['organizationId', 'userId'],
              SpaceUser: ['organizationId', 'spaceId', 'userId'],
            },
          },
        ],
      },
    },
  },
};

const kindIs = (value: string) => ({
  rule: { field: 'ownerModel', operator: Operator.equals, value },
});

const schema: Rules = {
  permissions: {
    'db:Organization': { actions: { own: null, manage: 'own' } },
    'db:Space': { actions: { own: { rel: 'organization', action: 'own' }, manage: 'own' } },
    'db:OrganizationUser': { actions: { own: { rel: 'organization', action: 'own' } } },
    'db:SpaceUser': { actions: { own: { rel: 'space', action: 'own' } } },
    'db:Integration': {
      actions: {
        manage: {
          any: [
            { all: [kindIs('Organization'), { rel: 'organization', action: 'manage' }] },
            { all: [kindIs('Space'), { rel: 'space', action: 'manage' }] },
            { all: [kindIs('OrganizationUser'), { rel: 'organizationUser', action: 'own' }] },
            { all: [kindIs('SpaceUser'), { rel: 'spaceUser', action: 'own' }] },
          ],
        },
      },
    },
  },
};

const check = checkWithRules(map);
const canGrant = canGrantWithRules(map);

const organizationOf = (id: string) => ({ id });
const o1 = organizationOf('o1');
const o2 = organizationOf('o2');
const spaceOf = (id: string, organization: Row) => ({
  id,
  organizationId: organization.id,
  organization,
});
const s1 = spaceOf('s1', o1);

const integrationsUnder = (organization: Row) => {
  const space = spaceOf(`s-${organization.id}`, organization);
  const member = { id: 'ou', organizationId: organization.id, userId: 'u1', organization };
  const spaceMember = {
    id: 'su',
    organizationId: organization.id,
    spaceId: space.id,
    userId: 'u1',
    space,
  };
  const base = { organizationId: organization.id, organization };
  return {
    Organization: { ...base, id: 'i-org', ownerModel: 'Organization' },
    Space: { ...base, id: 'i-space', ownerModel: 'Space', spaceId: space.id, space },
    OrganizationUser: {
      ...base,
      id: 'i-member',
      ownerModel: 'OrganizationUser',
      userId: 'u1',
      organizationUser: member,
    },
    SpaceUser: {
      ...base,
      id: 'i-space-member',
      ownerModel: 'SpaceUser',
      spaceId: space.id,
      userId: 'u1',
      space,
      spaceUser: spaceMember,
    },
  };
};

const table = async (actions: string[]) => {
  const permix = createPermissions();
  await permix.setup({
    resource: 'db:Organization',
    id: 'o1',
    actions: Object.fromEntries(actions.map((action) => [action, true])),
  } as PermissionEntry);
  return permix;
};
const owner = () => table(['own']);
const admin = () => table(['manage']);

const underO1 = (where?: EntitlementEntry['where']): EntitlementEntry => ({
  resource: 'db:Integration',
  anchor: { resource: 'db:Organization', id: 'o1', path: 'organization' },
  actions: { manage: true },
  ...(where ? { where } : {}),
});
const theOrganizations = () =>
  underO1({ field: 'ownerModel', operator: 'equals', value: 'Organization' } as never);

const may = async (writer: Awaited<ReturnType<typeof table>>, entry: EntitlementEntry) => {
  const pseudoRecord = pseudoRecordsOfEntitlement(map, entry, o1);
  return pseudoRecord?.every((record) => canGrant(writer, schema, entry, record));
};

const holderOf = async (entry: EntitlementEntry) => {
  const holder = createPermissions();
  await holder.setup([entry], { owner: await owner() });
  return holder;
};

describe('an anchor path names the anchor and the axis; every kind on it is reached (R81)', () => {
  test('under o1: all four kinds of integration, none under o2', async () => {
    const holder = await holderOf(underO1());
    for (const record of Object.values(integrationsUnder(o1)))
      expect(check(holder, schema, { resource: 'db:Integration', record }, 'manage')).toBe(true);
    for (const record of Object.values(integrationsUnder(o2)))
      expect(check(holder, schema, { resource: 'db:Integration', record }, 'manage')).toBe(false);
  });

  test("the where narrows the kinds: ownerModel = Organization reaches the organization's own only", async () => {
    const holder = await holderOf(theOrganizations());
    const reached = Object.entries(integrationsUnder(o1))
      .filter(([, record]) =>
        check(holder, schema, { resource: 'db:Integration', record }, 'manage'),
      )
      .map(([kind]) => kind);
    expect(reached).toEqual(['Organization']);
  });
});

describe('held entitlements never combine: to grant two, grant two (R101, R103)', () => {
  test("holding the organization's own and the members' does not grant both in one entry", async () => {
    const kindsIn = (...values: string[]) =>
      underO1({ field: 'ownerModel', operator: 'in', value: values } as never);
    const writer = createPermissions();
    await writer.setup([kindsIn('Organization'), kindsIn('OrganizationUser')], {
      owner: await owner(),
    });
    expect(await may(writer, kindsIn('Organization'))).toBe(true);
    expect(await may(writer, kindsIn('Organization', 'OrganizationUser'))).toBe(false);
  });
});

describe('a holder grants what it holds onward, and no more', () => {
  const holdingAdmin = async (held: EntitlementEntry) => {
    const writer = await admin();
    await writer.setup([held], { owner: await owner() });
    return writer;
  };

  test('an admin holding every kind under o1 grants every kind under o1', async () => {
    expect(await may(await admin(), underO1())).toBe(false);
    expect(await may(await holdingAdmin(underO1()), underO1())).toBe(true);
  });

  test("an admin holding the organization's own does not grant every kind", async () => {
    const writer = await holdingAdmin(theOrganizations());
    expect(await may(writer, theOrganizations())).toBe(true);
    expect(pseudoRecordsOfEntitlement(map, underO1(), o1)).toHaveLength(4);
    expect(await may(writer, underO1())).toBe(false);
  });
});

describe('the grant is judged on one pseudo record per kind the entry admits (R81)', () => {
  test('unfiltered: four pseudo records, each owner pseudoRecord under the anchor', () => {
    const pseudoRecord = pseudoRecordsOfEntitlement(map, underO1(), o1);
    expect(pseudoRecord?.map((record) => record.ownerModel)).toEqual([
      'Organization',
      'Space',
      'OrganizationUser',
      'SpaceUser',
    ]);
    expect(pseudoRecord?.[1]).toEqual({
      ownerModel: 'Space',
      organizationId: 'o1',
      organization: o1,
      space: { organizationId: 'o1', organization: o1 },
    });
  });

  test('the owner grants it unfiltered; an admin does not', async () => {
    expect(await may(await owner(), underO1())).toBe(true);
    expect(await may(await admin(), underO1())).toBe(false);
  });

  test("an admin grants it narrowed to the organization's own", async () => {
    expect(pseudoRecordsOfEntitlement(map, theOrganizations(), o1)?.length).toBe(1);
    expect(await may(await admin(), theOrganizations())).toBe(true);
  });

  test('anchored at a space: the kinds that carry its keys, a space and its members', () => {
    const atSpace: EntitlementEntry = {
      resource: 'db:Integration',
      anchor: { resource: 'db:Space', id: 's1', path: 'space' },
      actions: { manage: true },
    };
    expect(
      pseudoRecordsOfEntitlement(map, atSpace, s1)?.map((record) => record.ownerModel),
    ).toEqual(['Space', 'SpaceUser']);
  });
});

describe('an owner is pseudoRecord under every record above it, not only its parent', () => {
  test("via organizationUser.organization: a space member's integration sits under its member and its space", async () => {
    const members: EntitlementEntry = {
      resource: 'db:Integration',
      anchor: { resource: 'db:Organization', id: 'o1', path: 'organizationUser.organization' },
      actions: { manage: true },
    };
    const pseudoRecord = pseudoRecordsOfEntitlement(map, members, o1);
    expect(pseudoRecord?.map((record) => record.ownerModel)).toEqual([
      'OrganizationUser',
      'SpaceUser',
    ]);
    const spaceMember = pseudoRecord?.[1]?.spaceUser as Row;
    expect(spaceMember.space).toEqual({ organizationId: 'o1', organization: o1 });
    expect(await may(await owner(), members)).toBe(true);
    expect(await may(await admin(), members)).toBe(false);
  });
});

describe('a kind whose owner cannot be pseudoRecord is still judged', () => {
  test('its record stays, the owner unknown, rather than the kind skipped', () => {
    const orphanMap: SchemaMap = {
      permissions: {},
      maps: {
        db: {
          models: {
            Organization: { fields: { id: scalar } },
            Widget: { fields: { id: scalar } },
            Thing: {
              fields: {
                ownerModel: scalar,
                organizationId: scalar,
                widgetId: scalar,
                organization: toOne('Organization', ['organizationId'], ['id']),
                widget: toOne('Widget', ['organizationId', 'widgetId'], ['organizationId', 'id']),
              },
            },
          },
        },
      },
      polymorphism: {
        db: {
          Thing: {
            axes: [
              {
                field: 'ownerModel',
                fkMap: { Organization: ['organizationId'], Widget: ['organizationId', 'widgetId'] },
              },
            ],
          },
        },
      },
    };
    const things: EntitlementEntry = {
      resource: 'db:Thing',
      anchor: { resource: 'db:Organization', id: 'o1', path: 'organization' },
      actions: { manage: true },
    };
    expect(
      pseudoRecordsOfEntitlement(orphanMap, things, o1)?.map((record) => record.ownerModel),
    ).toEqual(['Organization', 'Widget']);
  });
});

describe('the root of the where narrows the kinds: each leaf checked on each pseudo record (R88)', () => {
  const kinds = (where: EntitlementEntry['where']) =>
    pseudoRecordsOfEntitlement(map, underO1(where), o1)?.map((record) => record.ownerModel) ?? null;

  test('`in` keeps the kinds it names', () => {
    expect(
      kinds({ field: 'ownerModel', operator: 'in', value: ['Organization', 'Space'] } as never),
    ).toEqual(['Organization', 'Space']);
  });

  test('every leaf of a root `all` narrows', () => {
    expect(
      kinds({
        all: [
          { field: 'ownerModel', operator: 'in', value: ['Organization', 'Space'] },
          { field: 'ownerModel', operator: 'in', value: ['Space', 'SpaceUser'] },
        ],
      } as never),
    ).toEqual(['Space']);
  });

  test('a leaf on a field the pseudo record does not know narrows nothing', () => {
    expect(kinds({ field: 'provider', operator: 'equals', value: 'slack' } as never)).toEqual([
      'Organization',
      'Space',
      'OrganizationUser',
      'SpaceUser',
    ]);
  });

  test('a leaf whose value is read from a path narrows nothing', () => {
    expect(
      kinds({
        all: [
          { field: 'ownerModel', operator: 'exists' },
          { field: 'actor:Token.ownerModel', operator: 'exists' },
          { field: 'ownerModel', operator: 'equals', path: 'actor:Token.ownerModel' },
        ],
      } as never),
    ).toEqual(['Organization', 'Space', 'OrganizationUser', 'SpaceUser']);
  });

  test('a nested rule narrows nothing', () => {
    expect(
      kinds({
        any: [
          { field: 'ownerModel', operator: 'equals', value: 'Organization' },
          { field: 'ownerModel', operator: 'equals', value: 'Space' },
        ],
      } as never),
    ).toEqual(['Organization', 'Space', 'OrganizationUser', 'SpaceUser']);
    expect(
      kinds({
        all: [{ all: [{ field: 'ownerModel', operator: 'equals', value: 'Organization' }] }],
      } as never),
    ).toEqual(['Organization', 'Space', 'OrganizationUser', 'SpaceUser']);
  });

  test('a leaf on a key the path fixes narrows nothing: the path gives that key', () => {
    expect(kinds({ field: 'organizationId', operator: 'equals', value: 'o2' } as never)).toEqual([
      'Organization',
      'Space',
      'OrganizationUser',
      'SpaceUser',
    ]);
  });

  test('a dotted leaf under the kind field narrows nothing', () => {
    expect(kinds({ field: 'ownerModel.length', operator: 'equals', value: 5 } as never)).toEqual([
      'Organization',
      'Space',
      'OrganizationUser',
      'SpaceUser',
    ]);
  });

  test('an admin grants the kinds an `in` keeps when it holds each; not one more', async () => {
    const organizationsOnly = underO1({
      field: 'ownerModel',
      operator: 'in',
      value: ['Organization'],
    } as never);
    const withSpaces = underO1({
      field: 'ownerModel',
      operator: 'in',
      value: ['Organization', 'Space'],
    } as never);
    expect(await may(await admin(), organizationsOnly)).toBe(true);
    expect(await may(await admin(), withSpaces)).toBe(false);
    expect(await may(await owner(), withSpaces)).toBe(true);
  });
});

describe('a root leaf is judged only on the kind (R88 adversarial, R90)', () => {
  const kindsK = { field: 'ownerModel', operator: 'in', value: ['Organization', 'Space'] };
  const withK = (leaf: Row) => underO1({ all: [kindsK, leaf] } as never);

  test('a leaf on the pseudoRecord owner object narrows nothing', async () => {
    const leaf = {
      field: 'space',
      operator: 'equals',
      value: { id: 's1', organizationId: 'o1', organization: { id: 'o1' } },
    };
    expect(await may(await admin(), withK(leaf))).toBe(false);
  });

  test("a leaf on a copy of the anchor's columns inside the owner narrows nothing", async () => {
    const leaf = { field: 'space.organization.name', operator: 'equals', value: 'Later' };
    const pseudoRecord = pseudoRecordsOfEntitlement(map, withK(leaf), { ...o1, name: 'Now' });
    expect(pseudoRecord?.map((record) => record.ownerModel)).toEqual(['Organization', 'Space']);
  });

  const billing: SchemaMap = {
    ...map,
    maps: {
      db: {
        models: {
          ...fieldMap.models,
          Space: {
            fields: {
              ...fieldMap.models.Space?.fields,
              billingOrganizationId: scalar,
              billingOrganization: toOne('Organization', ['billingOrganizationId'], ['id']),
            },
          },
          Integration: {
            fields: {
              ...fieldMap.models.Integration?.fields,
              billingOrganizationId: scalar,
              space: toOne(
                'Space',
                ['organizationId', 'spaceId', 'billingOrganizationId'],
                ['organizationId', 'id', 'billingOrganizationId'],
              ),
            },
          },
        },
      },
    },
    polymorphism: {
      db: {
        Integration: {
          axes: [
            {
              field: 'ownerModel',
              fkMap: {
                Organization: ['organizationId'],
                Space: ['organizationId', 'spaceId', 'billingOrganizationId'],
              },
            },
          ],
        },
      },
    },
  };
  const kindsUnder = (where: Row) =>
    pseudoRecordsOfEntitlement(billing, underO1({ all: [kindsK, where] } as never), o1)?.map(
      (record) => record.ownerModel,
    );

  test('a leaf on a relation of the owner the path does not fix narrows nothing', () => {
    expect(
      kindsUnder({ field: 'space.billingOrganizationId', operator: 'equals', value: 'o9' }),
    ).toEqual(['Organization', 'Space']);
  });

  test('a leaf on a top-level key copied from the pseudoRecord owner narrows nothing', () => {
    expect(kindsUnder({ field: 'billingOrganizationId', operator: 'equals', value: 'o9' })).toEqual(
      ['Organization', 'Space'],
    );
  });
});

describe("on a multi-hop path only the kind narrows: the first step's parent is pseudoRecord, not fixed (R88 adversarial)", () => {
  const things: SchemaMap = {
    permissions: {},
    maps: {
      db: {
        models: {
          Organization: { fields: { id: scalar } },
          Widget: {
            fields: {
              id: scalar,
              organizationId: scalar,
              billingOrganizationId: scalar,
              organization: toOne('Organization', ['organizationId'], ['id']),
              billingOrganization: toOne('Organization', ['billingOrganizationId'], ['id']),
            },
          },
          Thing: {
            fields: {
              id: scalar,
              ownerModel: scalar,
              organizationId: scalar,
              widgetId: scalar,
              billingOrganizationId: scalar,
              organization: toOne('Organization', ['organizationId'], ['id']),
              widget: toOne(
                'Widget',
                ['organizationId', 'widgetId', 'billingOrganizationId'],
                ['organizationId', 'id', 'billingOrganizationId'],
              ),
            },
          },
          Item: {
            fields: {
              id: scalar,
              thingId: scalar,
              thingBillingOrganizationId: scalar,
              thing: toOne(
                'Thing',
                ['thingId', 'thingBillingOrganizationId'],
                ['id', 'billingOrganizationId'],
              ),
            },
          },
        },
      },
    },
    polymorphism: {
      db: {
        Thing: {
          axes: [
            {
              field: 'ownerModel',
              fkMap: {
                Organization: ['organizationId'],
                Widget: ['organizationId', 'widgetId', 'billingOrganizationId'],
              },
            },
          ],
        },
      },
    },
  };

  test("a leaf on a key the pseudoRecord parent's owner guessed narrows nothing", () => {
    const items: EntitlementEntry = {
      resource: 'db:Item',
      anchor: { resource: 'db:Organization', id: 'o1', path: 'thing.organization' },
      actions: { manage: true },
      where: { field: 'thingBillingOrganizationId', operator: 'equals', value: 'o9' } as never,
    };
    expect(pseudoRecordsOfEntitlement(things, items, o1)?.length).toBe(2);
  });
});

describe('pseudoRecordsBelowAnchor narrows by its where the way a grant does', () => {
  test('no where: every kind; a root kind leaf: the kinds it admits', () => {
    const under = (where?: EntitlementEntry['where']) =>
      pseudoRecordsBelowAnchor(
        map,
        'db:Integration',
        'organization',
        'db:Organization',
        o1,
        where,
      ).map((record) => record.ownerModel);
    expect(under()).toHaveLength(4);
    expect(
      under({ field: 'ownerModel', operator: 'equals', value: 'Organization' } as never),
    ).toEqual(['Organization']);
  });
});
