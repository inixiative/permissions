import { describe, expect, test } from 'bun:test';
import type { FieldMap, RelationField, ScalarField, ScalarType } from '@inixiative/field-map';
import type { Condition } from '@inixiative/json-rules';
import {
  type ActionRule,
  type EntitlementEntry,
  entitlementProblem,
  makeHydrator,
  type PermixLike,
  pseudoRecordsOfEntitlement,
  type Row,
  type SchemaMap,
  validateSchemaMap,
  whyEntitlementWhereLeavesLens,
} from '../index';
import {
  countRelationsOneRowHydrates,
  lensesAtRow,
  relationLensLimits,
  whyWhereLeavesLensAtRow,
} from '../src/core/lens';
import { listOf } from '../src/core/relations';
import { resolvedSchemaMap } from '../src/core/resolvedSchemaMap';
import { identityKeyOfRow } from '../src/core/rowKeys';
import { hydrationLimits } from '../src/helpers/hydration/hydrate';
import { loadModels } from './fixtures/load';
import { makeHydratorReadingEachRowThroughLoad } from './makeHydratorReadingEachRowThroughLoad';
import {
  actorData,
  actorMap,
  canGrantWithRules,
  checkWithRules,
  dbFieldMapOf,
  declaringSuppliedBridges,
  mapWith,
  pathsWithRules,
  type Rules,
} from './schemaMaps';

// json-rules' own lens, spelled in the root, decides which paths a rule may name; the hydrator
// loads every row it can reach. Each case below returned true on 0.22.0 (the adversarial review's probes, T1–T8).

type Extra<F> = Omit<F, 'kind' | 'type'>;

const column = (type: ScalarType, extra: Extra<ScalarField> = {}): ScalarField => ({
  kind: 'scalar',
  type,
  isList: false,
  ...extra,
});
const toOne = (type: string, key?: string, extra: Extra<RelationField> = {}): RelationField => ({
  kind: 'object',
  type,
  isList: false,
  ...(key ? { fromFields: [key], toFields: ['id'] } : {}),
  ...extra,
});
const toMany = (type: string, extra: Extra<RelationField> = {}): RelationField => ({
  kind: 'object',
  type,
  isList: true,
  ...extra,
});

const fieldMap: FieldMap = {
  models: {
    Org: {
      fields: {
        id: column('String'),
        name: column('String'),
        creatorId: column('String'),
        creator: toOne('User', 'creatorId', { relationName: 'OrgCreator' }),
      },
    },
    User: {
      fields: {
        id: column('String'),
        name: column('String'),
        orgId: column('String'),
        org: toOne('Org', 'orgId', { relationName: 'UserOrg' }),
        profile: toOne('Profile', undefined, { relationName: 'ProfileUser' }),
        targetEntitlements: toMany('Entitlement', { relationName: 'EntitlementTarget' }),
      },
    },
    Profile: {
      fields: {
        id: column('String'),
        userId: column('String'),
        bannedAt: column('DateTime'),
        user: toOne('User', 'userId', { relationName: 'ProfileUser' }),
      },
    },
    Entitlement: {
      fields: {
        id: column('String'),
        targetId: column('String'),
        target: toOne('User', 'targetId', { relationName: 'EntitlementTarget' }),
      },
    },
    Conversation: {
      fields: {
        id: column('String'),
        orgId: column('String'),
        meta: column('Json'),
        permissionRules: column('Json'),
        org: toOne('Org', 'orgId', { relationName: 'ConversationOrg' }),
        messages: toMany('Message', {
          relationName: 'MessageConversation',
          annotations: { permissions: { down: ['author.org.creator'] } },
        }),
        drafts: toMany('Draft', { relationName: 'DraftConversation' }),
      },
    },
    Message: {
      fields: {
        id: column('String'),
        conversationId: column('String'),
        authorId: column('String'),
        mentions: column('String', { isList: true }),
        conversation: toOne('Conversation', 'conversationId', {
          relationName: 'MessageConversation',
        }),
        author: toOne('User', 'authorId', { relationName: 'MessageAuthor' }),
      },
    },
    Draft: {
      fields: {
        id: column('String'),
        conversationId: column('String'),
        authorId: column('String'),
        conversation: toOne('Conversation', 'conversationId', {
          relationName: 'DraftConversation',
        }),
      },
    },
    Signet: {
      fields: {
        id: column('String'),
        userId: column('String'),
        recipientUserId: column('String'),
        user: toOne('User', 'userId', { relationName: 'SignetUser' }),
        recipientUser: toOne('User', 'recipientUserId', { relationName: 'SignetRecipient' }),
      },
    },
  },
};
const schemaMap: SchemaMap = declaringSuppliedBridges({
  permissions: {},
  fieldMaps: { db: fieldMap },
  suppliedFieldMaps: { actor: actorMap },
});

const db: Record<string, Record<string, Row>> = {
  'db:Org': { o1: { id: 'o1', name: 'acme', creatorId: 'u1' } },
  'db:User': {
    u1: { id: 'u1', name: 'Una', orgId: 'o1' },
    attacker: { id: 'attacker', name: 'Mal', orgId: 'o1' },
  },
  'db:Profile': { p1: { id: 'p1', userId: 'attacker', bannedAt: '2026-02-02' } },
  'db:Conversation': { c1: { id: 'c1', orgId: 'o1', permissionRules: null } },
  'db:Message': { m1: { id: 'm1', conversationId: 'c1', authorId: 'u1', mentions: ['aron'] } },
};
const hydrate = makeHydratorReadingEachRowThroughLoad({
  schemaMap,
  load: async (resource, where) => db[resource]?.[where.id as string] ?? null,
  loadItems: async (resource, where) =>
    Object.values(db[resource] ?? {}).filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    ),
});
// Who a permix stands for: a check is told it through the subject's `bridgeData`.
const actedBy = new WeakMap<object, Row>();
const acting = <
  Subject extends { bridgeData?: Record<string, Row[]> },
  Rest extends unknown[],
  Out,
>(
  ask: (permix: PermixLike, schema: Rules, subject: Subject, ...rest: Rest) => Out,
) => {
  return (permix: PermixLike, schema: Rules, subject: Subject, ...rest: Rest): Out => {
    const record = actedBy.get(permix);
    const data = record === undefined ? {} : actorData('User', record);
    return ask(
      permix,
      schema,
      { ...subject, bridgeData: { ...data, ...subject.bridgeData } },
      ...rest,
    );
  };
};
const check = acting(checkWithRules(schemaMap));

const actorAs = (id: string, entitlements: EntitlementEntry[] = []): PermixLike => {
  const owner: PermixLike = { check: () => true };
  const permix: PermixLike = {
    check: () => false,
    entitlements: (resource, action) =>
      entitlements
        .filter((entry) => entry.resource === resource && entry.actions[action] === true)
        .map((entry) => ({ ...entry, owner })),
  };
  actedBy.set(permix, { id });
  return permix;
};
const ruled = (resource: string, rule: ActionRule): Rules => ({
  permissions: { [resource]: { actions: { act: rule } } },
});
// A read of `field`: `exists`, or `equals value` (a rule names what is there, never a null).
const reads = (field: string, value?: unknown): ActionRule => ({
  rule: (value === undefined
    ? { field, operator: 'exists' }
    : { field, operator: 'equals', value }) as Condition,
});
const actorWrote = (field: string): ActionRule => ({
  rule: {
    all: [
      { field, operator: 'exists' },
      { field: 'actor:User.id', operator: 'exists' },
      { field, operator: 'equals', path: 'actor:User.id' },
    ],
  },
});
// The refusals a schema gets, each once: an `exists` and its comparison reading one path are two reports of it.
const codes = (schema: Rules) => [
  ...new Set(validateSchemaMap(mapWith(schemaMap, schema)).errors.map((issue) => issue.code)),
];

describe('reads the hydrator never loaded are refused', () => {
  test('a path through an undeclared list a request body filled is refused', async () => {
    const body = await hydrate('db:Conversation', {
      id: 'c1',
      orgId: 'o1',
      drafts: [{ authorId: 'attacker' }],
    });
    expect(body.drafts).toEqual([{ authorId: 'attacker' }]);
    const schema = ruled('db:Conversation', actorWrote('drafts.0.authorId'));
    expect(() =>
      check(actorAs('attacker'), schema, { resource: 'db:Conversation', record: body }, 'act'),
    ).toThrow(/`db:Conversation.drafts` is a list: no path reads into one; declare it/);
    expect(codes(schema)).toEqual(['lens']);
  });

  test('the same read in a bracket spelling is refused, on a declared list too', async () => {
    const record = { id: 'c1', orgId: 'o1', drafts: [{ authorId: 'attacker' }] };
    for (const field of [
      '["drafts"][0]["authorId"]',
      'drafts[0].authorId',
      "['messages'][0].authorId",
    ]) {
      const schema = ruled('db:Conversation', actorWrote(field));
      expect(() =>
        check(actorAs('attacker'), schema, { resource: 'db:Conversation', record }, 'act'),
      ).toThrow(/is a list/);
    }
    const declared = ruled('db:Conversation', actorWrote('["messages"][0]["authorId"]'));
    expect(validateSchemaMap(mapWith(schemaMap, declared)).errors[0]?.message).toMatch(
      /cross it with \{ rel: 'messages', arrayOperator: 'any', condition \}/,
    );
  });

  test('a relation keyed on the other side is refused, so a banned user never reads as unbanned', async () => {
    const attacker = await hydrate('db:User', db['db:User']?.attacker as Row);
    const schema = ruled('db:User', reads('profile.bannedAt'));
    expect(() =>
      check(actorAs('attacker'), schema, { resource: 'db:User', record: attacker }, 'act'),
    ).toThrow(/`db:User.profile` keeps its foreign key on `db:Profile`: nothing loads it/);
    const claimed = { ...attacker, profile: { bannedAt: null } };
    const inline = () =>
      check(
        actorAs('attacker'),
        { permissions: {} },
        { resource: 'db:User', record: claimed },
        reads('profile.bannedAt'),
      );
    expect(inline).toThrow(/keeps its foreign key/);
  });

  test('a schema is frozen on its first check; an edit afterwards throws and changes nothing', async () => {
    const record = await hydrate('db:Conversation', { id: 'c1', orgId: 'o1' });
    const schema = ruled('db:Conversation', reads('orgId', 'nope'));
    expect(check(actorAs('attacker'), schema, { resource: 'db:Conversation', record }, 'act')).toBe(
      false,
    );
    const actions = schema.permissions['db:Conversation']?.actions as Record<string, ActionRule>;
    expect(() => {
      actions.act = true;
    }).toThrow();
    expect(check(actorAs('attacker'), schema, { resource: 'db:Conversation', record }, 'act')).toBe(
      false,
    );
  });

  test('an entitlement whose where reads into a list never holds, and is never granted', async () => {
    const entry: EntitlementEntry = {
      resource: 'db:Conversation',
      anchor: { resource: 'db:Conversation', id: 'c1' },
      where: { field: 'drafts.0.authorId', operator: 'equals', value: 'attacker' },
      actions: { act: true },
    };
    const record = {
      ...(await hydrate('db:Conversation', { id: 'c1', orgId: 'o1' })),
      drafts: [{ authorId: 'attacker' }],
    };
    const schema = ruled('db:Conversation', null);
    expect(
      check(actorAs('attacker', [entry]), schema, { resource: 'db:Conversation', record }, 'act'),
    ).toBe(false);
    expect(entitlementProblem(entry)).toBeNull();
    expect(whyEntitlementWhereLeavesLens(schemaMap, entry.resource, entry.where)).toMatch(
      /reads outside the lens: `db:Conversation.drafts` is a list/,
    );
    const writer: PermixLike = { check: () => true };
    expect(canGrantWithRules(schemaMap)(writer, schema, entry, record)).toBe(false);
  });

  test('a path back to a model is refused; the hydrator links the row it would read', async () => {
    const attacker = await hydrate('db:User', db['db:User']?.attacker as Row);
    const org = attacker.org as Row;
    expect((org.creator as Row).org).toBe(org);
    for (const field of ['org.creator.org.name', 'org.creator.name'])
      expect(() =>
        check(
          actorAs('attacker'),
          ruled('db:User', reads(field)),
          { resource: 'db:User', record: attacker },
          'act',
        ),
      ).toThrow(/comes back to `db:User`: a path back to a model is not in the lens/);
  });

  test('a rel back to a model is two hops; each lands on the real row, and a where there holds on it', async () => {
    const u1 = await hydrate('db:User', db['db:User']?.u1 as Row);
    expect(((u1.org as Row).creator as Row).org).toBe(u1.org);
    const oneHop: Rules = {
      permissions: {
        'db:User': { actions: { act: { rel: 'org.creator', action: 'vouch' }, vouch: null } },
      },
    };
    expect(() => check(actorAs('x'), oneHop, { resource: 'db:User', record: u1 }, 'act')).toThrow(
      /`org.creator` comes back to `db:User`/,
    );
    const twoHops = (vouch: ActionRule): Rules => ({
      permissions: {
        'db:User': { actions: { act: { rel: 'org', action: 'creator' }, vouch } },
        'db:Org': { actions: { creator: { rel: 'creator', action: 'vouch' } } },
      },
    });
    const subject = { resource: 'db:User', record: u1 };
    expect(check(actorAs('x'), twoHops(reads('org.name', 'other')), subject, 'act')).toBe(false);
    expect(check(actorAs('x'), twoHops(reads('org.name', 'acme')), subject, 'act')).toBe(true);
    const held = (value: string): EntitlementEntry => ({
      resource: 'db:User',
      anchor: { resource: 'db:User', id: 'u1' },
      where: { field: 'org.name', operator: 'equals', value },
      actions: { vouch: true },
    });
    expect(check(actorAs('x', [held('other')]), twoHops(null), subject, 'act')).toBe(false);
    expect(check(actorAs('x', [held('acme')]), twoHops(null), subject, 'act')).toBe(true);
    const conversation = await hydrate('db:Conversation', db['db:Conversation']?.c1 as Row);
    const fromConversation: Rules = {
      permissions: {
        'db:Conversation': { actions: { act: { rel: 'org.creator', action: 'vouch' } } },
        'db:User': { actions: { vouch: reads('org.name', 'other') } },
      },
    };
    expect(
      check(
        actorAs('x'),
        fromConversation,
        { resource: 'db:Conversation', record: conversation },
        'act',
      ),
    ).toBe(false);
  });
});

describe('a loop made by data denies; a schema that names itself throws', () => {
  const walks: Rules = {
    permissions: {
      'db:User': { actions: { own: null, read: { any: ['own', { rel: 'org', action: 'read' }] } } },
      'db:Org': { actions: { read: { rel: 'creator', action: 'read' } } },
    },
  };
  const owns = (id: string): PermixLike => ({
    check: (resource, action, recordId) =>
      resource === 'db:User' && action === 'own' && recordId === id,
  });

  test('around the cycle: no grant denies, the owner is allowed, paths agree', async () => {
    const u1 = await hydrate('db:User', db['db:User']?.u1 as Row);
    expect(((u1.org as Row).creator as Row).org).toBe(u1.org);
    const subject = { resource: 'db:User', record: u1 };
    expect(check(actorAs('x'), walks, subject, 'read')).toBe(false);
    expect(check(owns('u1'), walks, subject, 'read')).toBe(true);
    expect(acting(pathsWithRules(schemaMap))(actorAs('x'), walks, subject, 'read')).toEqual([]);
    expect(pathsWithRules(schemaMap)(owns('u1'), walks, subject, 'read')).toEqual([[]]);
  });

  test('a sibling arm beside the looping arm is judged', async () => {
    const u1 = await hydrate('db:User', db['db:User']?.u1 as Row);
    const sibling: Rules = {
      permissions: {
        'db:User': {
          actions: {
            own: null,
            read: { any: [{ rel: 'org', action: 'read' }, reads('name', 'Una')] },
          },
        },
        'db:Org': { actions: { read: { rel: 'creator', action: 'read' } } },
      },
    };
    expect(check(actorAs('x'), sibling, { resource: 'db:User', record: u1 }, 'read')).toBe(true);
  });

  test('the grant check on a cyclic anchor denies instead of throwing, and allows as on a tree', async () => {
    const u1 = await hydrate('db:User', db['db:User']?.u1 as Row);
    const tree = { ...(db['db:Org']?.o1 as Row) };
    const entry: EntitlementEntry = {
      resource: 'db:User',
      anchor: { resource: 'db:Org', id: 'o1', path: 'org' },
      actions: { read: true },
    };
    const grants = (writer: PermixLike, anchor: Row) =>
      (pseudoRecordsOfEntitlement(schemaMap, entry, anchor) ?? []).every((pseudoRecord) =>
        canGrantWithRules(schemaMap)(writer, walks, entry, pseudoRecord),
      );
    const orgReader: PermixLike = { check: (resource) => resource === 'db:Org' };
    const nobody: PermixLike = { check: () => false };
    expect(grants(orgReader, u1.org as Row)).toBe(true);
    expect(grants(orgReader, tree)).toBe(true);
    expect(grants(nobody, u1.org as Row)).toBe(false);
    expect(grants(nobody, tree)).toBe(false);
  });

  test('a rule that names itself on the same record throws', async () => {
    const u1 = await hydrate('db:User', db['db:User']?.u1 as Row);
    const selfLoop: Rules = {
      permissions: { 'db:User': { actions: { read: { any: ['read'] } } } },
    };
    expect(() =>
      check(actorAs('x'), selfLoop, { resource: 'db:User', record: u1 }, 'read'),
    ).toThrow(/Cycle detected/);
  });
});

describe('computed keys, class instances, frozen wheres and the actor in a where', () => {
  test('a computed key on a row reached by { rel } is refused, so a set plan never reads as null', () => {
    const schema: Rules = {
      permissions: {
        'db:Conversation': { actions: { act: { rel: 'org', action: 'a' } } },
        'db:Org': { actions: { a: reads('plan') } },
      },
    };
    const record = { id: 'c1', orgId: 'o1', org: { id: 'o1', name: 'acme', plan: 'pro' } };
    expect(() =>
      check(actorAs('x'), schema, { resource: 'db:Conversation', record }, 'act'),
    ).toThrow('`db:Org` has no field `plan` (`plan`)');
  });

  test('a relation held as a class instance is read, not dropped', () => {
    class OrgRow {
      id = 'o1';
      name = 'acme';
    }
    const record = { id: 'u1', orgId: 'o1', org: new OrgRow() };
    const at = (value: unknown) =>
      check(
        actorAs('x'),
        ruled('db:User', reads('org.name', value)),
        { resource: 'db:User', record },
        'act',
      );
    expect(at('other')).toBe(false);
    expect(at('acme')).toBe(true);
  });

  test('an entitlement where is frozen when first judged; an edit afterwards throws', () => {
    const where: Condition = { field: 'name', operator: 'equals', value: 'Una' };
    const entry: EntitlementEntry = {
      resource: 'db:User',
      anchor: { resource: 'db:User', id: 'u1' },
      where,
      actions: { act: true },
    };
    const record = { id: 'u1', name: 'Una', orgId: 'o1' };
    const ask = () =>
      check(actorAs('x', [entry]), ruled('db:User', null), { resource: 'db:User', record }, 'act');
    expect(ask()).toBe(true);
    expect(() => {
      (where as { field: string }).field = 'profile.bannedAt';
    }).toThrow();
    expect(ask()).toBe(true);
  });

  test('a where reads the record alone, so an actor path in it is refused', () => {
    const entry: EntitlementEntry = {
      resource: 'db:User',
      anchor: { resource: 'db:User', id: 'u1' },
      where: { field: 'actor:User.id', operator: 'exists' },
      actions: { act: true },
    };
    const record = { id: 'u1', orgId: 'o1' };
    expect(
      check(actorAs('u1', [entry]), ruled('db:User', null), { resource: 'db:User', record }, 'act'),
    ).toBe(false);
    expect(whyEntitlementWhereLeavesLens(schemaMap, 'db:User', entry.where)).toMatch(
      /supplied rows are not on it/,
    );
    expect(codes(ruled('db:User', actorWrote('id')))).toEqual([]);
  });
});

describe('what the lens keeps', () => {
  test('a column of a relation, a Json sub-path, a scalar list (never indexed); never a computed key', async () => {
    const message = await hydrate('db:Message', db['db:Message']?.m1 as Row);
    const passes = (rule: ActionRule, record: Row = message) =>
      check(
        actorAs('attacker'),
        ruled('db:Message', rule),
        { resource: 'db:Message', record },
        'act',
      );
    expect(passes(reads('conversation.org.name', 'acme'))).toBe(true);
    expect(passes({ rule: { field: 'mentions', operator: 'contains', value: 'aron' } })).toBe(true);
    expect(() => passes(reads('mentions.0', 'aron'))).toThrow(/`mentions` is a column/);
    expect(
      passes(reads('conversation.meta.flags.0', 'x'), {
        ...message,
        conversation: { ...(message.conversation as Row), meta: { flags: ['x'] } },
      }),
    ).toBe(true);
    const scored = { resource: 'db:Message', record: { ...message, score: 7 } };
    expect(() => check(actorAs('x'), ruled('db:Message', null), scored, reads('score', 7))).toThrow(
      '`db:Message` has no field `score`',
    );
    expect(codes(ruled('db:Message', reads('conversation.meta.a.b')))).toEqual([]);
  });

  test('two relations of one row to one model are both visible', async () => {
    const signet = { id: 's1', userId: 'u1', recipientUserId: 'attacker' };
    const hydrated = await hydrate('db:Signet', signet);
    const rule: ActionRule = {
      all: [
        reads('user.name', 'Una'),
        reads('recipientUser.name', 'Mal'),
        reads('user.org.name', 'acme'),
      ],
    };
    expect(codes(ruled('db:Signet', rule))).toEqual([]);
    expect(
      check(
        actorAs('x'),
        ruled('db:Signet', rule),
        { resource: 'db:Signet', record: hydrated },
        'act',
      ),
    ).toBe(true);
  });

  test('a where on a scalar list, and a declared leaf that comes back to a model', async () => {
    const entry: EntitlementEntry = {
      resource: 'db:Message',
      anchor: { resource: 'db:Message', id: 'm1' },
      where: { field: 'mentions', operator: 'contains', value: 'aron' },
      actions: { act: true },
    };
    expect(whyEntitlementWhereLeavesLens(schemaMap, entry.resource, entry.where)).toBeNull();
    const message = await hydrate('db:Message', db['db:Message']?.m1 as Row);
    expect(
      check(
        actorAs('x', [entry]),
        ruled('db:Message', null),
        { resource: 'db:Message', record: message },
        'act',
      ),
    ).toBe(true);

    const leaf: ActionRule = {
      rel: 'messages',
      arrayOperator: 'any',
      condition: reads('author.org.creator.name', 'Una'),
    };
    expect(codes(ruled('db:Conversation', leaf))).toEqual([]);
    const conversation = await hydrate('db:Conversation', db['db:Conversation']?.c1 as Row);
    expect(
      check(
        actorAs('x'),
        ruled('db:Conversation', leaf),
        { resource: 'db:Conversation', record: conversation },
        'act',
      ),
    ).toBe(true);
    expect(codes(ruled('db:Message', reads('author.org.creator.name')))).toEqual(['lens']);
  });

  test('a key the model does not have and an index are refused, wherever the rule came from', () => {
    expect(
      validateSchemaMap(mapWith(schemaMap, ruled('db:User', reads('org.plann')))).errors[0]
        ?.message,
    ).toBe('`db:Org` has no field `plann` (`org.plann`)');
    expect(
      validateSchemaMap(mapWith(schemaMap, ruled('db:User', reads('org.0.name')))).errors[0]
        ?.message,
    ).toMatch(/`org` is one row and is never indexed/);
    expect(
      validateSchemaMap(mapWith(schemaMap, ruled('db:User', reads('plann')))).errors[0]?.message,
    ).toBe('`db:User` has no field `plann` (`plann`)');
    const inline = (rule: ActionRule) =>
      check(
        actorAs('x'),
        ruled('db:User', null),
        { resource: 'db:User', record: { id: 'u1', plann: 1 } },
        rule,
      );
    expect(() => inline(reads('plann', 1))).toThrow('`db:User` has no field `plann`');
    expect(() => inline({ any: [reads('plann', 1)] })).toThrow('`db:User` has no field `plann`');
    const rowRule = { id: 'u1', plann: 1, permissionRules: { act: reads('plann', 1) } };
    expect(() =>
      check(actorAs('x'), ruled('db:User', null), { resource: 'db:User', record: rowRule }, 'act'),
    ).toThrow('`db:User` has no field `plann`');
    expect(
      whyEntitlementWhereLeavesLens(schemaMap, 'db:User', {
        field: 'plann',
        operator: 'equals',
        value: 1,
      }),
    ).toMatch(/`db:User` has no field `plann`/);
    expect(codes(ruled('db:User', reads('actor:User.org')))).toEqual(['lens']);
  });
});

describe('the record a check reads is a view', () => {
  test('a check never changes the caller’s record', async () => {
    const record = {
      ...(await hydrate('db:Conversation', db['db:Conversation']?.c1 as Row)),
      drafts: [{ id: 'd1' }],
      computed: { a: 1 },
    };
    const before = structuredClone(record);
    const schema = ruled('db:Conversation', {
      any: [
        reads('org.name', 'nope'),
        { rel: 'messages', arrayOperator: 'any', condition: reads('author.name', 'Una') },
      ],
    });
    expect(check(actorAs('x'), schema, { resource: 'db:Conversation', record }, 'act')).toBe(true);
    expect(record).toEqual(before);
  });

  test('an undeclared list the app loaded stays on the record, after hydration and after a check', async () => {
    const targetEntitlements = [{ id: 'e1', targetId: 'u1' }];
    const user = await hydrate('db:User', { ...(db['db:User']?.u1 as Row), targetEntitlements });
    expect(user.targetEntitlements).toBe(targetEntitlements);
    const schema = ruled('db:User', reads('org.name', 'acme'));
    expect(check(actorAs('x'), schema, { resource: 'db:User', record: user }, 'act')).toBe(true);
    expect(user.targetEntitlements).toBe(targetEntitlements);
    expect(codes(ruled('db:User', reads('targetEntitlements.0.id', 'e1')))).toEqual(['lens']);
  });
});

describe('the root, item paths, unknown resources and wheres on an item', () => {
  test('an edge back to the root loads the stored row: the caller’s record is not believed there', async () => {
    const named = (value: unknown): Rules => ({
      permissions: {
        'db:User': {
          actions: { act: { rel: 'org', action: 'creator' }, named: reads('name', value) },
        },
        'db:Org': { actions: { creator: { rel: 'creator', action: 'named' } } },
      },
    });
    const partial = await hydrate('db:User', { id: 'u1', orgId: 'o1' });
    const creator = (partial.org as Row).creator as Row;
    expect(creator).not.toBe(partial);
    expect(creator.name).toBe('Una');
    expect(
      check(actorAs('x'), named('other'), { resource: 'db:User', record: partial }, 'act'),
    ).toBe(false);
    const forged = await hydrate('db:User', { id: 'u1', name: 'EVIL', orgId: 'o1' });
    expect(check(actorAs('x'), named('EVIL'), { resource: 'db:User', record: forged }, 'act')).toBe(
      false,
    );
    expect(check(actorAs('x'), named('Una'), { resource: 'db:User', record: forged }, 'act')).toBe(
      true,
    );
  });

  test('under a list item a declared path is loaded as written, never linked to a row met higher', async () => {
    const col = column('String');
    const people: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Project: {
              fields: {
                id: col,
                tasks: toMany('Task', {
                  relationName: 'TaskProject',
                  annotations: { permissions: { down: ['assignee.mentor.mentor.org'] } },
                }),
              },
            },
            Task: {
              fields: {
                id: col,
                projectId: col,
                assigneeId: col,
                project: toOne('Project', 'projectId', { relationName: 'TaskProject' }),
                assignee: toOne('User', 'assigneeId', { relationName: 'TaskAssignee' }),
              },
            },
            User: {
              fields: {
                id: col,
                orgId: col,
                mentorId: col,
                org: toOne('Org', 'orgId', { relationName: 'UserOrg' }),
                mentor: toOne('User', 'mentorId', { relationName: 'UserMentor' }),
              },
            },
            Org: { fields: { id: col, name: col } },
          },
        },
      },
    };
    const rows: Record<string, Record<string, Row>> = {
      'db:Project': { p1: { id: 'p1' } },
      'db:Task': { t1: { id: 't1', projectId: 'p1', assigneeId: 'u1' } },
      'db:User': {
        u1: { id: 'u1', orgId: 'o1', mentorId: 'u2' },
        u2: { id: 'u2', orgId: 'o1', mentorId: 'u1' },
      },
      'db:Org': { o1: { id: 'o1', name: 'acme' } },
    };
    const load = makeHydratorReadingEachRowThroughLoad({
      schemaMap: people,
      load: async (resource, where) => rows[resource]?.[where.id as string] ?? null,
      loadItems: async (resource, where) =>
        Object.values(rows[resource] ?? {}).filter((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ),
    });
    const project = await load('db:Project', { id: 'p1' });
    const schema: Rules = {
      permissions: {
        'db:Project': {
          actions: {
            read: {
              rel: 'tasks',
              arrayOperator: 'any',
              condition: reads('assignee.mentor.mentor.org.name', 'acme'),
            },
          },
        },
      },
    };
    expect(
      checkWithRules(people)(
        actorAs('x'),
        schema,
        { resource: 'db:Project', record: project },
        'read',
      ),
    ).toBe(true);
  });

  test('a schema resource that is not in the map is refused, not read with no lens', () => {
    const ghost: Rules = {
      permissions: { 'db:Ghost': { actions: { read: reads('members.0.role', 'admin') } } },
    };
    expect(codes(ghost)).toEqual(['lens']);
    expect(() =>
      check(
        actorAs('x'),
        ghost,
        { resource: 'db:Ghost', record: { members: [{ role: 'admin' }] } },
        'read',
      ),
    ).toThrow('`db:Ghost` is not a model of the map `db`');
  });

  test('a where consulted on a list item is judged at the item’s declared paths', () => {
    const where: Condition = { field: 'conversation.org.name', operator: 'equals', value: 'acme' };
    const list = listOf(schemaMap, 'db:Conversation', 'messages');
    const item = lensesAtRow(schemaMap, 'db:Message', {
      list: 'conversation.messages',
      listRelation: list as never,
      prefix: [],
    });
    expect(
      whyWhereLeavesLensAtRow(
        resolvedSchemaMap(schemaMap),
        lensesAtRow(schemaMap, 'db:Message'),
        where,
      ),
    ).toBeNull();
    expect(whyWhereLeavesLensAtRow(resolvedSchemaMap(schemaMap), item, where)).toMatch(
      /loads no `conversation` under an item/,
    );
  });
});

describe('the starting record: a row is known by resource and id', () => {
  const loads: string[] = [];
  const counting = makeHydratorReadingEachRowThroughLoad({
    schemaMap,
    load: async (resource, where) => {
      loads.push(`${resource}:${where.id}`);
      const row = db[resource]?.[where.id as string] ?? null;
      return row?.deletedAt ? null : row;
    },
    loadItems: async () => [],
  });
  const loopy: Rules = {
    permissions: {
      'db:User': {
        actions: { read: { any: [reads('name', 'Una'), { rel: 'org', action: 'read' }] } },
      },
      'db:Org': { actions: { read: { rel: 'creator', action: 'read' } } },
    },
  };

  test('a forged root: the loop holds the stored row, the root keeps what the caller gave', async () => {
    loads.length = 0;
    const forged = await counting('db:User', { id: 'u1', name: 'EVIL', orgId: 'o1' });
    const creator = (forged.org as Row).creator as Row;
    expect(creator).not.toBe(forged);
    expect([creator.name, forged.name]).toEqual(['Una', 'EVIL']);
    expect(creator.org).toBe(forged.org);
    expect(loads).toEqual(['db:Org:o1', 'db:User:u1']);
  });

  test('after-state around the loop: the stored copy of the root is the root, so the loop denies', async () => {
    const forged = await counting('db:User', { id: 'u1', name: 'EVIL', orgId: 'o1' });
    expect(check(actorAs('x'), loopy, { resource: 'db:User', record: forged }, 'read')).toBe(false);
    const stored = await counting('db:User', db['db:User']?.u1 as Row);
    expect(check(actorAs('x'), loopy, { resource: 'db:User', record: stored }, 'read')).toBe(true);
  });

  test('the grant check’s first pass: a data loop can place the granted row above itself (as on main)', async () => {
    const owner: PermixLike = { check: () => true };
    const held = (grantsBelow: boolean): PermixLike => ({
      check: () => false,
      entitlements: (resource, action) =>
        resource === 'db:User' && action === 'y'
          ? [
              {
                anchor: { resource: 'db:User', id: 'u1' },
                actions: { y: true },
                owner,
                ...(grantsBelow ? { grantsBelow: true as const } : {}),
              },
            ]
          : [],
    });
    const schema: Rules = {
      permissions: {
        'db:User': { actions: { x: { rel: 'org', action: 'read' }, y: null } },
        'db:Org': { actions: { read: { rel: 'creator', action: 'y' } } },
      },
    };
    const entry: EntitlementEntry = {
      resource: 'db:User',
      anchor: { resource: 'db:User', id: 'u1' },
      actions: { x: true },
    };
    const grants = (writer: PermixLike, user: Row) =>
      (pseudoRecordsOfEntitlement(schemaMap, entry, user) ?? []).every((pseudoRecord) =>
        canGrantWithRules(schemaMap)(writer, schema, entry, pseudoRecord),
      );
    const u1 = await counting('db:User', db['db:User']?.u1 as Row);
    // main's answer: u1 creates its own org, so the data places u1 above itself, and the writer
    // holds y there; restating the grant one row up with `where id = u1` is allowed on main too
    expect(grants(held(true), u1)).toBe(true);
    expect(grants(held(false), u1)).toBe(false);
    db['db:Org'] = { ...db['db:Org'], o2: { id: 'o2', name: 'beta', creatorId: 'attacker' } };
    const elsewhere = await counting('db:User', { ...(db['db:User']?.u1 as Row), orgId: 'o2' });
    expect(grants(held(true), elsewhere)).toBe(false);
  });

  test('a partial root, a root with no id or an empty one: the loop loads the stored row', async () => {
    for (const root of [
      { id: 'u1', orgId: 'o1' },
      { orgId: 'o1' },
      { id: '', orgId: 'o1', name: 'New' },
    ]) {
      loads.length = 0;
      const user = await counting('db:User', root);
      expect(((user.org as Row).creator as Row).name).toBe('Una');
      expect(loads).toEqual(['db:Org:o1', 'db:User:u1']);
    }
  });

  test('a self-referential key: the stored row once, holding itself', async () => {
    const col = column('String');
    const nodes: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Node: {
              fields: {
                id: col,
                name: col,
                parentId: col,
                parent: toOne('Node', 'parentId', { relationName: 'P' }),
              },
            },
          },
        },
      },
    };
    const seen: string[] = [];
    const load = makeHydrator({
      ...dbFieldMapOf(nodes),
      load: async (_resource, where) => {
        seen.push(String(where.id));
        return { id: 'n1', name: 'stored', parentId: 'n1' };
      },
    });
    const node = await load('db:Node', { id: 'n1', name: 'caller', parentId: 'n1' });
    const parent = node.parent as Row;
    expect([parent === node, parent.parent === parent, parent.name, seen]).toEqual([
      false,
      true,
      'stored',
      ['n1'],
    ]);
  });

  test('a row with a composite key is known by it: the stored copy of a self-parent root is the root', async () => {
    const col = column('String');
    const nodes = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Node: {
              fields: {
                org: col,
                key: col,
                name: col,
                parentOrg: col,
                parentKey: col,
                parent: {
                  kind: 'object',
                  type: 'Node',
                  isList: false,
                  fromFields: ['parentOrg', 'parentKey'],
                  toFields: ['org', 'key'],
                },
              },
              indexes: [{ kind: 'id', fields: ['org', 'key'] }],
            },
          },
        },
      },
    } satisfies SchemaMap;
    const stored = { org: 'o', key: 'k', name: 'Una', parentOrg: 'o', parentKey: 'k' };
    const load = makeHydrator({ ...dbFieldMapOf(nodes), load: async () => stored });
    const forged = await load('db:Node', { ...stored, name: 'EVIL' });
    const reads: Rules = {
      permissions: {
        'db:Node': {
          actions: {
            read: {
              any: [
                { rule: { field: 'name', operator: 'equals', value: 'Una' } },
                { rel: 'parent', action: 'read' },
              ],
            },
          },
        },
      },
    };
    const ask = checkWithRules(nodes);
    expect(ask(actorAs('x'), reads, { resource: 'db:Node', record: forged }, 'read')).toBe(false);
    expect(
      ask(actorAs('x'), reads, { resource: 'db:Node', record: forged.parent as Row }, 'read'),
    ).toBe(true);
  });

  test('a root key the caller changed loads the row it names, and nothing for a missing one', async () => {
    loads.length = 0;
    const moved = await counting('db:User', { id: 'u1', name: 'Una', orgId: 'o9' });
    expect(moved.org).toBeUndefined();
    expect(loads).toEqual(['db:Org:o9']);
  });

  test('a stand-in and a hand-built surface record have no id: each is its own row', () => {
    const entry: EntitlementEntry = {
      resource: 'db:Message',
      anchor: { resource: 'db:Conversation', id: 'c1', path: 'conversation' },
      actions: { act: true },
    };
    const [a, b] = [
      pseudoRecordsOfEntitlement(schemaMap, entry, db['db:Conversation']?.c1 as Row),
      pseudoRecordsOfEntitlement(schemaMap, entry, db['db:Conversation']?.c1 as Row),
    ];
    expect(a?.[0]).not.toBe(b?.[0]);
    const walk: Rules = {
      permissions: {
        'db:Message': { actions: { act: { rel: 'conversation', action: 'see' } } },
        'db:Conversation': { actions: { see: reads('orgId', 'o1') } },
      },
    };
    expect(
      check(actorAs('x'), walk, { resource: 'db:Message', record: a?.[0] as Row }, 'act'),
    ).toBe(true);
  });

  test('a soft-deleted root: the loop finds no stored row, so nothing is read there', async () => {
    db['db:User'] = {
      ...db['db:User'],
      gone: { id: 'gone', name: 'Gone', orgId: 'og', deletedAt: '2026-11-01' },
    };
    db['db:Org'] = { ...db['db:Org'], og: { id: 'og', name: 'ghost org', creatorId: 'gone' } };
    const gone = await counting('db:User', { id: 'gone', name: 'Gone', orgId: 'og' });
    expect((gone.org as Row).creator).toBeUndefined();
  });
});

describe('the limits throw; nothing is cut', () => {
  test('the lens refuses a map whose rows would hydrate past the budget, naming the resource and where', () => {
    const col = column('String');
    const names = Array.from({ length: 9 }, (_, i) => `M${i}`);
    const dense: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: Object.fromEntries(
            names.map((name) => [
              name,
              {
                fields: Object.fromEntries([
                  ['id', col],
                  ...names
                    .filter((other) => other !== name)
                    .flatMap((other) => [
                      [`${other.toLowerCase()}Id`, col],
                      [other.toLowerCase(), toOne(other, `${other.toLowerCase()}Id`)],
                    ]),
                ]),
              },
            ]),
          ),
        },
      },
    };
    expect(() => countRelationsOneRowHydrates(resolvedSchemaMap(dense), 'db:M0')).toThrow(
      `the lens of \`db:M0\` hydrates more than ${relationLensLimits.refuse} relations a row`,
    );
  });

  test('a chain longer than the depth cap throws, naming where', () => {
    const col = column('String');
    const length = relationLensLimits.depth + 2;
    const chain: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: Object.fromEntries(
            Array.from({ length }, (_, i) => [
              `C${i}`,
              {
                fields: {
                  id: col,
                  nextId: col,
                  ...(i + 1 < length ? { next: toOne(`C${i + 1}`, 'nextId') } : {}),
                },
              },
            ]),
          ),
        },
      },
    };
    expect(() => countRelationsOneRowHydrates(resolvedSchemaMap(chain), 'db:C0')).toThrow(
      `the lens of \`db:C0\` goes past ${relationLensLimits.depth} relations`,
    );
  });

  test('a hydration past its load budget throws', async () => {
    const col = column('String');
    const nodes: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Node: { fields: { id: col, parentId: col, parent: toOne('Node', 'parentId') } },
          },
        },
      },
    };
    const endless = makeHydrator({
      ...dbFieldMapOf(nodes),
      load: async (_resource, where) => {
        const i = Number(String(where.id).slice(1));
        return { id: `n${i}`, parentId: `n${i + 1}` };
      },
    });
    await expect(endless('db:Node', { id: 'n0', parentId: 'n1' })).rejects.toThrow(
      `past ${hydrationLimits.loads} rows`,
    );
  });
});

describe('a record passed with children already fetched', () => {
  test('a stored rule cannot name what the caller fetched; the hydrator replaces what it loads', async () => {
    const passed: Row = {
      id: 'c1',
      orgId: 'o1',
      org: {
        id: 'o1',
        name: 'forged',
        creatorId: 'attacker',
        creator: { id: 'attacker', name: 'Mal' },
      },
      messages: [{ id: 'mX', authorId: 'attacker', author: { id: 'attacker', name: 'Mal' } }],
      drafts: [{ id: 'd1', authorId: 'attacker' }],
      extra: { note: 'from the caller' },
    };
    const before = structuredClone(passed);
    const hydrated = await hydrate('db:Conversation', passed);
    expect(passed).toEqual(before);
    expect((hydrated.org as Row).name).toBe('acme');
    expect(((hydrated.org as Row).creator as Row).name).toBe('Una');
    expect((hydrated.messages as Row[]).map((message) => message.id)).toEqual(['m1']);
    expect(((hydrated.messages as Row[])[0]?.author as Row).name).toBe('Una');
    expect(hydrated.drafts).toBe(passed.drafts);
    expect(() =>
      check(
        actorAs('attacker'),
        ruled('db:Conversation', actorWrote('drafts.0.authorId')),
        { resource: 'db:Conversation', record: hydrated },
        'act',
      ),
    ).toThrow(/`db:Conversation.drafts` is a list/);
    expect(codes(ruled('db:Conversation', reads('extra.note', 'from the caller')))).toEqual([
      'lens',
    ]);
    const stored: Rules = {
      permissions: {
        'db:Conversation': {
          actions: {
            act: { rel: 'messages', arrayOperator: 'any', condition: reads('author.name', 'Mal') },
          },
        },
      },
    };
    expect(
      check(actorAs('x'), stored, { resource: 'db:Conversation', record: hydrated }, 'act'),
    ).toBe(false);
    expect(passed).toEqual(before);
  });
});

describe('json-rules’ operator fit check', () => {
  test('validateSchemaMap reports a date operator on a String column, which json-rules throws on when run', () => {
    const schema = ruled('db:User', {
      rule: { field: 'name', dateOperator: 'before', value: '2026-01-01' },
    } as ActionRule);
    expect(codes(schema)).toEqual(['operator_kind_mismatch']);
    expect(() =>
      check(
        actorAs('x'),
        schema,
        { resource: 'db:User', record: { id: 'u1', name: 'Una' } },
        'act',
      ),
    ).toThrow('is not a valid date');
  });
});

describe('the actor and the size of a lens', () => {
  test("a rule reads the actor's own columns at its own row only; a where never does", () => {
    expect(codes(ruled('db:User', reads('actor:User.id')))).toEqual([]);
    expect(codes(ruled('db:User', reads('actor:User.org.creator')))).toEqual(['lens']);
    expect(codes(ruled('db:User', reads('actor:Usr.id')))).toEqual(['lens']);
    expect(codes(ruled('db:User', reads('org.actor:User.id')))).toEqual(['lens']);
    expect(codes(ruled('db:User', reads('__actor.record.id')))).toEqual(['lens']);
    expect(
      whyEntitlementWhereLeavesLens(schemaMap, 'db:User', {
        field: 'actor:User.id',
        operator: 'exists',
      }),
    ).toMatch(/supplied rows are not on it/);
  });

  test('a resource whose row hydrates more than the report limit is a warning, not an error', () => {
    const col = column('String');
    const to = (prefix: string, count: number) =>
      Object.fromEntries([
        ['id', col],
        ...Array.from({ length: count }, (_, i) => [
          [`${prefix}${i}Id`, col],
          [`${prefix}${i}`, toOne(`${prefix.toUpperCase()}${i}`, `${prefix}${i}Id`)],
        ]).flat(),
      ]);
    const names = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => `${prefix}${i}`);
    const wide: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Hub: { fields: to('s', 40) },
            ...Object.fromEntries(names('S', 40).map((name) => [name, { fields: to('l', 30) }])),
            ...Object.fromEntries(names('L', 30).map((name) => [name, { fields: { id: col } }])),
          },
        },
      },
    };
    const result = validateSchemaMap(
      mapWith(wide, { permissions: { 'db:Hub': { actions: { read: null } } } }),
    );
    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(['countRelationsOneRowHydrates']);
  });

  test('a polymorphic row counts one kind: four kinds of 301 relations are not over the report limit', () => {
    const col = column('String');
    const leaves = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const kinds = ['K0', 'K1', 'K2', 'K3'];
    const poly: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Hub: {
              fields: Object.fromEntries([
                ['id', col],
                ['ownerModel', col],
                ...kinds.flatMap((kind) => [
                  [`${kind.toLowerCase()}Id`, col],
                  [kind.toLowerCase(), toOne(kind, `${kind.toLowerCase()}Id`)],
                ]),
              ]),
            },
            ...Object.fromEntries(
              kinds.map((kind) => [
                kind,
                {
                  fields: Object.fromEntries([
                    ['id', col],
                    ...leaves.flatMap((leaf) => [
                      [`${leaf.toLowerCase()}Id`, col],
                      [leaf.toLowerCase(), toOne(leaf, `${leaf.toLowerCase()}Id`)],
                    ]),
                  ]),
                },
              ]),
            ),
            ...Object.fromEntries(leaves.map((leaf) => [leaf, { fields: { id: col } }])),
          },
        },
      },
      polymorphismRegistries: {
        db: {
          Hub: {
            axes: [
              {
                field: 'ownerModel',
                fkMap: Object.fromEntries(kinds.map((kind) => [kind, [`${kind.toLowerCase()}Id`]])),
              },
            ],
          },
        },
      },
    };
    expect(countRelationsOneRowHydrates(resolvedSchemaMap(poly), 'db:Hub')).toBe(301);
    expect(
      validateSchemaMap(mapWith(poly, { permissions: { 'db:Hub': { actions: { read: null } } } }))
        .warnings,
    ).toEqual([]);
  });
});

describe('under a list item only the declared paths exist', () => {
  const schema: Rules = {
    permissions: {
      'db:Conversation': {
        actions: { read: { rel: 'messages', arrayOperator: 'any', condition: 'read' }, x: true },
      },
      'db:Message': { actions: { read: null } },
      'db:User': { actions: {} },
      'db:Org': { actions: {} },
    },
  };
  const message = (where: Condition): EntitlementEntry => ({
    resource: 'db:Message',
    anchor: { resource: 'db:Message', id: 'm1' },
    where,
    actions: { read: true },
  });

  test('B1: a where valid at its resource keeps its arms on an item; what the item lacks is unknown', async () => {
    const conversation = await hydrate('db:Conversation', db['db:Conversation']?.c1 as Row);
    const either: Condition = {
      any: [
        { field: 'author.name', operator: 'equals', value: 'Una' },
        { field: 'conversation.orgId', operator: 'equals', value: 'o1' },
      ],
    };
    const subject = { resource: 'db:Conversation', record: conversation };
    expect(check(actorAs('x', [message(either)]), schema, subject, 'read')).toBe(true);
    const outside: Condition = { field: 'conversation.orgId', operator: 'equals', value: 'o1' };
    expect(check(actorAs('x', [message(outside)]), schema, subject, 'read')).toBe(false);
  });

  test('B3: a row rule on an item keeps its arms', async () => {
    const conversation = await hydrate('db:Conversation', db['db:Conversation']?.c1 as Row);
    const [item] = conversation.messages as Row[];
    const rule: ActionRule = {
      any: [reads('author.name', 'Una'), { rel: 'conversation', action: 'x' }],
    };
    const record = { ...conversation, messages: [{ ...item, permissionRules: { read: rule } }] };
    expect(check(actorAs('x'), schema, { resource: 'db:Conversation', record }, 'read')).toBe(true);
  });

  test('an undeclared to-one that came back on an item is gone from it', async () => {
    const forged = makeHydratorReadingEachRowThroughLoad({
      schemaMap,
      load: async (resource, where) => db[resource]?.[where.id as string] ?? null,
      loadItems: async (resource, where) =>
        Object.values(db[resource] ?? {})
          .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
          .map((row) => ({ ...row, conversation: { id: 'c1', orgId: 'forged' } })),
    });
    const conversation = await forged('db:Conversation', db['db:Conversation']?.c1 as Row);
    const [item] = conversation.messages as Row[];
    expect(item && 'conversation' in item).toBe(false);
    expect((item?.author as Row).name).toBe('Una');
  });
});

describe('one down boundary: an item holds only its declared tree', () => {
  const col = column('String');
  const items: SchemaMap = {
    permissions: {},
    fieldMaps: {
      db: {
        models: {
          Org: { fields: { id: col, name: col } },
          User: { fields: { id: col, name: col } },
          Profile: {
            fields: {
              id: col,
              messageId: col,
              flag: col,
              message: toOne('Message', 'messageId', { relationName: 'MP' }),
            },
          },
          Reaction: {
            fields: {
              id: col,
              messageId: col,
              who: col,
              message: toOne('Message', 'messageId', { relationName: 'MR' }),
            },
          },
          Conversation: {
            fields: {
              id: col,
              messages: toMany('Message', {
                relationName: 'CM',
                annotations: { permissions: { down: ['author'] } },
              }),
            },
          },
          Message: {
            fields: {
              id: col,
              conversationId: col,
              authorId: col,
              hiddenOrgId: col,
              meta: column('Json'),
              permissionRules: column('Json'),
              conversation: toOne('Conversation', 'conversationId', { relationName: 'CM' }),
              author: toOne('User', 'authorId', { relationName: 'MA' }),
              hiddenOrg: toOne('Org', 'hiddenOrgId', {
                relationName: 'MH',
                annotations: { permissions: { hydrate: false } },
              }),
              profile: toOne('Profile', undefined, { relationName: 'MP' }),
              reactions: toMany('Reaction', {
                relationName: 'MR',
                annotations: { permissions: { down: [] } },
              }),
            },
          },
        },
      },
    },
  };
  const rows: Record<string, Record<string, Row>> = {
    'db:User': { u1: { id: 'u1', name: 'Una' } },
    'db:Conversation': { c1: { id: 'c1' } },
    'db:Message': {
      m1: { id: 'm1', conversationId: 'c1', authorId: 'u1', hiddenOrgId: 'o1', meta: { tag: 'x' } },
    },
  };
  const loading = (permissionRules: unknown) =>
    makeHydratorReadingEachRowThroughLoad({
      schemaMap: items,
      load: async (resource, where) => rows[resource]?.[where.id as string] ?? null,
      loadItems: async (resource, where) =>
        Object.values(rows[resource] ?? {})
          .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
          .map((row) => ({
            ...row,
            permissionRules,
            conversation: { id: 'c1' },
            author: { id: 'u1', name: 'EVIL' },
            hiddenOrg: { id: 'o1', name: 'FORGED' },
            profile: { id: 'p', flag: 'FORGED' },
            reactions: [{ id: 'r', who: 'evil' }],
          })),
    });
  const schema: Rules = {
    permissions: {
      'db:Conversation': {
        actions: { read: { rel: 'messages', arrayOperator: 'any', condition: 'read' } },
      },
      'db:Message': { actions: { read: null } },
      'db:User': { actions: {} },
      'db:Org': { actions: {} },
      'db:Reaction': { actions: {} },
      'db:Profile': { actions: {} },
    },
  };

  test('everything a loader returned on an item but the declaration does not load is gone', async () => {
    const conversation = await loading(null)('db:Conversation', rows['db:Conversation']?.c1 as Row);
    const [item] = conversation.messages as Row[];
    expect(Object.keys(item as Row).sort()).toEqual(
      [
        'author',
        'authorId',
        'conversationId',
        'hiddenOrgId',
        'id',
        'meta',
        'permissionRules',
      ].sort(),
    );
    expect((item?.author as Row).name).toBe('Una');
  });

  test('a row rule on an item never crosses a second list', async () => {
    const rule: ActionRule = {
      rel: 'reactions',
      arrayOperator: 'any',
      condition: { rule: { field: 'who', operator: 'equals', value: 'evil' } },
    };
    const conversation = await loading({ read: rule })(
      'db:Conversation',
      rows['db:Conversation']?.c1 as Row,
    );
    const ask = checkWithRules(items);
    expect(
      ask(actorAs('x'), schema, { resource: 'db:Conversation', record: conversation }, 'read'),
    ).toBe(false);
    const [item] = conversation.messages as Row[];
    const leaked = {
      ...conversation,
      messages: [{ ...item, reactions: [{ id: 'r', who: 'evil' }] }],
    };
    expect(ask(actorAs('x'), schema, { resource: 'db:Conversation', record: leaked }, 'read')).toBe(
      false,
    );
  });
});

describe('a row’s key', () => {
  test('the engine id field wins over the model’s isId column, as the app loads by it', () => {
    const col = column('String');
    const keyed: SchemaMap = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Brand: {
              fields: { id: column('Int', { isId: true }), uuid: col },
            },
          },
        },
      },
    };
    expect(identityKeyOfRow(keyed, 'db:Brand', { uuid: 'b-1' }, 'uuid')).toBe(
      identityKeyOfRow(keyed, 'db:Brand', { uuid: 'b-1', id: 7 }, 'uuid'),
    );
    expect(identityKeyOfRow(keyed, 'db:Brand', { id: 7 }, 'uuid')).toBe(
      identityKeyOfRow(keyed, 'db:Brand', { id: 7 }, 'uuid'),
    );
    expect(identityKeyOfRow(keyed, 'db:Brand', {}, 'uuid')).toBeUndefined();
  });

  test('composite values never collide across a NUL', () => {
    const col = column('String');
    const pair = {
      permissions: {},
      fieldMaps: {
        db: {
          models: {
            Pair: { fields: { a: col, b: col }, indexes: [{ kind: 'id', fields: ['a', 'b'] }] },
          },
        },
      },
    } satisfies SchemaMap;
    expect(identityKeyOfRow(pair, 'db:Pair', { a: 'x\u0000', b: 'y' })).not.toBe(
      identityKeyOfRow(pair, 'db:Pair', { a: 'x', b: '\u0000y' }),
    );
  });
});

describe('the apps’ own maps', () => {
  const zealot: SchemaMap = declaringSuppliedBridges({
    permissions: {},
    fieldMaps: { db: { models: loadModels('zealot') } },
    suppliedFieldMaps: { actor: actorMap },
  });
  const participantReads = (field: string): Rules => ({
    permissions: {
      'db:Conversation': {
        actions: {
          act: {
            rel: 'participants',
            arrayOperator: 'any',
            condition: {
              rule: {
                all: [
                  { field, operator: 'exists' },
                  { field: 'actor:User.uuid', operator: 'exists' },
                  { field, operator: 'equals', path: 'actor:User.uuid' },
                ],
              },
            },
          },
        },
      },
    },
  });

  test('Zealot: under a participant a declared path reads; at a landing only the rest of `down` does', () => {
    const ask = acting(checkWithRules(zealot));
    const record = {
      uuid: 'c1',
      participants: [{ uuid: 'p1', forumUser: { fanUser: { userUuid: 'u-fay' } } }],
    };
    const fay: PermixLike = { check: () => false };
    actedBy.set(fay, { uuid: 'u-fay' });
    const declared = participantReads('forumUser.fanUser.userUuid');
    expect(validateSchemaMap(mapWith(zealot, declared)).ok).toBe(true);
    expect(ask(fay, declared, { resource: 'db:Conversation', record }, 'act')).toBe(true);
    const landing: Rules = {
      permissions: {
        'db:Conversation': {
          actions: {
            act: {
              rel: 'participants',
              arrayOperator: 'any',
              condition: { rel: 'forumUser', action: 'x' },
            },
          },
        },
        'db:ForumUser': {
          actions: {
            x: {
              rule: {
                all: [
                  { field: 'brand.uuid', operator: 'exists' },
                  { field: 'actor:User.uuid', operator: 'exists' },
                  { field: 'brand.uuid', operator: 'equals', path: 'actor:User.uuid' },
                ],
              },
            },
          },
        },
      },
    };
    expect([
      ...new Set(validateSchemaMap(mapWith(zealot, landing)).errors.map((issue) => issue.code)),
    ]).toEqual(['down']);
  });

  test('Kingdom: a surface rule reads through its synthetic integrationResource relation', () => {
    const kingdom: SchemaMap = {
      permissions: {},
      fieldMaps: { db: { models: loadModels('kingdom') } },
    };
    const schema: Rules = {
      permissions: {
        'db:SlackChannelOperation': {
          actions: { act: reads('integrationResource.integration.provider', 'github') },
        },
      },
    };
    expect(validateSchemaMap(mapWith(kingdom, schema)).ok).toBe(true);
    const surface = {
      operation: 'post',
      integrationResourceId: 'r1',
      integrationResource: {
        id: 'r1',
        integrationId: 'i1',
        integration: { id: 'i1', provider: 'github' },
      },
    };
    const ask = checkWithRules(kingdom);
    expect(
      ask(actorAs('x'), schema, { resource: 'db:SlackChannelOperation', record: surface }, 'act'),
    ).toBe(true);
  });
});
