import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap } from '@inixiative/json-rules';
import {
  type ActionRule,
  createCanGrantEntitlement,
  createHydrator,
  createPermissions,
  createRebacCheck,
  type EntitlementEntry,
  placeEntitlement,
  type RebacSchema,
  type Row,
  type SchemaMap,
  validateSchema,
} from '../index';
import { annotate, loadModels } from './fixtures/load';

// Kingdom's surface → integrationResource → integration slice (schemas/kingdom.prisma), parsed by
// prisma-map. `IntegrationResource.kind` and `.enabled` read `/// @permissions(place: true)`.
const models = loadModels('kingdom');
const resources = {
  'db:organization': 'Organization',
  'db:project': 'Project',
  'db:integration': 'Integration',
  'db:integrationResource': 'IntegrationResource',
  'db:projectIntegrationResource': 'ProjectIntegrationResource',
  'slack:channel': 'SlackChannelOperation',
};
const mapOver = (over: typeof models): SchemaMap => ({ resources, fieldMap: { models: over } });
const marked = mapOver(models);
const unmarked = mapOver(
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
          equals(`${at}.integration.deletedAt`, null),
        ],
      },
    },
  ],
});

const schemaWith = (every: ActionRule): RebacSchema => ({
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own' } },
    'db:project': {
      actions: { manage: { rel: 'organization', action: 'manage' }, read: 'manage' },
    },
    'db:integration': {
      actions: { manage: { rel: 'organization', action: 'manage' }, operate: 'manage' },
    },
    'db:integrationResource': {
      actions: {
        manage: { rel: 'integration', action: 'manage' },
        operate: { rel: 'integration', action: 'operate' },
      },
    },
    'db:projectIntegrationResource': { actions: { read: { rel: 'project', action: 'read' } } },
    'slack:channel': { actions: { '*': every, 'message.send': '*' } },
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
const orgOwner = () => holding(['db:organization', 'o1', 'own']);

const everyChannel: EntitlementEntry = {
  resource: 'slack:channel',
  anchor: { resource: 'db:integration', id: 'i1', path: 'integrationResource.integration' },
  where: {
    all: [
      equals('integrationResource.kind', 'channel'),
      equals('integrationResource.enabled', true),
    ],
  },
  actions: { '*': true },
};
const placedOn = (map: SchemaMap, entry: EntitlementEntry, anchor: Row = i1) =>
  placeEntitlement(map, entry, anchor) as Row[];
const granted = async (
  map: SchemaMap,
  rules: RebacSchema,
  entry: EntitlementEntry,
  anchor = i1,
) => {
  const writer = await orgOwner();
  const canGrant = createCanGrantEntitlement(map);
  return placedOn(map, entry, anchor).every((record) => canGrant(writer, rules, entry, record));
};

describe('Kingdom’s wide row: every channel of integration i1', () => {
  test('the one-form schema validates', () => {
    expect(validateSchema(marked, schema)).toEqual({ ok: true, errors: [] });
  });

  test('with the marks, the stated values join the stand-in resource', () => {
    expect(placedOn(marked, everyChannel)).toEqual([
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

  test('granted with the marks, refused without; no copied root scalars anywhere', async () => {
    expect(await granted(marked, schema, everyChannel)).toBe(true);
    expect(placedOn(unmarked, everyChannel)).toEqual([
      { integrationResource: { integrationId: 'i1', integration: i1 } },
    ]);
    expect(await granted(unmarked, schema, everyChannel)).toBe(false);
    const fields = Object.keys(models.SlackChannelOperation?.fields ?? {});
    expect(fields).not.toContain('resourceKind');
    expect(fields).not.toContain('resourceEnabled');
  });

  test('a writer with no hold on the integration is refused either way', async () => {
    const canGrant = createCanGrantEntitlement(marked);
    const stranger = await holding(['db:organization', 'o2', 'own']);
    const [placed] = placedOn(marked, everyChannel);
    expect(canGrant(stranger, schema, everyChannel, placed as Row)).toBe(false);
  });

  test('at read the nested `where` is judged on the real resource', async () => {
    const check = createRebacCheck(marked);
    const holder = createPermissions();
    await holder.setup([everyChannel], { owner: await orgOwner() });
    const on = (record: Row) => ({ resource: 'slack:channel', record });
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
    expect(await granted(marked, schema, entry)).toBe(false);
  });
});

describe('what fills a stand-in, and what never does', () => {
  const withWhere = (where: Condition): EntitlementEntry => ({ ...everyChannel, where });
  const standIn = (map: SchemaMap, where: Condition, anchor: Row = i1) =>
    (placedOn(map, withWhere(where), anchor)[0] as Row).integrationResource as Row;

  test('only a root conjunct: a leaf inside `any` is not true of every admitted record', () => {
    const where = {
      any: [
        equals('integrationResource.kind', 'channel'),
        equals('integrationResource.kind', 'user'),
      ],
    } as Condition;
    expect(standIn(marked, where)).not.toHaveProperty('kind');
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
      { field: 'integrationResource.kind', operator: 'equals', path: 'channel' },
    ])
      expect(standIn(marked, leaf as Condition)).not.toHaveProperty('kind');
  });

  test('an unmarked nested field stays unknown', () => {
    expect(standIn(marked, equals('integrationResource.name', 'general'))).not.toHaveProperty(
      'name',
    );
  });

  test('the anchor and the rows above it are real and never written', () => {
    const provider = mapOver(annotate(models, 'Integration', 'provider', { place: true }));
    const linear = integration('i1', 'linear');
    const frozen = structuredClone(linear);
    const [placed] = placedOn(
      provider,
      withWhere(equals('integrationResource.integration.provider', 'slack')),
      linear,
    );
    expect(((placed as Row).integrationResource as Row).integration).toBe(linear);
    expect(linear).toEqual(frozen);
  });

  test('a leaf through a relation that is not the entry’s path fills nothing', () => {
    const [placed] = placedOn(marked, withWhere(equals('projectIntegrationResource.id', 'pir1')));
    expect(placed).toEqual({ integrationResource: { integrationId: 'i1', integration: i1 } });
  });

  test('each placement builds its own stand-ins: one grant’s value never reaches another’s', () => {
    const channel = standIn(marked, equals('integrationResource.kind', 'channel'));
    const user = standIn(marked, equals('integrationResource.kind', 'user'));
    const none = standIn(marked, equals('integrationResource.name', 'x'));
    expect([channel.kind, user.kind, none.kind]).toEqual(['channel', 'user', undefined]);
    expect(channel.integration).toBe(i1);
    expect(i1).toEqual(integration('i1'));
  });

  test('the root keeps today’s rule: any exact `equals` on the root pins, marked or not', () => {
    const [placed] = placedOn(marked, withWhere(equals('channel', 'C1')));
    expect((placed as Row).channel).toBe('C1');
  });
});

describe('where the mark is refused, when the map is first used', () => {
  const boot =
    (model: string, field: string, value: unknown = true, base = models) =>
    () =>
      createRebacCheck(mapOver(annotate(base, model, field, { place: value })));

  test('keys, ids, dates, Json, relations, and anything but `true`', () => {
    expect(boot('IntegrationResource', 'integrationId')).toThrow(/never marks a relation key/);
    expect(boot('IntegrationResource', 'id')).toThrow(/never marks an id/);
    expect(boot('Integration', 'deletedAt')).toThrow(/not DateTime/);
    expect(boot('IntegrationResource', 'metadata')).toThrow(/not Json/);
    expect(boot('IntegrationResource', 'integration')).toThrow(/marks a scalar or enum field/);
    expect(boot('IntegrationResource', 'projects')).toThrow(/marks a scalar or enum field/);
    expect(boot('IntegrationResource', 'kind', 'yes')).toThrow(/is true or absent/);
    expect(boot('IntegrationResource', 'kind', false)).toThrow(/is true or absent/);
    expect(boot('IntegrationResource', 'name')).not.toThrow();
  });

  test('a discriminator, a list, Float and Decimal', () => {
    const scalar = (type: string, isList = false) => ({ kind: 'scalar' as const, type, isList });
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
        resources: { thing: 'Thing' },
        fieldMap: { models: annotate(fieldMap.models, 'Thing', field, { place: true }) },
        polymorphism: { Thing: { axes: [{ field: 'ownerModel', fkMap: {} }] } },
      });
    expect(thing('ownerModel')).toThrow(/never marks a discriminator/);
    expect(thing('tags')).toThrow(/never marks a list/);
    expect(thing('ratio')).toThrow(/not Float/);
    expect(thing('price')).toThrow(/not Decimal/);
    expect(thing('tier')).not.toThrow();
  });
});

describe('a polymorphic stand-in: the mark joins it, the path still sets its kind and keys', () => {
  const scalar = { kind: 'scalar', type: 'String' } as const;
  const toOne = (type: string, fromFields: string[], toFields: string[]) =>
    ({ kind: 'object', type, isList: false, fromFields, toFields }) as const;
  const map: SchemaMap = {
    resources: {
      'db:organization': 'Organization',
      'db:space': 'Space',
      'db:integration': 'Integration',
      'db:webhook': 'Webhook',
    },
    fieldMap: {
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
            status: { ...scalar, annotations: { permissions: { place: true } } } as typeof scalar,
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
    polymorphism: {
      Integration: {
        axes: [
          {
            field: 'ownerModel',
            fkMap: { Organization: ['organizationId'], Space: ['organizationId', 'spaceId'] },
          },
        ],
      },
    },
  };

  test('status is filled; ownerModel and the keys come from the path, whatever the where says', () => {
    const s1 = { id: 's1', organizationId: 'o1', organization: o1 };
    const entry: EntitlementEntry = {
      resource: 'db:webhook',
      anchor: { resource: 'db:space', id: 's1', path: 'integration.space' },
      where: {
        all: [
          equals('integration.status', 'active'),
          equals('integration.ownerModel', 'Organization'),
          equals('integration.spaceId', 's9'),
        ],
      },
      actions: { manage: true },
    };
    const [placed] = placeEntitlement(map, entry, s1) as Row[];
    expect((placed as Row).integration).toEqual({
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
  resource: 'slack:channel',
  anchor: {
    resource: 'db:projectIntegrationResource',
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
    expect(placedOn(marked, atJoinRow, pir1)).toEqual([
      { projectIntegrationResourceId: 'pir1', projectIntegrationResource: pir1 },
    ]);
  });

  test('refused under the one-form rule: the stand-in’s own `integrationResource` is unknown', async () => {
    expect(await granted(marked, schema, atJoinRow, pir1)).toBe(false);
  });

  test('granted once the rule reaches the resource through the link; marks play no part', async () => {
    expect(validateSchema(marked, linked)).toEqual({ ok: true, errors: [] });
    expect(await granted(marked, linked, atJoinRow, pir1)).toBe(true);
    expect(await granted(unmarked, linked, atJoinRow, pir1)).toBe(true);
    const canGrant = createCanGrantEntitlement(marked);
    const projectOnly = await holding(['db:project', 'p1', 'manage']);
    const [placed] = placedOn(marked, atJoinRow, pir1);
    expect(canGrant(projectOnly, linked, atJoinRow, placed as Row)).toBe(false);
  });

  test('it reaches calls on that resource made through that link, and nothing else', async () => {
    const check = createRebacCheck(marked);
    const holder = createPermissions();
    await holder.setup([atJoinRow], { owner: await orgOwner() });
    const sends = (record: Row) =>
      check(holder, linked, { resource: 'slack:channel', record }, 'message.send');
    expect(sends(call(r1, pir1))).toBe(true);
    expect(sends(call(r1))).toBe(false);
    expect(sends(call(r1, link('pir2', p2, r1)))).toBe(false);
    expect(sends(call(r2, link('pir3', p1, r2)))).toBe(false);
  });

  test('anchored at the project instead ("everything in p1"): reads work, but no table can grant it', async () => {
    const wholeProject: EntitlementEntry = {
      resource: 'slack:channel',
      anchor: {
        resource: 'db:project',
        id: 'p1',
        path: 'projectIntegrationResource.project',
      },
      actions: { '*': true },
    };
    expect(placedOn(marked, wholeProject, p1)).toEqual([
      { projectIntegrationResource: { projectId: 'p1', project: p1 } },
    ]);
    expect(await granted(marked, linked, wholeProject, p1)).toBe(false);
    const stated = {
      ...wholeProject,
      where: {
        all: [
          equals('projectIntegrationResource.integrationResource.kind', 'channel'),
          equals('projectIntegrationResource.integrationResource.enabled', true),
        ],
      } as Condition,
    };
    expect(await granted(marked, linked, stated, p1)).toBe(false);
    const check = createRebacCheck(marked);
    const holder = createPermissions();
    await holder.setup([wholeProject], { owner: await orgOwner() });
    const sends = (record: Row) =>
      check(holder, linked, { resource: 'slack:channel', record }, 'message.send');
    expect(sends(call(r1, pir1))).toBe(true);
    expect(sends(call(r2, link('pir3', p1, r2)))).toBe(true);
    expect(sends(call(r1, link('pir2', p2, r1)))).toBe(false);
  });
});

// The adversarial review's reproductions for part B and the project scope.
describe('review: a marked field stated twice (B-1)', () => {
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
    (placedOn(marked, entry)[0] as Row).integrationResource as Row;

  test('two different values leave the field unknown, in either order: refused', async () => {
    for (const entry of [kinds('user', 'channel'), kinds('channel', 'user')]) {
      expect(standIn(entry)).not.toHaveProperty('kind');
      expect(standIn(entry).enabled).toBe(true);
      expect(await granted(marked, schema, entry)).toBe(false);
    }
  });

  test('the same value twice is one statement: a narrowed copy still pins it', async () => {
    expect(standIn(kinds('channel', 'channel')).kind).toBe('channel');
    expect(await granted(marked, schema, kinds('channel', 'channel'))).toBe(true);
  });

  test('the root follows the same rule', () => {
    const root = (...channels: string[]): Row =>
      placedOn(marked, {
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

describe('review: Kingdom’s project scope, as the review corrected it (B-2, B-3)', () => {
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
    const check = createRebacCheck(marked);
    const holder = createPermissions();
    await holder.setup([entry], { owner: await orgOwner() });
    return (record: Row) =>
      check(holder, linked, { resource: 'slack:channel', record }, 'message.send');
  };

  // B-2: the rule cannot tie the two carriers together on a stand-in, so the surface record must
  // derive its direct resource from the link it carries. This pins what a record that does not
  // do so is admitted as.
  test('B-2 a join-row entry judges the link: a record carrying another direct resource passes', async () => {
    const sends = await sendsAs(atJoinRow);
    expect(sends(call(r1, pir1))).toBe(true);
    expect(sends(call(r2, pir1))).toBe(true);
    expect(sends(call(foreign, pir1))).toBe(true);
    expect(sends(through(pir1))).toBe(true);
  });

  const inProject: EntitlementEntry = {
    resource: 'slack:channel',
    anchor: { resource: 'db:integration', id: 'i1', path: `${viaLink}.integration` },
    where: {
      all: [
        equals(`${viaLink}.kind`, 'channel'),
        equals(`${viaLink}.enabled`, true),
        equals('projectIntegrationResource.projectId', 'p1'),
      ],
    } as Condition,
    actions: { '*': true },
  };

  test('B-3 a project scope anchors at the integration, through the link: the marks fill two levels down', async () => {
    expect(placedOn(marked, inProject)).toEqual([
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
    expect(await granted(marked, linked, inProject)).toBe(true);
    expect(await granted(unmarked, linked, inProject)).toBe(false);
    const canGrant = createCanGrantEntitlement(marked);
    const projectOnly = await holding(['db:project', 'p1', 'manage']);
    for (const placed of placedOn(marked, inProject))
      expect(canGrant(projectOnly, linked, inProject, placed)).toBe(false);
  });

  test('B-3 at read it follows the project’s links live, and nothing outside the project or the kind', async () => {
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
  const rules: RebacSchema = {
    permissions: {
      ...schema.permissions,
      'db:integrationResource': {
        actions: { operate: { rel: 'integration', action: 'operate' }, read: inProject },
      },
    },
  };
  const rows: Record<string, Row[]> = {
    'db:organization': [o1, { id: 'o2' }],
    'db:project': [
      { id: 'p1', organizationId: 'o1' },
      { id: 'p2', organizationId: 'o2' },
    ],
    'db:projectIntegrationResource': [
      { id: 'l1', projectId: 'p1', integrationResourceId: 'r1' },
      { id: 'l2', projectId: 'p2', integrationResourceId: 'r2' },
    ],
  };
  const matches = (where: Row) => (row: Row) =>
    Object.entries(where).every(([key, value]) => row[key] === value);
  const hydrate = createHydrator({
    map: junction,
    load: async (of, where) => rows[of]?.find(matches(where)) ?? null,
    loadMany: async (of, where) => rows[of]?.filter(matches(where)) ?? [],
  });
  const read = async (permix: Awaited<ReturnType<typeof holding>>, id: string) =>
    createRebacCheck(junction)(
      permix,
      rules,
      {
        resource: 'db:integrationResource',
        record: await hydrate('db:integrationResource', { id }),
      },
      'read',
    );

  test('the declaration carries what the rule walks, and a shorter one is reported', () => {
    expect(validateSchema(junction, rules).errors).toEqual([]);
    const short = mapOver(
      annotate(models, 'IntegrationResource', 'projects', { down: ['project'] }),
    );
    expect(validateSchema(short, rules).errors.map((issue) => issue.code)).toEqual(['down']);
  });

  test('a role on the project, or above it, reads the resources attached to it and no others', async () => {
    const onProject = await holding(['db:project', 'p1', 'read']);
    expect(await read(onProject, 'r1')).toBe(true);
    expect(await read(onProject, 'r2')).toBe(false);
    expect(await read(await orgOwner(), 'r1')).toBe(true);
    expect(await read(await orgOwner(), 'r2')).toBe(false);
    expect(await read(onProject, 'r-unattached')).toBe(false);
  });
});
