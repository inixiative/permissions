import { expect, test } from 'bun:test';
import { type Condition, check as checkRule, Operator } from '@inixiative/json-rules';
import {
  createCanGrantEntitlement,
  createRebacCheck,
  type EntitlementEntry,
  type GrantEntry,
  type Permissions,
  permixOf,
  placeEntitlement,
  type RebacSchema,
  type Row,
} from '../index';
import { mapOf } from './schemaMaps';

// Random writers (owner graphs up to three deep, loops included) and random granted entries over
// one schema, on this code only: an unmarked writer stands in for the grant check before the rule
// (the comparison against the released code was run outside the repo). It does not cover the
// self-anchored cases; the R95, R99 and R101 tests in narrowGrant do.
// For every case: the marks change no read, lose no grant, and each grant they add is one the
// writer can take on every real record the entry reaches using marked rows and roles alone.

const CASES = 600;

let seed = 4242;
const random = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
const chance = (probability: number) => random() < probability;
const eq = (field: string, value: unknown): Condition =>
  ({ field, operator: Operator.equals, value }) as Condition;

const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null, manage: 'own', read: 'manage' } },
    'db:space': {
      actions: {
        own: { rel: 'organization', action: 'own' },
        manage: { any: ['own', { rel: 'organization', action: 'manage' }] },
        read: { any: ['manage', { rel: 'organization', action: 'read' }] },
        rename: { all: [{ rule: eq('label', null) }, 'read'] },
        archive: { all: [{ rule: eq('label', 'draft') }, 'manage'] },
      },
    },
    'db:integration': {
      actions: {
        own: { rel: 'space', action: 'own' },
        manage: { any: ['own', { rel: 'space', action: 'manage' }] },
        read: { any: ['manage', { rel: 'space', action: 'read' }] },
        sync: { all: [{ rule: eq('provider', 'slack') }, 'read'] },
        draftOnly: { all: [{ rule: eq('space.label', 'draft') }, 'read'] },
      },
    },
    'kcp:thread': {
      actions: {
        read: { rel: 'integration', action: 'read' },
        post: { rel: 'integration', action: 'manage' },
      },
    },
  },
};
const resources = ['db:organization', 'db:space', 'db:integration', 'kcp:thread'] as const;
type Resource = (typeof resources)[number];
const map = mapOf(
  {
    'db:space': { organization: 'db:organization' },
    'db:integration': { space: 'db:space' },
    'kcp:thread': { integration: 'db:integration' },
  },
  { 'db:space': ['label'], 'db:integration': ['provider'] },
);
const rebac = createRebacCheck(map);
const canGrant = createCanGrantEntitlement(map);
const actionsOf = (resource: Resource) => Object.keys(schema.permissions[resource]?.actions ?? {});

type World = Record<Resource, Row[]>;
const world = (): World => {
  const o1 = { id: 'o1' };
  const o2 = { id: 'o2' };
  const space = (id: string, organization: Row) => ({
    id,
    label: pick([null, 'draft', 'live']),
    organizationId: organization.id,
    organization,
  });
  const spaces = [space('s1', o1), space('s2', o1), space('s3', o2)];
  const integration = (id: string, at: number, provider: string) => ({
    id,
    provider,
    spaceId: spaces[at]?.id,
    space: spaces[at],
  });
  const integrations = [
    integration('i1', 0, 'slack'),
    integration('i2', 0, 'teams'),
    integration('i3', 1, 'slack'),
    integration('i4', 2, 'teams'),
  ];
  const threads = integrations.flatMap((row) =>
    ['a', 'b'].map((suffix) => ({
      id: `t${row.id}${suffix}`,
      integrationId: row.id,
      integration: row,
    })),
  );
  return {
    'db:organization': [o1, o2],
    'db:space': spaces,
    'db:integration': integrations,
    'kcp:thread': threads,
  };
};
const anchorsAbove: Record<Resource, [string, Resource][]> = {
  'db:organization': [],
  'db:space': [['organization', 'db:organization']],
  'db:integration': [
    ['space', 'db:space'],
    ['space.organization', 'db:organization'],
  ],
  'kcp:thread': [
    ['integration', 'db:integration'],
    ['integration.space', 'db:space'],
    ['integration.space.organization', 'db:organization'],
  ],
};
const wheres: Record<Resource, Condition[]> = {
  'db:organization': [eq('id', 'o1')],
  'db:space': [
    eq('label', 'draft'),
    eq('label', null),
    eq('id', 's1'),
    eq('organization.id', 'o1'),
  ],
  'db:integration': [
    eq('provider', 'slack'),
    eq('space.label', 'draft'),
    eq('id', 'i1'),
    { field: 'id', operator: Operator.in, value: ['i1', 'i2'] } as Condition,
    { all: [eq('provider', 'slack'), eq('id', 'i1')] },
  ],
  'kcp:thread': [eq('id', 'ti1a'), eq('integration.provider', 'slack')],
};
const idOf = (rows: Row[]) => pick(rows).id as string;

const randomEntry = (rows: World, marks: boolean): EntitlementEntry => {
  const resource = pick(resources);
  const above = anchorsAbove[resource];
  const self = chance(0.4) || above.length === 0;
  const [path, anchorResource] = self ? [undefined, resource] : pick(above);
  const anchor = {
    resource: anchorResource,
    id: idOf(rows[anchorResource]),
    ...(path ? { path } : {}),
  };
  const some = actionsOf(resource).filter(() => chance(0.35));
  const names = some.length ? some : [pick(actionsOf(resource))];
  const actions = Object.fromEntries(names.map((name) => [name, true]));
  if (chance(0.35)) return { resource, anchor, actions, where: pick(wheres[resource]) };
  return { resource, anchor, actions, ...(marks && chance(0.7) ? { grantsBelow: true } : {}) };
};
const randomGrant = (rows: World): GrantEntry => {
  const resource = pick(resources);
  return { resource, id: idOf(rows[resource]), actions: { [pick(actionsOf(resource))]: true } };
};
const several = <T>(make: () => T): T[] =>
  Array.from({ length: 1 + Math.floor(random() * 2) }, make);
const randomPermissions = (rows: World, depth: number, pool: Permissions[]): Permissions => {
  if (pool.length && chance(0.15)) return pick(pool);
  const permissions: Permissions = [];
  pool.push(permissions);
  if (chance(depth === 0 ? 0.9 : 0.5))
    permissions.push({ entries: several(() => randomGrant(rows)) });
  if (depth > 0)
    for (const _ of several(() => null))
      permissions.push({
        entries: several(() => randomEntry(rows, true)),
        owner: randomPermissions(rows, depth - 1, pool),
      });
  return permissions;
};

// The same writer with each entitlement group's entries rewritten at every depth, loops kept.
const rewritten = (
  permissions: Permissions,
  entriesOf: (entries: EntitlementEntry[]) => EntitlementEntry[],
  memo = new Map<Permissions, Permissions>(),
): Permissions => {
  const known = memo.get(permissions);
  if (known) return known;
  const out: Permissions = [];
  memo.set(permissions, out);
  for (const group of permissions) {
    if (!group.owner) out.push(group);
    else {
      const entries = entriesOf(group.entries as EntitlementEntry[]);
      if (entries.length) out.push({ entries, owner: rewritten(group.owner, entriesOf, memo) });
    }
  }
  return out;
};
const unmarked = (permissions: Permissions) =>
  rewritten(permissions, (entries) => entries.map(({ grantsBelow: _, ...entry }) => entry));
const markedOnly = (permissions: Permissions) =>
  rewritten(permissions, (entries) => entries.filter((entry) => entry.grantsBelow === true));

const reaches = (row: Row, entry: EntitlementEntry) => {
  let current: Row | undefined = row;
  for (const segment of entry.anchor.path?.split('.') ?? [])
    current = current?.[segment] as Row | undefined;
  return (
    current?.id === entry.anchor.id &&
    (entry.where === undefined || checkRule(entry.where, row) === true)
  );
};

test(`fuzz, ${CASES} cases: marks change no read, lose no grant, and add only grants the writer can take`, async () => {
  const lost: number[] = [];
  const readsChanged: number[] = [];
  const unsound: string[] = [];
  let added = 0;
  for (let n = 0; n < CASES; n++) {
    const rows = world();
    const writer = randomPermissions(rows, 1 + Math.floor(random() * 3), []);
    const entry = randomEntry(rows, false);
    const anchor = rows[entry.anchor.resource as Resource].find(
      (row) => row.id === entry.anchor.id,
    ) as Row;
    const placed = placeEntitlement(map, entry, anchor);
    const withMarks = await permixOf(writer);
    const without = await permixOf(unmarked(writer));
    const grants = (permix: typeof withMarks) =>
      placed?.every((record) => canGrant(permix, schema, entry, record)) === true;
    const reads = (permix: typeof withMarks) =>
      resources
        .flatMap((resource) =>
          rows[resource].flatMap((record) =>
            actionsOf(resource).map((action) => {
              try {
                return rebac(permix, schema, { resource, record }, action) ? '1' : '0';
              } catch {
                return 'T';
              }
            }),
          ),
        )
        .join('');
    if (reads(withMarks) !== reads(without)) readsChanged.push(n);
    const before = grants(without);
    const after = grants(withMarks);
    if (before && !after) lost.push(n);
    if (!after || before) continue;
    added++;
    const bare = await permixOf(markedOnly(writer));
    const resource = entry.resource as Resource;
    for (const record of rows[resource].filter((row) => reaches(row, entry)))
      for (const action of Object.keys(entry.actions))
        if (!rebac(bare, schema, { resource, record }, action))
          unsound.push(`${n}:${record.id}:${action}`);
  }
  expect(readsChanged).toEqual([]);
  expect(lost).toEqual([]);
  expect(unsound).toEqual([]);
  expect(added).toBeGreaterThan(0);
}, 30_000);
