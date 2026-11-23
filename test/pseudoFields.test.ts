import { describe, expect, test } from 'bun:test';
import type { AnnoValue, FieldMap, ScalarType } from '@inixiative/field-map';
import type { Condition } from '@inixiative/json-rules';
import {
  type ActionRule,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  pseudoRecordsOfEntitlement,
  type Row,
  type SchemaMap,
  validateSchema,
} from '../index';
import { createHydratorReadingEachRowThroughLoad } from './createHydratorReadingEachRowThroughLoad';
import { annotate, loadModels } from './fixtures/load';
import { canGrantWithRules, checkWithRules, mapWith, type Rules, stringColumn } from './schemaMaps';

// Kingdom's surface → integrationResource → integration slice (schemas/kingdom.prisma), read by
// field-map. `IntegrationResource.kind` and `.enabled` read `/// @permissions(pseudoField: true)`.
const models = loadModels('kingdom');
const mapOver = (over: typeof models): SchemaMap => ({
  permissions: {},
  maps: { db: { models: over } },
});
const withPseudoFields = mapOver(models);
const withoutPseudoFields = mapOver(
  annotate(annotate(models, 'IntegrationResource', 'kind'), 'IntegrationResource', 'enabled'),
);

const equals = (field: string, value: unknown) =>
  ({ field, operator: 'equals', value }) as Condition;

// The surface rule in one form: it reads the resource's own `kind` and `enabled`. `at` is where the
// resource sits on the surface record.
const operates = (at: string): ActionRule => ({
  all: [
    { rel: at, action: 'operate' },
    {
      rule: {
        all: [
          equals(`${at}.kind`, 'channel'),
          equals(`${at}.integration.provider`, 'slack'),
          equals(`${at}.enabled`, true),
          equals(`${at}.integration.enabled`, true),
        ],
      },
    },
  ],
});

const schemaWith = (every: ActionRule): Rules => ({
  permissions: {
    'db:Organization': { actions: { own: null, manage: 'own' } },
    'db:Project': {
      actions: { manage: { rel: 'organization', action: 'manage' }, read: 'manage' },
    },
    'db:Integration': {
      actions: { manage: { rel: 'organization', action: 'manage' }, operate: 'manage' },
    },
    'db:IntegrationResource': {
      actions: {
        manage: { rel: 'integration', action: 'manage' },
        operate: { rel: 'integration', action: 'operate' },
      },
    },
    'db:ProjectIntegrationResource': { actions: { read: { rel: 'project', action: 'read' } } },
    'db:SlackChannelOperation': { actions: { '*': every, 'message.send': '*' } },
  },
});
const schema = schemaWith(operates('integrationResource'));

const o1 = { id: 'o1' };
const integration = (id: string, provider = 'slack'): Row => ({
  id,
  organizationId: 'o1',
  provider,
  enabled: true,
  deletedAt: null,
  organization: o1,
});
const i1 = integration('i1');
const resource = (id: string, of: Row, kind = 'channel', enabled = true): Row => ({
  id,
  integrationId: of.id,
  kind,
  enabled,
  integration: of,
});
const call = (of: Row, link?: Row): Row => ({
  operation: 'message.send',
  integrationResourceId: of.id,
  integrationResource: of,
  ...(link ? { projectIntegrationResourceId: link.id, projectIntegrationResource: link } : {}),
});

const holding = async (...grants: [string, string, string][]) => {
  const permix = createPermissions();
  await permix.setup(
    grants.map(([on, id, action]) => ({ resource: on, id, actions: { [action]: true } })),
  );
  return permix;
};
const orgOwner = () => holding(['db:Organization', 'o1', 'own']);

const everyChannel: EntitlementEntry = {
  resource: 'db:SlackChannelOperation',
  anchor: { resource: 'db:Integration', id: 'i1', path: 'integrationResource.integration' },
  where: {
    all: [
      equals('integrationResource.kind', 'channel'),
      equals('integrationResource.enabled', true),
    ],
  },
  actions: { '*': true },
};
const pseudoRecordsOn = (map: SchemaMap, entry: EntitlementEntry, anchor: Row = i1) =>
  pseudoRecordsOfEntitlement(map, entry, anchor) as Row[];
const granted = async (map: SchemaMap, rules: Rules, entry: EntitlementEntry, anchor = i1) => {
  const writer = await orgOwner();
  const canGrant = canGrantWithRules(map);
  return pseudoRecordsOn(map, entry, anchor).every((record) =>
    canGrant(writer, rules, entry, record),
  );
};

describe('Kingdom’s wide row: every channel of integration i1', () => {
  test('the one-form schema validates', () => {
    expect(validateSchema(mapWith(withPseudoFields, schema))).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
  });

  test('with the pseudo fields, the values the where requires join the pseudo record', () => {
    expect(pseudoRecordsOn(withPseudoFields, everyChannel)).toEqual([
      {
        integrationResource: {
          kind: 'channel',
          enabled: true,
          integrationId: 'i1',
          integration: i1,
        },
      },
    ]);
  });

  test('granted with the pseudo fields, refused without; no copied root scalars anywhere', async () => {
    expect(await granted(withPseudoFields, schema, everyChannel)).toBe(true);
    expect(pseudoRecordsOn(withoutPseudoFields, everyChannel)).toEqual([
      { integrationResource: { integrationId: 'i1', integration: i1 } },
    ]);
    expect(await granted(withoutPseudoFields, schema, everyChannel)).toBe(false);
    const fields = Object.keys(models.SlackChannelOperation?.fields ?? {});
    expect(fields).not.toContain('resourceKind');
    expect(fields).not.toContain('resourceEnabled');
  });

  test('a writer with no hold on the integration is refused either way', async () => {
    const canGrant = canGrantWithRules(withPseudoFields);
    const stranger = await holding(['db:Organization', 'o2', 'own']);
    const [pseudoRecord] = pseudoRecordsOn(withPseudoFields, everyChannel);
    expect(canGrant(stranger, schema, everyChannel, pseudoRecord as Row)).toBe(false);
  });

  test('at read the nested `where` is judged on the real resource', async () => {
    const check = checkWithRules(withPseudoFields);
    const holder = createPermissions();
    await holder.setup([everyChannel], { owner: await orgOwner() });
    const on = (record: Row) => ({ resource: 'db:SlackChannelOperation', record });
    expect(check(holder, schema, on(call(resource('r1', i1))), 'message.send')).toBe(true);
    expect(check(holder, schema, on(call(resource('r2', i1, 'user'))), 'message.send')).toBe(false);
    expect(
      check(holder, schema, on(call(resource('r3', i1, 'channel', false))), 'message.send'),
    ).toBe(false);
    expect(check(holder, schema, on(call(resource('r4', integration('i2')))), 'message.send')).toBe(
      false,
    );
  });

  test('stating only the kind leaves `enabled` unknown: refused', async () => {
    const entry = { ...everyChannel, where: equals('integrationResource.kind', 'channel') };
    expect(await granted(withPseudoFields, schema, entry)).toBe(false);
  });
});

describe('what fills a stand-in, and what never does', () => {
  const withWhere = (where: Condition): EntitlementEntry => ({ ...everyChannel, where });
  const standIn = (map: SchemaMap, where: Condition, anchor: Row = i1) =>
    (pseudoRecordsOn(map, withWhere(where), anchor)[0] as Row).integrationResource as Row;

  test('only a root conjunct: a leaf inside `any` is not true of every admitted record', () => {
    const where = {
      any: [
        equals('integrationResource.kind', 'channel'),
        equals('integrationResource.kind', 'user'),
      ],
    } as Condition;
    expect(standIn(withPseudoFields, where)).not.toHaveProperty('kind');
  });

  test('only a literal `equals`: no options, no other operator, no path', () => {
    for (const leaf of [
      {
        field: 'integrationResource.kind',
        operator: 'equals',
        value: 'channel',
        caseInsensitive: true,
      },
      { field: 'integrationResource.kind', operator: 'in', value: ['channel'] },
      {
        all: [
          { field: 'integrationResource.kind', operator: 'exists' },
          { field: 'integrationResource.kind', operator: 'equals', path: 'channel' },
        ],
      },
    ])
      expect(standIn(withPseudoFields, leaf as Condition)).not.toHaveProperty('kind');
  });

  test('an withoutPseudoFields nested field stays unknown', () => {
    expect(
      standIn(withPseudoFields, equals('integrationResource.name', 'general')),
    ).not.toHaveProperty('name');
  });

  test('the anchor and the rows above it are real and never written', () => {
    const provider = mapOver(annotate(models, 'Integration', 'provider', { pseudoField: true }));
    const linear = integration('i1', 'linear');
    const frozen = structuredClone(linear);
    const [pseudoRecord] = pseudoRecordsOn(
      provider,
      withWhere(equals('integrationResource.integration.provider', 'slack')),
      linear,
    );
    expect(((pseudoRecord as Row).integrationResource as Row).integration).toBe(linear);
    expect(linear).toEqual(frozen);
  });

  test('a leaf through a relation that is not the entry’s path fills nothing', () => {
    const [pseudoRecord] = pseudoRecordsOn(
      withPseudoFields,
      withWhere(equals('projectIntegrationResource.id', 'pir1')),
    );
    expect(pseudoRecord).toEqual({ integrationResource: { integrationId: 'i1', integration: i1 } });
  });

  test('each call builds its own stand-ins: one grant’s value never reaches another’s', () => {
    const channel = standIn(withPseudoFields, equals('integrationResource.kind', 'channel'));
    const user = standIn(withPseudoFields, equals('integrationResource.kind', 'user'));
    const none = standIn(withPseudoFields, equals('integrationResource.name', 'x'));
    expect([channel.kind, user.kind, none.kind]).toEqual(['channel', 'user', undefined]);
    expect(channel.integration).toBe(i1);
    expect(i1).toEqual(integration('i1'));
  });

  test('the root keeps today’s rule: any exact `equals` on the root is copied, pseudo field or not', () => {
    const [pseudoRecord] = pseudoRecordsOn(withPseudoFields, withWhere(equals('channel', 'C1')));
    expect((pseudoRecord as Row).channel).toBe('C1');
  });
});

describe('where the annotation is refused, when the map is first used', () => {
  const boot =
    (model: string, field: string, value: AnnoValue = true, base = models) =>
    () =>
      createRebacCheck({
        ...mapOver(annotate(base, model, field, { pseudoField: value })),
        permissions: {},
      });

  test('keys, ids, dates, Json, relations, and anything but `true`', () => {
    expect(boot('IntegrationResource', 'integrationId')).toThrow(/never sits on a relation key/);
    expect(boot('IntegrationResource', 'id')).toThrow(/never sits on an id/);
    expect(boot('Integration', 'deletedAt')).toThrow(/not DateTime/);
    expect(boot('IntegrationResource', 'metadata')).toThrow(/not Json/);
    expect(boot('IntegrationResource', 'integration')).toThrow(/sits on a scalar or enum field/);
    expect(boot('IntegrationResource', 'projects')).toThrow(/sits on a scalar or enum field/);
    expect(boot('IntegrationResource', 'kind', 'yes')).toThrow(/is true or absent/);
    expect(boot('IntegrationResource', 'kind', false)).toThrow(/is true or absent/);
    expect(boot('IntegrationResource', 'name')).not.toThrow();
  });

  test('a discriminator, a list, Float and Decimal', () => {
    const scalar = (type: ScalarType, isList = false) => ({
      kind: 'scalar' as const,
      type,
      isList,
    });
    const fieldMap: FieldMap = {
      models: {
        Thing: {
          fields: {
            id: scalar('String'),
            ownerModel: scalar('String'),
            tags: scalar('String', true),
            ratio: scalar('Float'),
            price: scalar('Decimal'),
            tier: { kind: 'enum', type: 'Tier' },
          },
        },
      },
    };
    const thing = (field: string) => () =>
      createRebacCheck({
        maps: { db: { models: annotate(fieldMap.models, 'Thing', field, { pseudoField: true }) } },
        polymorphism: { db: { Thing: { axes: [{ field: 'ownerModel', fkMap: {} }] } } },
        permissions: {},
      });
    expect(thing('ownerModel')).toThrow(/never sits on a discriminator/);
    expect(thing('tags')).toThrow(/never sits on a list/);
    expect(thing('ratio')).toThrow(/not Float/);
    expect(thing('price')).toThrow(/not Decimal/);
    expect(thing('tier')).not.toThrow();
  });
});

describe('a polymorphic stand-in: the pseudo field joins it, the path still sets its kind and keys', () => {
  const scalar = stringColumn;
  const toOne = (type: string, fromFields: string[], toFields: string[]) =>
    ({ kind: 'object', type, isList: false, fromFields, toFields }) as const;
  const map: SchemaMap = {
    permissions: {},
    maps: {
      db: {
        models: {
          Organization: { fields: { id: scalar } },
          Space: {
            fields: {
              id: scalar,
              organizationId: scalar,
              organization: toOne('Organization', ['organizationId'], ['id']),
            },
          },
          Integration: {
            fields: {
              id: scalar,
              ownerModel: scalar,
              organizationId: scalar,
              spaceId: scalar,
              status: { ...scalar, annotations: { permissions: { pseudoField: true } } },
              organization: toOne('Organization', ['organizationId'], ['id']),
              space: toOne('Space', ['organizationId', 'spaceId'], ['organizationId', 'id']),
            },
          },
          Webhook: {
            fields: {
              id: scalar,
              integrationId: scalar,
              integration: toOne('Integration', ['integrationId'], ['id']),
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
              fkMap: { Organization: ['organizationId'], Space: ['organizationId', 'spaceId'] },
            },
          ],
        },
      },
    },
  };

  test('status is filled; ownerModel and the keys come from the path, whatever the where says', () => {
    const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
    const entry: EntitlementEntry = {
      resource: 'db:Webhook',
      anchor: { resource: 'db:Space', id: 's1', path: 'integration.space' },
      where: {
        all: [
          equals('integration.status', 'active'),
          equals('integration.ownerModel', 'Organization'),
          equals('integration.spaceId', 's9'),
        ],
      },
      actions: { manage: true },
    };
    const [pseudoRecord] = pseudoRecordsOfEntitlement(map, entry, s1) as Row[];
    expect((pseudoRecord as Row).integration).toEqual({
      status: 'active',
      ownerModel: 'Space',
      organizationId: 'o1',
      spaceId: 's1',
      space: s1,
    });
  });
});

const p1 = { id: 'p1', organizationId: 'o1', organization: o1 };
const p2 = { id: 'p2', organizationId: 'o1', organization: o1 };
const r1 = resource('r1', i1);
const r2 = resource('r2', i1);
const link = (id: string, project: Row, of: Row): Row => ({
  id,
  projectId: project.id,
  integrationResourceId: of.id,
  project,
  integrationResource: of,
});
const pir1 = link('pir1', p1, r1);
// The entry: no `where`, no part A, no part B. The surface record of a call made in a project
// carries the join row it acts through as a to-one, `projectIntegrationResource`.
const atJoinRow: EntitlementEntry = {
  resource: 'db:SlackChannelOperation',
  anchor: {
    resource: 'db:ProjectIntegrationResource',
    id: 'pir1',
    path: 'projectIntegrationResource',
  },
  actions: { '*': true },
};
// The surface rule with a second arm that reaches the resource through the link.
const linked = schemaWith({
  any: [
    operates('integrationResource'),
    operates('projectIntegrationResource.integrationResource'),
  ],
});

describe('Kingdom’s project scope: a grant anchored at the project-resource join row', () => {
  test('the stand-in is a call through that link; everything the rule reads is a real row', () => {
    expect(pseudoRecordsOn(withPseudoFields, atJoinRow, pir1)).toEqual([
      { projectIntegrationResourceId: 'pir1', projectIntegrationResource: pir1 },
    ]);
  });

  test('refused under the one-form rule: the stand-in’s own `integrationResource` is unknown', async () => {
    expect(await granted(withPseudoFields, schema, atJoinRow, pir1)).toBe(false);
  });

  test('granted once the rule reaches the resource through the link; pseudo fields play no part', async () => {
    expect(validateSchema(mapWith(withPseudoFields, linked))).toEqual({
      ok: true,
      errors: [],
      warnings: [],
    });
    expect(await granted(withPseudoFields, linked, atJoinRow, pir1)).toBe(true);
    expect(await granted(withoutPseudoFields, linked, atJoinRow, pir1)).toBe(true);
    const canGrant = canGrantWithRules(withPseudoFields);
    const projectOnly = await holding(['db:Project', 'p1', 'manage']);
    const [pseudoRecord] = pseudoRecordsOn(withPseudoFields, atJoinRow, pir1);
    expect(canGrant(projectOnly, linked, atJoinRow, pseudoRecord as Row)).toBe(false);
  });

  test('it reaches calls on that resource made through that link, and nothing else', async () => {
    const check = checkWithRules(withPseudoFields);
    const holder = createPermissions();
    await holder.setup([atJoinRow], { owner: await orgOwner() });
    const sends = (record: Row) =>
      check(holder, linked, { resource: 'db:SlackChannelOperation', record }, 'message.send');
    expect(sends(call(r1, pir1))).toBe(true);
    expect(sends(call(r1))).toBe(false);
    expect(sends(call(r1, link('pir2', p2, r1)))).toBe(false);
    expect(sends(call(r2, link('pir3', p1, r2)))).toBe(false);
  });

  test('anchored at the project instead ("everything in p1"): reads work, but no table can grant it', async () => {
    const wholeProject: EntitlementEntry = {
      resource: 'db:SlackChannelOperation',
      anchor: {
        resource: 'db:Project',
        id: 'p1',
        path: 'projectIntegrationResource.project',
      },
      actions: { '*': true },
    };
    expect(pseudoRecordsOn(withPseudoFields, wholeProject, p1)).toEqual([
      { projectIntegrationResource: { projectId: 'p1', project: p1 } },
    ]);
    expect(await granted(withPseudoFields, linked, wholeProject, p1)).toBe(false);
    const stated = {
      ...wholeProject,
      where: {
        all: [
          equals('projectIntegrationResource.integrationResource.kind', 'channel'),
          equals('projectIntegrationResource.integrationResource.enabled', true),
        ],
      } as Condition,
    };
    expect(await granted(withPseudoFields, linked, stated, p1)).toBe(false);
    const check = checkWithRules(withPseudoFields);
    const holder = createPermissions();
    await holder.setup([wholeProject], { owner: await orgOwner() });
    const sends = (record: Row) =>
      check(holder, linked, { resource: 'db:SlackChannelOperation', record }, 'message.send');
    expect(sends(call(r1, pir1))).toBe(true);
    expect(sends(call(r2, link('pir3', p1, r2)))).toBe(true);
    expect(sends(call(r1, link('pir2', p2, r1)))).toBe(false);
  });
});

// The adversarial review's reproductions for part B and the project scope.
describe('a pseudo field the where requires twice', () => {
  const kinds = (...stated: string[]): EntitlementEntry => ({
    ...everyChannel,
    where: {
      all: [
        ...stated.map((kind) => equals('integrationResource.kind', kind)),
        equals('integrationResource.enabled', true),
      ],
    } as Condition,
  });
  const standIn = (entry: EntitlementEntry) =>
    (pseudoRecordsOn(withPseudoFields, entry)[0] as Row).integrationResource as Row;

  test('two different values leave the field unknown, in either order: refused', async () => {
    for (const entry of [kinds('user', 'channel'), kinds('channel', 'user')]) {
      expect(standIn(entry)).not.toHaveProperty('kind');
      expect(standIn(entry).enabled).toBe(true);
      expect(await granted(withPseudoFields, schema, entry)).toBe(false);
    }
  });

  test('the same value twice is one statement: a narrowed copy still pins it', async () => {
    expect(standIn(kinds('channel', 'channel')).kind).toBe('channel');
    expect(await granted(withPseudoFields, schema, kinds('channel', 'channel'))).toBe(true);
  });

  test('the root follows the same rule', () => {
    const root = (...channels: string[]): Row =>
      pseudoRecordsOn(withPseudoFields, {
        ...everyChannel,
        where: { all: channels.map((channel) => equals('channel', channel)) } as Condition,
      })[0] as Row;
    expect(root('C1', 'C2')).not.toHaveProperty('channel');
    expect(root('C2', 'C1')).not.toHaveProperty('channel');
    expect(root('C1', 'C1').channel).toBe('C1');
  });

  test('a mark takes a scalar value only', () => {
    for (const value of [['channel'], { is: 'channel' }])
      expect(
        standIn({ ...everyChannel, where: equals('integrationResource.kind', value) }),
      ).not.toHaveProperty('kind');
  });
});

describe('a project scope: a join-row entry and an anchor through the link', () => {
  const viaLink = 'projectIntegrationResource.integrationResource';
  const foreign = resource('r9', {
    ...integration('i9'),
    organizationId: 'o2',
    organization: { id: 'o2' },
  });
  const through = (via: Row): Row => ({
    operation: 'message.send',
    projectIntegrationResourceId: via.id,
    projectIntegrationResource: via,
  });
  const sendsAs = async (entry: EntitlementEntry) => {
    const check = checkWithRules(withPseudoFields);
    const holder = createPermissions();
    await holder.setup([entry], { owner: await orgOwner() });
    return (record: Row) =>
      check(holder, linked, { resource: 'db:SlackChannelOperation', record }, 'message.send');
  };

  // B-2: the rule cannot tie the two carriers together on a stand-in, so the surface record must
  // derive its direct resource from the link it carries. This pins what a record that does not
  // do so is admitted as.
  test('a join-row entry judges the link: a record carrying another direct resource passes', async () => {
    const sends = await sendsAs(atJoinRow);
    expect(sends(call(r1, pir1))).toBe(true);
    expect(sends(call(r2, pir1))).toBe(true);
    expect(sends(call(foreign, pir1))).toBe(true);
    expect(sends(through(pir1))).toBe(true);
  });

  const inProject: EntitlementEntry = {
    resource: 'db:SlackChannelOperation',
    anchor: { resource: 'db:Integration', id: 'i1', path: `${viaLink}.integration` },
    where: {
      all: [
        equals(`${viaLink}.kind`, 'channel'),
        equals(`${viaLink}.enabled`, true),
        equals('projectIntegrationResource.projectId', 'p1'),
      ],
    } as Condition,
    actions: { '*': true },
  };

  test('a project scope anchors at the integration, through the link: the marks fill two levels down', async () => {
    expect(pseudoRecordsOn(withPseudoFields, inProject)).toEqual([
      {
        projectIntegrationResource: {
          integrationResource: {
            kind: 'channel',
            enabled: true,
            integrationId: 'i1',
            integration: i1,
          },
        },
      },
    ]);
    expect(await granted(withPseudoFields, linked, inProject)).toBe(true);
    expect(await granted(withoutPseudoFields, linked, inProject)).toBe(false);
    const canGrant = canGrantWithRules(withPseudoFields);
    const projectOnly = await holding(['db:Project', 'p1', 'manage']);
    for (const pseudoRecord of pseudoRecordsOn(withPseudoFields, inProject))
      expect(canGrant(projectOnly, linked, inProject, pseudoRecord)).toBe(false);
  });

  test('at read it follows the project’s links live, and nothing outside the project or the kind', async () => {
    const sends = await sendsAs(inProject);
    expect(sends(through(link('a', p1, r1)))).toBe(true);
    expect(sends(through(link('b', p1, r2)))).toBe(true);
    expect(sends(through(link('c', p2, r1)))).toBe(false);
    expect(sends(call(r1))).toBe(false);
    expect(sends(through(link('d', p1, resource('r3', i1, 'user'))))).toBe(false);
    expect(sends(through(link('e', p1, foreign)))).toBe(false);
  });
});

describe('a junction list: a resource is reached through a project it is attached to', () => {
  const junction = mapOver(
    annotate(models, 'IntegrationResource', 'projects', { down: ['project.organization'] }),
  );
  const inProject: ActionRule = {
    rel: 'projects',
    arrayOperator: 'any',
    condition: { rel: 'project', action: 'read' },
  };
  const rules: Rules = {
    permissions: {
      ...schema.permissions,
      'db:IntegrationResource': {
        actions: { operate: { rel: 'integration', action: 'operate' }, read: inProject },
      },
    },
  };
  const rows: Record<string, Row[]> = {
    'db:Organization': [o1, { id: 'o2' }],
    'db:IntegrationResource': [{ id: 'r1' }, { id: 'r2' }],
    'db:Project': [
      { id: 'p1', organizationId: 'o1' },
      { id: 'p2', organizationId: 'o2' },
    ],
    'db:ProjectIntegrationResource': [
      { id: 'l1', projectId: 'p1', integrationResourceId: 'r1' },
      { id: 'l2', projectId: 'p2', integrationResourceId: 'r2' },
    ],
  };
  const matches = (where: Row) => (row: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const hydrate = createHydratorReadingEachRowThroughLoad({
    map: junction,
    load: async (of, where) => rows[of]?.find(matches(where)) ?? null,
    loadItems: async (of, where) => rows[of]?.filter(matches(where)) ?? [],
  });
  const read = async (permix: Awaited<ReturnType<typeof holding>>, id: string) =>
    checkWithRules(junction)(
      permix,
      rules,
      {
        resource: 'db:IntegrationResource',
        record: await hydrate('db:IntegrationResource', { id }),
      },
      'read',
    );

  test('the declaration carries what the rule walks, and a shorter one is reported', () => {
    expect(validateSchema(mapWith(junction, rules)).errors).toEqual([]);
    const short = mapOver(
      annotate(models, 'IntegrationResource', 'projects', { down: ['project'] }),
    );
    expect(validateSchema(mapWith(short, rules)).errors.map((issue) => issue.code)).toEqual([
      'down',
    ]);
  });

  test('a role on the project, or above it, reads the resources attached to it and no others', async () => {
    const onProject = await holding(['db:Project', 'p1', 'read']);
    expect(await read(onProject, 'r1')).toBe(true);
    expect(await read(onProject, 'r2')).toBe(false);
    expect(await read(await orgOwner(), 'r1')).toBe(true);
    expect(await read(await orgOwner(), 'r2')).toBe(false);
    expect(await read(onProject, 'r-unattached')).toBe(false);
  });
});
