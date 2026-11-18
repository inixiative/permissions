import { describe, expect, test } from 'bun:test';
import type { FieldMap, RelationField, ScalarField, ScalarType } from '@inixiative/field-map';
import type { Condition } from '@inixiative/json-rules';
import {
  type ActionRule,
  createCanGrantEntitlement,
  createHydrator,
  createRebacCheck,
  createRebacPaths,
  type EntitlementEntry,
  entitlementProblem,
  type PermixLike,
  placeEntitlement,
  type RebacSchema,
  type Row,
  type SchemaMap,
  validateSchema,
  whyEntitlementWhereLeavesLens,
} from '../index';
import {
  countRelationsOneRowHydrates,
  lensesAtRow,
  relationLensLimits,
  whyWhereLeavesLensAtRow,
} from '../src/core/lens';
import { identityKeyOfRow, listOf } from '../src/core/schemaMap';
import { hydrationLimits } from '../src/helpers/hydration/hydrate';
import { loadModels } from './fixtures/load';

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
const map: SchemaMap = {
  resources: {
    org: 'Org',
    user: 'User',
    profile: 'Profile',
    entitlement: 'Entitlement',
    conversation: 'Conversation',
    message: 'Message',
    draft: 'Draft',
    signet: 'Signet',
  },
  fieldMap,
};

const db: Record<string, Record<string, Row>> = {
  org: { o1: { id: 'o1', name: 'acme', creatorId: 'u1' } },
  user: {
    u1: { id: 'u1', name: 'Una', orgId: 'o1' },
    attacker: { id: 'attacker', name: 'Mal', orgId: 'o1' },
  },
  profile: { p1: { id: 'p1', userId: 'attacker', bannedAt: '2026-02-02' } },
  conversation: { c1: { id: 'c1', orgId: 'o1', permissionRules: null } },
  message: { m1: { id: 'm1', conversationId: 'c1', authorId: 'u1', mentions: ['aron'] } },
};
const hydrate = createHydrator({
  map,
  load: async (resource, where) => db[resource]?.[where.id as string] ?? null,
  loadMany: async (resource, where) =>
    Object.values(db[resource] ?? {}).filter((row) =>
      Object.entries(where).every(([key, value]) => row[key] === value),
    ),
});
const check = createRebacCheck(map);

const actorAs = (id: string, entitlements: EntitlementEntry[] = []): PermixLike => {
  const owner: PermixLike = { check: () => true, getActor: () => null };
  return {
    check: () => false,
    getActor: () => ({ model: 'User', record: { id } }),
    entitlements: (resource, action) =>
      entitlements
        .filter((entry) => entry.resource === resource && entry.actions[action] === true)
        .map((entry) => ({ ...entry, owner })),
  };
};
const ruled = (resource: string, rule: ActionRule): RebacSchema => ({
  permissions: { [resource]: { actions: { act: rule } } },
});
const reads = (field: string, value: unknown = null): ActionRule => ({
  rule: { field, operator: 'equals', value } as Condition,
});
const actorWrote = (field: string): ActionRule => ({
  rule: { field, operator: 'equals', path: '__actor.record.id' },
});
const codes = (schema: RebacSchema) =>
  validateSchema(map, schema).errors.map((issue) => issue.code);

describe('reads the hydrator never loaded are refused', () => {
  test('a path through an undeclared list a request body filled is refused', async () => {
    const body = await hydrate('conversation', {
      id: 'c1',
      orgId: 'o1',
      drafts: [{ authorId: 'attacker' }],
    });
    expect(body.drafts).toEqual([{ authorId: 'attacker' }]);
    const schema = ruled('conversation', actorWrote('drafts.0.authorId'));
    expect(() =>
      check(actorAs('attacker'), schema, { resource: 'conversation', record: body }, 'act'),
    ).toThrow(/`conversation.drafts` is a list: no path reads into one; declare it/);
    expect(codes(schema)).toEqual(['lens']);
  });

  test('the same read in a bracket spelling is refused, on a declared list too', async () => {
    const record = { id: 'c1', orgId: 'o1', drafts: [{ authorId: 'attacker' }] };
    for (const field of [
      '["drafts"][0]["authorId"]',
      'drafts[0].authorId',
      "['messages'][0].authorId",
    ]) {
      const schema = ruled('conversation', actorWrote(field));
      expect(() =>
        check(actorAs('attacker'), schema, { resource: 'conversation', record }, 'act'),
      ).toThrow(/is a list/);
    }
    const declared = ruled('conversation', actorWrote('["messages"][0]["authorId"]'));
    expect(validateSchema(map, declared).errors[0]?.message).toMatch(
      /cross it with \{ rel: 'messages', arrayOperator: 'any', condition \}/,
    );
  });

  test('a relation keyed on the other side is refused, so a banned user never reads as unbanned', async () => {
    const attacker = await hydrate('user', db.user?.attacker as Row);
    const schema = ruled('user', reads('profile.bannedAt'));
    expect(() =>
      check(actorAs('attacker'), schema, { resource: 'user', record: attacker }, 'act'),
    ).toThrow(/`user.profile` keeps its foreign key on `Profile`: nothing loads it/);
    const claimed = { ...attacker, profile: { bannedAt: null } };
    const inline = () =>
      check(
        actorAs('attacker'),
        { permissions: {} },
        { resource: 'user', record: claimed },
        reads('profile.bannedAt'),
      );
    expect(inline).toThrow(/keeps its foreign key/);
  });

  test('a schema is frozen on its first check; an edit afterwards throws and changes nothing', async () => {
    const record = await hydrate('conversation', { id: 'c1', orgId: 'o1' });
    const schema = ruled('conversation', reads('orgId', 'nope'));
    expect(check(actorAs('attacker'), schema, { resource: 'conversation', record }, 'act')).toBe(
      false,
    );
    const actions = schema.permissions.conversation?.actions as Record<string, ActionRule>;
    expect(() => {
      actions.act = true;
    }).toThrow();
    expect(check(actorAs('attacker'), schema, { resource: 'conversation', record }, 'act')).toBe(
      false,
    );
  });

  test('an entitlement whose where reads into a list never holds, and is never granted', async () => {
    const entry: EntitlementEntry = {
      resource: 'conversation',
      anchor: { resource: 'conversation', id: 'c1' },
      where: { field: 'drafts.0.authorId', operator: 'equals', value: 'attacker' },
      actions: { act: true },
    };
    const record = {
      ...(await hydrate('conversation', { id: 'c1', orgId: 'o1' })),
      drafts: [{ authorId: 'attacker' }],
    };
    const schema = ruled('conversation', null);
    expect(
      check(actorAs('attacker', [entry]), schema, { resource: 'conversation', record }, 'act'),
    ).toBe(false);
    expect(entitlementProblem(entry)).toBeNull();
    expect(whyEntitlementWhereLeavesLens(map, entry.resource, entry.where)).toMatch(
      /reads outside the lens: `conversation.drafts` is a list/,
    );
    const writer: PermixLike = { check: () => true, getActor: () => null };
    expect(createCanGrantEntitlement(map)(writer, schema, entry, record)).toBe(false);
  });

  test('a path back to a model is refused; the hydrator links the row it would read', async () => {
    const attacker = await hydrate('user', db.user?.attacker as Row);
    const org = attacker.org as Row;
    expect((org.creator as Row).org).toBe(org);
    for (const field of ['org.creator.org.name', 'org.creator.name'])
      expect(() =>
        check(
          actorAs('attacker'),
          ruled('user', reads(field)),
          { resource: 'user', record: attacker },
          'act',
        ),
      ).toThrow(/comes back to `user`: a path back to a model is not in the lens/);
  });

  test('a rel back to a model is two hops; each lands on the real row, and a where there holds on it', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    expect(((u1.org as Row).creator as Row).org).toBe(u1.org);
    const oneHop: RebacSchema = {
      permissions: {
        user: { actions: { act: { rel: 'org.creator', action: 'vouch' }, vouch: null } },
      },
    };
    expect(() => check(actorAs('x'), oneHop, { resource: 'user', record: u1 }, 'act')).toThrow(
      /`org.creator` comes back to `user`/,
    );
    const twoHops = (vouch: ActionRule): RebacSchema => ({
      permissions: {
        user: { actions: { act: { rel: 'org', action: 'creator' }, vouch } },
        org: { actions: { creator: { rel: 'creator', action: 'vouch' } } },
      },
    });
    const subject = { resource: 'user', record: u1 };
    expect(check(actorAs('x'), twoHops(reads('org.name', null)), subject, 'act')).toBe(false);
    expect(check(actorAs('x'), twoHops(reads('org.name', 'acme')), subject, 'act')).toBe(true);
    const held = (value: string | null): EntitlementEntry => ({
      resource: 'user',
      anchor: { resource: 'user', id: 'u1' },
      where: { field: 'org.name', operator: 'equals', value },
      actions: { vouch: true },
    });
    expect(check(actorAs('x', [held(null)]), twoHops(null), subject, 'act')).toBe(false);
    expect(check(actorAs('x', [held('acme')]), twoHops(null), subject, 'act')).toBe(true);
    const conversation = await hydrate('conversation', db.conversation?.c1 as Row);
    const fromConversation: RebacSchema = {
      permissions: {
        conversation: { actions: { act: { rel: 'org.creator', action: 'vouch' } } },
        user: { actions: { vouch: reads('org.name', null) } },
      },
    };
    expect(
      check(
        actorAs('x'),
        fromConversation,
        { resource: 'conversation', record: conversation },
        'act',
      ),
    ).toBe(false);
  });
});

describe('a loop made by data denies; a schema that names itself throws', () => {
  const walks: RebacSchema = {
    permissions: {
      user: { actions: { own: null, read: { any: ['own', { rel: 'org', action: 'read' }] } } },
      org: { actions: { read: { rel: 'creator', action: 'read' } } },
    },
  };
  const owns = (id: string): PermixLike => ({
    check: (resource, action, recordId) =>
      resource === 'user' && action === 'own' && recordId === id,
    getActor: () => null,
  });

  test('around the cycle: no grant denies, the owner is allowed, paths agree', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    expect(((u1.org as Row).creator as Row).org).toBe(u1.org);
    const subject = { resource: 'user', record: u1 };
    expect(check(actorAs('x'), walks, subject, 'read')).toBe(false);
    expect(check(owns('u1'), walks, subject, 'read')).toBe(true);
    expect(createRebacPaths(map)(actorAs('x'), walks, subject, 'read')).toEqual([]);
    expect(createRebacPaths(map)(owns('u1'), walks, subject, 'read')).toEqual([[]]);
  });

  test('a sibling arm beside the looping arm is judged', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    const sibling: RebacSchema = {
      permissions: {
        user: {
          actions: {
            own: null,
            read: { any: [{ rel: 'org', action: 'read' }, reads('name', 'Una')] },
          },
        },
        org: { actions: { read: { rel: 'creator', action: 'read' } } },
      },
    };
    expect(check(actorAs('x'), sibling, { resource: 'user', record: u1 }, 'read')).toBe(true);
  });

  test('the grant check on a cyclic anchor denies instead of throwing, and allows as on a tree', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    const tree = { ...(db.org?.o1 as Row) };
    const entry: EntitlementEntry = {
      resource: 'user',
      anchor: { resource: 'org', id: 'o1', path: 'org' },
      actions: { read: true },
    };
    const grants = (writer: PermixLike, anchor: Row) =>
      (placeEntitlement(map, entry, anchor) ?? []).every((placed) =>
        createCanGrantEntitlement(map)(writer, walks, entry, placed),
      );
    const orgReader: PermixLike = { check: (resource) => resource === 'org', getActor: () => null };
    const nobody: PermixLike = { check: () => false, getActor: () => null };
    expect(grants(orgReader, u1.org as Row)).toBe(true);
    expect(grants(orgReader, tree)).toBe(true);
    expect(grants(nobody, u1.org as Row)).toBe(false);
    expect(grants(nobody, tree)).toBe(false);
  });

  test('a rule that names itself on the same record throws', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    const selfLoop: RebacSchema = {
      permissions: { user: { actions: { read: { any: ['read'] } } } },
    };
    expect(() => check(actorAs('x'), selfLoop, { resource: 'user', record: u1 }, 'read')).toThrow(
      /Cycle detected/,
    );
  });
});

describe('computed keys, class instances, frozen wheres and the actor in a where', () => {
  test('a computed key on a row reached by { rel } is refused, so a set plan never reads as null', () => {
    const schema: RebacSchema = {
      permissions: {
        conversation: { actions: { act: { rel: 'org', action: 'a' } } },
        org: { actions: { a: reads('plan', null) } },
      },
    };
    const record = { id: 'c1', orgId: 'o1', org: { id: 'o1', name: 'acme', plan: 'pro' } };
    expect(() => check(actorAs('x'), schema, { resource: 'conversation', record }, 'act')).toThrow(
      '`org` has no field `plan` (`plan`)',
    );
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
        ruled('user', reads('org.name', value)),
        { resource: 'user', record },
        'act',
      );
    expect(at(null)).toBe(false);
    expect(at('acme')).toBe(true);
  });

  test('an entitlement where is frozen when first judged; an edit afterwards throws', () => {
    const where: Condition = { field: 'name', operator: 'equals', value: 'Una' };
    const entry: EntitlementEntry = {
      resource: 'user',
      anchor: { resource: 'user', id: 'u1' },
      where,
      actions: { act: true },
    };
    const record = { id: 'u1', name: 'Una', orgId: 'o1' };
    const ask = () =>
      check(actorAs('x', [entry]), ruled('user', null), { resource: 'user', record }, 'act');
    expect(ask()).toBe(true);
    expect(() => {
      (where as { field: string }).field = 'profile.bannedAt';
    }).toThrow();
    expect(ask()).toBe(true);
  });

  test('a where reads the record alone, so an `__actor` path in it is refused', () => {
    const entry: EntitlementEntry = {
      resource: 'user',
      anchor: { resource: 'user', id: 'u1' },
      where: { field: '__actor.record.id', operator: 'equals', value: null },
      actions: { act: true },
    };
    const record = { id: 'u1', orgId: 'o1' };
    expect(
      check(actorAs('u1', [entry]), ruled('user', null), { resource: 'user', record }, 'act'),
    ).toBe(false);
    expect(whyEntitlementWhereLeavesLens(map, 'user', entry.where)).toMatch(
      /`__actor` is not on it/,
    );
    expect(codes(ruled('user', actorWrote('id')))).toEqual([]);
  });
});

describe('what the lens keeps', () => {
  test('a column of a relation, a Json sub-path, a scalar list (never indexed); never a computed key', async () => {
    const message = await hydrate('message', db.message?.m1 as Row);
    const passes = (rule: ActionRule, record: Row = message) =>
      check(actorAs('attacker'), ruled('message', rule), { resource: 'message', record }, 'act');
    expect(passes(reads('conversation.org.name', 'acme'))).toBe(true);
    expect(passes({ rule: { field: 'mentions', operator: 'contains', value: 'aron' } })).toBe(true);
    expect(() => passes(reads('mentions.0', 'aron'))).toThrow(/`mentions` is a column/);
    expect(
      passes(reads('conversation.meta.flags.0', 'x'), {
        ...message,
        conversation: { ...(message.conversation as Row), meta: { flags: ['x'] } },
      }),
    ).toBe(true);
    const scored = { resource: 'message', record: { ...message, score: 7 } };
    expect(() => check(actorAs('x'), ruled('message', null), scored, reads('score', 7))).toThrow(
      '`message` has no field `score`',
    );
    expect(codes(ruled('message', reads('conversation.meta.a.b')))).toEqual([]);
  });

  test('two relations of one row to one model are both visible', async () => {
    const signet = { id: 's1', userId: 'u1', recipientUserId: 'attacker' };
    const hydrated = await hydrate('signet', signet);
    const rule: ActionRule = {
      all: [
        reads('user.name', 'Una'),
        reads('recipientUser.name', 'Mal'),
        reads('user.org.name', 'acme'),
      ],
    };
    expect(codes(ruled('signet', rule))).toEqual([]);
    expect(
      check(actorAs('x'), ruled('signet', rule), { resource: 'signet', record: hydrated }, 'act'),
    ).toBe(true);
  });

  test('a where on a scalar list, and a declared leaf that comes back to a model', async () => {
    const entry: EntitlementEntry = {
      resource: 'message',
      anchor: { resource: 'message', id: 'm1' },
      where: { field: 'mentions', operator: 'contains', value: 'aron' },
      actions: { act: true },
    };
    expect(whyEntitlementWhereLeavesLens(map, entry.resource, entry.where)).toBeNull();
    const message = await hydrate('message', db.message?.m1 as Row);
    expect(
      check(
        actorAs('x', [entry]),
        ruled('message', null),
        { resource: 'message', record: message },
        'act',
      ),
    ).toBe(true);

    const leaf: ActionRule = {
      rel: 'messages',
      arrayOperator: 'any',
      condition: reads('author.org.creator.name', 'Una'),
    };
    expect(codes(ruled('conversation', leaf))).toEqual([]);
    const conversation = await hydrate('conversation', db.conversation?.c1 as Row);
    expect(
      check(
        actorAs('x'),
        ruled('conversation', leaf),
        { resource: 'conversation', record: conversation },
        'act',
      ),
    ).toBe(true);
    expect(codes(ruled('message', reads('author.org.creator.name')))).toEqual(['lens']);
  });

  test('a key the model does not have and an index are refused, wherever the rule came from', () => {
    expect(validateSchema(map, ruled('user', reads('org.plann'))).errors[0]?.message).toBe(
      '`org` has no field `plann` (`org.plann`)',
    );
    expect(validateSchema(map, ruled('user', reads('org.0.name'))).errors[0]?.message).toMatch(
      /`org` is one row and is never indexed/,
    );
    expect(validateSchema(map, ruled('user', reads('plann'))).errors[0]?.message).toBe(
      '`user` has no field `plann` (`plann`)',
    );
    const inline = (rule: ActionRule) =>
      check(
        actorAs('x'),
        ruled('user', null),
        { resource: 'user', record: { id: 'u1', plann: 1 } },
        rule,
      );
    expect(() => inline(reads('plann', 1))).toThrow('`user` has no field `plann`');
    expect(() => inline({ any: [reads('plann', 1)] })).toThrow('`user` has no field `plann`');
    const rowRule = { id: 'u1', plann: 1, permissionRules: { act: reads('plann', 1) } };
    expect(
      check(actorAs('x'), ruled('user', null), { resource: 'user', record: rowRule }, 'act'),
    ).toBe(false);
    expect(
      whyEntitlementWhereLeavesLens(map, 'user', { field: 'plann', operator: 'equals', value: 1 }),
    ).toMatch(/`user` has no field `plann`/);
    expect(codes(ruled('user', reads('__actor.record.org.creator.org')))).toEqual([]);
  });
});

describe('the record a check reads is a view', () => {
  test('a check never changes the caller’s record', async () => {
    const record = {
      ...(await hydrate('conversation', db.conversation?.c1 as Row)),
      drafts: [{ id: 'd1' }],
      computed: { a: 1 },
    };
    const before = structuredClone(record);
    const schema = ruled('conversation', {
      any: [
        reads('org.name', 'nope'),
        { rel: 'messages', arrayOperator: 'any', condition: reads('author.name', 'Una') },
      ],
    });
    expect(check(actorAs('x'), schema, { resource: 'conversation', record }, 'act')).toBe(true);
    expect(record).toEqual(before);
  });

  test('an undeclared list the app loaded stays on the record, after hydration and after a check', async () => {
    const targetEntitlements = [{ id: 'e1', targetId: 'u1' }];
    const user = await hydrate('user', { ...(db.user?.u1 as Row), targetEntitlements });
    expect(user.targetEntitlements).toBe(targetEntitlements);
    const schema = ruled('user', reads('org.name', 'acme'));
    expect(check(actorAs('x'), schema, { resource: 'user', record: user }, 'act')).toBe(true);
    expect(user.targetEntitlements).toBe(targetEntitlements);
    expect(codes(ruled('user', reads('targetEntitlements.0.id', 'e1')))).toEqual(['lens']);
  });
});

describe('the root, item paths, unknown resources and wheres on an item', () => {
  test('an edge back to the root loads the stored row: the caller’s record is not believed there', async () => {
    const named = (value: unknown): RebacSchema => ({
      permissions: {
        user: {
          actions: { act: { rel: 'org', action: 'creator' }, named: reads('name', value) },
        },
        org: { actions: { creator: { rel: 'creator', action: 'named' } } },
      },
    });
    const partial = await hydrate('user', { id: 'u1', orgId: 'o1' });
    const creator = (partial.org as Row).creator as Row;
    expect(creator).not.toBe(partial);
    expect(creator.name).toBe('Una');
    expect(check(actorAs('x'), named(null), { resource: 'user', record: partial }, 'act')).toBe(
      false,
    );
    const forged = await hydrate('user', { id: 'u1', name: 'EVIL', orgId: 'o1' });
    expect(check(actorAs('x'), named('EVIL'), { resource: 'user', record: forged }, 'act')).toBe(
      false,
    );
    expect(check(actorAs('x'), named('Una'), { resource: 'user', record: forged }, 'act')).toBe(
      true,
    );
  });

  test('under a list item a declared path is loaded as written, never linked to a row met higher', async () => {
    const col = column('String');
    const people: SchemaMap = {
      resources: { project: 'Project', task: 'Task', user: 'User', org: 'Org' },
      fieldMap: {
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
    };
    const rows: Record<string, Record<string, Row>> = {
      task: { t1: { id: 't1', projectId: 'p1', assigneeId: 'u1' } },
      user: {
        u1: { id: 'u1', orgId: 'o1', mentorId: 'u2' },
        u2: { id: 'u2', orgId: 'o1', mentorId: 'u1' },
      },
      org: { o1: { id: 'o1', name: 'acme' } },
    };
    const load = createHydrator({
      map: people,
      load: async (resource, where) => rows[resource]?.[where.id as string] ?? null,
      loadMany: async (resource, where) =>
        Object.values(rows[resource] ?? {}).filter((row) =>
          Object.entries(where).every(([key, value]) => row[key] === value),
        ),
    });
    const project = await load('project', { id: 'p1' });
    const schema: RebacSchema = {
      permissions: {
        project: {
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
      createRebacCheck(people)(
        actorAs('x'),
        schema,
        { resource: 'project', record: project },
        'read',
      ),
    ).toBe(true);
  });

  test('a schema resource that is not in the map is refused, not read with no lens', () => {
    const ghost: RebacSchema = {
      permissions: { ghost: { actions: { read: reads('members.0.role', 'admin') } } },
    };
    expect(codes(ghost)).toEqual(['lens']);
    expect(() =>
      check(
        actorAs('x'),
        ghost,
        { resource: 'ghost', record: { members: [{ role: 'admin' }] } },
        'read',
      ),
    ).toThrow('`ghost` is not a resource in the map');
  });

  test('a where consulted on a list item is judged at the item’s declared paths', () => {
    const where: Condition = { field: 'conversation.org.name', operator: 'equals', value: 'acme' };
    const list = listOf(map, 'conversation', 'messages');
    const item = lensesAtRow(map, 'message', {
      list: 'conversation.messages',
      listRelation: list as never,
      prefix: [],
    });
    expect(whyWhereLeavesLensAtRow(map, lensesAtRow(map, 'message'), where)).toBeNull();
    expect(whyWhereLeavesLensAtRow(map, item, where)).toMatch(
      /loads no `conversation` under an item/,
    );
  });
});

describe('the starting record: a row is known by resource and id', () => {
  const loads: string[] = [];
  const counting = createHydrator({
    map,
    load: async (resource, where) => {
      loads.push(`${resource}:${where.id}`);
      const row = db[resource]?.[where.id as string] ?? null;
      return row?.deletedAt ? null : row;
    },
    loadMany: async () => [],
  });
  const loopy: RebacSchema = {
    permissions: {
      user: { actions: { read: { any: [reads('name', 'Una'), { rel: 'org', action: 'read' }] } } },
      org: { actions: { read: { rel: 'creator', action: 'read' } } },
    },
  };

  test('a forged root: the loop holds the stored row, the root keeps what the caller gave', async () => {
    loads.length = 0;
    const forged = await counting('user', { id: 'u1', name: 'EVIL', orgId: 'o1' });
    const creator = (forged.org as Row).creator as Row;
    expect(creator).not.toBe(forged);
    expect([creator.name, forged.name]).toEqual(['Una', 'EVIL']);
    expect(creator.org).toBe(forged.org);
    expect(loads).toEqual(['org:o1', 'user:u1']);
  });

  test('after-state around the loop: the stored copy of the root is the root, so the loop denies', async () => {
    const forged = await counting('user', { id: 'u1', name: 'EVIL', orgId: 'o1' });
    expect(check(actorAs('x'), loopy, { resource: 'user', record: forged }, 'read')).toBe(false);
    const stored = await counting('user', db.user?.u1 as Row);
    expect(check(actorAs('x'), loopy, { resource: 'user', record: stored }, 'read')).toBe(true);
  });

  test('the grant check’s first pass: a data loop can place the granted row above itself (as on main)', async () => {
    const owner: PermixLike = { check: () => true, getActor: () => null };
    const held = (grantsBelow: boolean): PermixLike => ({
      check: () => false,
      getActor: () => null,
      entitlements: (resource, action) =>
        resource === 'user' && action === 'y'
          ? [
              {
                anchor: { resource: 'user', id: 'u1' },
                actions: { y: true },
                owner,
                ...(grantsBelow ? { grantsBelow: true as const } : {}),
              },
            ]
          : [],
    });
    const schema: RebacSchema = {
      permissions: {
        user: { actions: { x: { rel: 'org', action: 'read' }, y: null } },
        org: { actions: { read: { rel: 'creator', action: 'y' } } },
      },
    };
    const entry: EntitlementEntry = {
      resource: 'user',
      anchor: { resource: 'user', id: 'u1' },
      actions: { x: true },
    };
    const grants = (writer: PermixLike, user: Row) =>
      (placeEntitlement(map, entry, user) ?? []).every((placed) =>
        createCanGrantEntitlement(map)(writer, schema, entry, placed),
      );
    const u1 = await counting('user', db.user?.u1 as Row);
    // main's answer: u1 creates its own org, so the data places u1 above itself, and the writer
    // holds y there; restating the grant one row up with `where id = u1` is allowed on main too
    expect(grants(held(true), u1)).toBe(true);
    expect(grants(held(false), u1)).toBe(false);
    db.org = { ...db.org, o2: { id: 'o2', name: 'beta', creatorId: 'attacker' } };
    const elsewhere = await counting('user', { ...(db.user?.u1 as Row), orgId: 'o2' });
    expect(grants(held(true), elsewhere)).toBe(false);
  });

  test('a partial root, a root with no id or an empty one: the loop loads the stored row', async () => {
    for (const root of [
      { id: 'u1', orgId: 'o1' },
      { orgId: 'o1' },
      { id: '', orgId: 'o1', name: 'New' },
    ]) {
      loads.length = 0;
      const user = await counting('user', root);
      expect(((user.org as Row).creator as Row).name).toBe('Una');
      expect(loads).toEqual(['org:o1', 'user:u1']);
    }
  });

  test('a self-referential key: the stored row once, holding itself', async () => {
    const col = column('String');
    const nodes: SchemaMap = {
      resources: { node: 'Node' },
      fieldMap: {
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
    };
    const seen: string[] = [];
    const load = createHydrator({
      map: nodes,
      load: async (_resource, where) => {
        seen.push(String(where.id));
        return { id: 'n1', name: 'stored', parentId: 'n1' };
      },
    });
    const node = await load('node', { id: 'n1', name: 'caller', parentId: 'n1' });
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
      resources: { node: 'Node' },
      fieldMap: {
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
    } satisfies SchemaMap;
    const stored = { org: 'o', key: 'k', name: 'Una', parentOrg: 'o', parentKey: 'k' };
    const load = createHydrator({ map: nodes, load: async () => stored });
    const forged = await load('node', { ...stored, name: 'EVIL' });
    const reads: RebacSchema = {
      permissions: {
        node: {
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
    const ask = createRebacCheck(nodes);
    expect(ask(actorAs('x'), reads, { resource: 'node', record: forged }, 'read')).toBe(false);
    expect(
      ask(actorAs('x'), reads, { resource: 'node', record: forged.parent as Row }, 'read'),
    ).toBe(true);
  });

  test('a root key the caller changed loads the row it names, and nothing for a missing one', async () => {
    loads.length = 0;
    const moved = await counting('user', { id: 'u1', name: 'Una', orgId: 'o9' });
    expect(moved.org).toBeUndefined();
    expect(loads).toEqual(['org:o9']);
  });

  test('a stand-in and a hand-built surface record have no id: each is its own row', () => {
    const entry: EntitlementEntry = {
      resource: 'message',
      anchor: { resource: 'conversation', id: 'c1', path: 'conversation' },
      actions: { act: true },
    };
    const [a, b] = [
      placeEntitlement(map, entry, db.conversation?.c1 as Row),
      placeEntitlement(map, entry, db.conversation?.c1 as Row),
    ];
    expect(a?.[0]).not.toBe(b?.[0]);
    const walk: RebacSchema = {
      permissions: {
        message: { actions: { act: { rel: 'conversation', action: 'see' } } },
        conversation: { actions: { see: reads('orgId', 'o1') } },
      },
    };
    expect(check(actorAs('x'), walk, { resource: 'message', record: a?.[0] as Row }, 'act')).toBe(
      true,
    );
  });

  test('a soft-deleted root: the loop finds no stored row, so nothing is read there', async () => {
    db.user = {
      ...db.user,
      gone: { id: 'gone', name: 'Gone', orgId: 'og', deletedAt: '2026-11-01' },
    };
    db.org = { ...db.org, og: { id: 'og', name: 'ghost org', creatorId: 'gone' } };
    const gone = await counting('user', { id: 'gone', name: 'Gone', orgId: 'og' });
    expect((gone.org as Row).creator).toBeUndefined();
  });
});

describe('the limits throw; nothing is cut', () => {
  test('the lens refuses a map whose rows would hydrate past the budget, naming the resource and where', () => {
    const col = column('String');
    const names = Array.from({ length: 9 }, (_, i) => `M${i}`);
    const dense: SchemaMap = {
      resources: Object.fromEntries(names.map((name) => [name.toLowerCase(), name])),
      fieldMap: {
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
    };
    expect(() => countRelationsOneRowHydrates(dense, 'm0')).toThrow(
      `the lens of \`m0\` hydrates more than ${relationLensLimits.refuse} relations a row`,
    );
  });

  test('a chain longer than the depth cap throws, naming where', () => {
    const col = column('String');
    const length = relationLensLimits.depth + 2;
    const chain: SchemaMap = {
      resources: Object.fromEntries(Array.from({ length }, (_, i) => [`c${i}`, `C${i}`])),
      fieldMap: {
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
    };
    expect(() => countRelationsOneRowHydrates(chain, 'c0')).toThrow(
      `the lens of \`c0\` goes past ${relationLensLimits.depth} relations`,
    );
  });

  test('a hydration past its load budget throws', async () => {
    const col = column('String');
    const nodes: SchemaMap = {
      resources: { node: 'Node' },
      fieldMap: {
        models: { Node: { fields: { id: col, parentId: col, parent: toOne('Node', 'parentId') } } },
      },
    };
    const endless = createHydrator({
      map: nodes,
      load: async (_resource, where) => {
        const i = Number(String(where.id).slice(1));
        return { id: `n${i}`, parentId: `n${i + 1}` };
      },
    });
    await expect(endless('node', { id: 'n0', parentId: 'n1' })).rejects.toThrow(
      `passed ${hydrationLimits.loads} loads`,
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
    const hydrated = await hydrate('conversation', passed);
    expect(passed).toEqual(before);
    expect((hydrated.org as Row).name).toBe('acme');
    expect(((hydrated.org as Row).creator as Row).name).toBe('Una');
    expect((hydrated.messages as Row[]).map((message) => message.id)).toEqual(['m1']);
    expect(((hydrated.messages as Row[])[0]?.author as Row).name).toBe('Una');
    expect(hydrated.drafts).toBe(passed.drafts);
    expect(() =>
      check(
        actorAs('attacker'),
        ruled('conversation', actorWrote('drafts.0.authorId')),
        { resource: 'conversation', record: hydrated },
        'act',
      ),
    ).toThrow(/`conversation.drafts` is a list/);
    expect(codes(ruled('conversation', reads('extra.note', 'from the caller')))).toEqual(['lens']);
    const stored: RebacSchema = {
      permissions: {
        conversation: {
          actions: {
            act: { rel: 'messages', arrayOperator: 'any', condition: reads('author.name', 'Mal') },
          },
        },
      },
    };
    expect(check(actorAs('x'), stored, { resource: 'conversation', record: hydrated }, 'act')).toBe(
      false,
    );
    expect(passed).toEqual(before);
  });
});

describe('json-rules’ operator fit check', () => {
  test('validateSchema reports a date operator on a String column, which json-rules throws on when run', () => {
    const schema = ruled('user', {
      rule: { field: 'name', dateOperator: 'before', value: '2026-01-01' },
    } as ActionRule);
    expect(codes(schema)).toEqual(['operator_kind_mismatch']);
    expect(() =>
      check(actorAs('x'), schema, { resource: 'user', record: { id: 'u1', name: 'Una' } }, 'act'),
    ).toThrow('is not a valid date');
  });
});

describe('the actor and the size of a lens', () => {
  test('a rule reads the actor at its own row only; a where never does', () => {
    expect(codes(ruled('user', reads('__actor.record.org.creator')))).toEqual([]);
    expect(codes(ruled('user', reads('org.__actor.record.id')))).toEqual(['lens']);
    expect(
      whyEntitlementWhereLeavesLens(map, 'user', {
        field: '__actor.record.id',
        operator: 'equals',
        value: null,
      }),
    ).toMatch(/`__actor` is not on it/);
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
      resources: Object.fromEntries(
        ['hub', ...names('s', 40), ...names('l', 30)].map((name) => [
          name,
          name[0]?.toUpperCase() + name.slice(1),
        ]),
      ),
      fieldMap: {
        models: {
          Hub: { fields: to('s', 40) },
          ...Object.fromEntries(names('S', 40).map((name) => [name, { fields: to('l', 30) }])),
          ...Object.fromEntries(names('L', 30).map((name) => [name, { fields: { id: col } }])),
        },
      },
    };
    const result = validateSchema(wide, { permissions: { hub: { actions: { read: null } } } });
    expect(result.ok).toBe(true);
    expect(result.warnings.map((issue) => issue.code)).toEqual(['countRelationsOneRowHydrates']);
  });

  test('a polymorphic row counts one kind: four kinds of 301 relations are not over the report limit', () => {
    const col = column('String');
    const leaves = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const kinds = ['K0', 'K1', 'K2', 'K3'];
    const poly: SchemaMap = {
      resources: Object.fromEntries(
        ['Hub', ...kinds, ...leaves].map((model) => [model.toLowerCase(), model]),
      ),
      fieldMap: {
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
      polymorphism: {
        Hub: {
          axes: [
            {
              field: 'ownerModel',
              fkMap: Object.fromEntries(kinds.map((kind) => [kind, [`${kind.toLowerCase()}Id`]])),
            },
          ],
        },
      },
    };
    expect(countRelationsOneRowHydrates(poly, 'hub')).toBe(301);
    expect(
      validateSchema(poly, { permissions: { hub: { actions: { read: null } } } }).warnings,
    ).toEqual([]);
  });
});

describe('under a list item only the declared paths exist', () => {
  const schema: RebacSchema = {
    permissions: {
      conversation: {
        actions: { read: { rel: 'messages', arrayOperator: 'any', condition: 'read' }, x: true },
      },
      message: { actions: { read: null } },
      user: { actions: {} },
      org: { actions: {} },
    },
  };
  const message = (where: Condition): EntitlementEntry => ({
    resource: 'message',
    anchor: { resource: 'message', id: 'm1' },
    where,
    actions: { read: true },
  });

  test('B1: a where valid at its resource keeps its arms on an item; what the item lacks is unknown', async () => {
    const conversation = await hydrate('conversation', db.conversation?.c1 as Row);
    const either: Condition = {
      any: [
        { field: 'author.name', operator: 'equals', value: 'Una' },
        { field: 'conversation.orgId', operator: 'equals', value: 'o1' },
      ],
    };
    const subject = { resource: 'conversation', record: conversation };
    expect(check(actorAs('x', [message(either)]), schema, subject, 'read')).toBe(true);
    const outside: Condition = { field: 'conversation.orgId', operator: 'equals', value: 'o1' };
    expect(check(actorAs('x', [message(outside)]), schema, subject, 'read')).toBe(false);
  });

  test('B3: a row rule on an item keeps its arms', async () => {
    const conversation = await hydrate('conversation', db.conversation?.c1 as Row);
    const [item] = conversation.messages as Row[];
    const rule: ActionRule = {
      any: [reads('author.name', 'Una'), { rel: 'conversation', action: 'x' }],
    };
    const record = { ...conversation, messages: [{ ...item, permissionRules: { read: rule } }] };
    expect(check(actorAs('x'), schema, { resource: 'conversation', record }, 'read')).toBe(true);
  });

  test('an undeclared to-one that loadMany returned is gone from the item', async () => {
    const forged = createHydrator({
      map,
      load: async (resource, where) => db[resource]?.[where.id as string] ?? null,
      loadMany: async (resource, where) =>
        Object.values(db[resource] ?? {})
          .filter((row) => Object.entries(where).every(([key, value]) => row[key] === value))
          .map((row) => ({ ...row, conversation: { id: 'c1', orgId: 'forged' } })),
    });
    const conversation = await forged('conversation', db.conversation?.c1 as Row);
    const [item] = conversation.messages as Row[];
    expect(item && 'conversation' in item).toBe(false);
    expect((item?.author as Row).name).toBe('Una');
  });
});

describe('one down boundary: an item holds only its declared tree', () => {
  const col = column('String');
  const items: SchemaMap = {
    resources: {
      conversation: 'Conversation',
      message: 'Message',
      user: 'User',
      org: 'Org',
      reaction: 'Reaction',
      profile: 'Profile',
    },
    fieldMap: {
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
  };
  const rows: Record<string, Record<string, Row>> = {
    user: { u1: { id: 'u1', name: 'Una' } },
    conversation: { c1: { id: 'c1' } },
    message: {
      m1: { id: 'm1', conversationId: 'c1', authorId: 'u1', hiddenOrgId: 'o1', meta: { tag: 'x' } },
    },
  };
  const loading = (permissionRules: unknown) =>
    createHydrator({
      map: items,
      load: async (resource, where) => rows[resource]?.[where.id as string] ?? null,
      loadMany: async (resource, where) =>
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
  const schema: RebacSchema = {
    permissions: {
      conversation: {
        actions: { read: { rel: 'messages', arrayOperator: 'any', condition: 'read' } },
      },
      message: { actions: { read: null } },
      user: { actions: {} },
      org: { actions: {} },
      reaction: { actions: {} },
      profile: { actions: {} },
    },
  };

  test('everything a loader returned on an item but the declaration does not load is gone', async () => {
    const conversation = await loading(null)('conversation', rows.conversation?.c1 as Row);
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
      'conversation',
      rows.conversation?.c1 as Row,
    );
    const ask = createRebacCheck(items);
    expect(
      ask(actorAs('x'), schema, { resource: 'conversation', record: conversation }, 'read'),
    ).toBe(false);
    const [item] = conversation.messages as Row[];
    const leaked = {
      ...conversation,
      messages: [{ ...item, reactions: [{ id: 'r', who: 'evil' }] }],
    };
    expect(ask(actorAs('x'), schema, { resource: 'conversation', record: leaked }, 'read')).toBe(
      false,
    );
  });
});

describe('a row’s key', () => {
  test('the engine id field wins over the model’s isId column, as the app loads by it', () => {
    const col = column('String');
    const keyed: SchemaMap = {
      resources: { brand: 'Brand' },
      fieldMap: {
        models: {
          Brand: {
            fields: { id: column('Int', { isId: true }), uuid: col },
          },
        },
      },
    };
    expect(identityKeyOfRow(keyed, 'brand', { uuid: 'b-1' }, 'uuid')).toBe(
      identityKeyOfRow(keyed, 'brand', { uuid: 'b-1', id: 7 }, 'uuid'),
    );
    expect(identityKeyOfRow(keyed, 'brand', { id: 7 }, 'uuid')).toBe(
      identityKeyOfRow(keyed, 'brand', { id: 7 }, 'uuid'),
    );
    expect(identityKeyOfRow(keyed, 'brand', {}, 'uuid')).toBeUndefined();
  });

  test('composite values never collide across a NUL', () => {
    const col = column('String');
    const pair = {
      resources: { pair: 'Pair' },
      fieldMap: {
        models: {
          Pair: { fields: { a: col, b: col }, indexes: [{ kind: 'id', fields: ['a', 'b'] }] },
        },
      },
    } satisfies SchemaMap;
    expect(identityKeyOfRow(pair, 'pair', { a: 'x\u0000', b: 'y' })).not.toBe(
      identityKeyOfRow(pair, 'pair', { a: 'x', b: '\u0000y' }),
    );
  });
});

describe('the apps’ own maps', () => {
  const zealot: SchemaMap = {
    resources: {
      'db:user': 'User',
      'db:brands': 'Brands',
      'db:fanUsers': 'FanUsers',
      'db:brandUsers': 'BrandUsers',
      'db:forumUser': 'ForumUser',
      'db:conversation': 'Conversation',
      'db:conversationParticipant': 'ConversationParticipant',
      'db:chatMessage': 'ChatMessage',
    },
    fieldMap: { models: loadModels('zealot') },
  };
  const participantReads = (field: string): RebacSchema => ({
    permissions: {
      'db:conversation': {
        actions: {
          act: {
            rel: 'participants',
            arrayOperator: 'any',
            condition: { rule: { field, operator: 'equals', path: '__actor.record.uuid' } },
          },
        },
      },
    },
  });

  test('Zealot: under a participant a declared path reads; at a landing only the rest of `down` does', () => {
    const ask = createRebacCheck(zealot);
    const record = {
      uuid: 'c1',
      participants: [{ uuid: 'p1', forumUser: { fanUser: { userUuid: 'u-fay' } } }],
    };
    const fay: PermixLike = {
      check: () => false,
      getActor: () => ({ model: 'User', record: { uuid: 'u-fay' } }),
    };
    const declared = participantReads('forumUser.fanUser.userUuid');
    expect(validateSchema(zealot, declared).ok).toBe(true);
    expect(ask(fay, declared, { resource: 'db:conversation', record }, 'act')).toBe(true);
    const landing: RebacSchema = {
      permissions: {
        'db:conversation': {
          actions: {
            act: {
              rel: 'participants',
              arrayOperator: 'any',
              condition: { rel: 'forumUser', action: 'x' },
            },
          },
        },
        'db:forumUser': {
          actions: {
            x: { rule: { field: 'brand.uuid', operator: 'equals', path: '__actor.record.uuid' } },
          },
        },
      },
    };
    expect(validateSchema(zealot, landing).errors.map((issue) => issue.code)).toEqual(['down']);
  });

  test('Kingdom: a surface rule reads through its synthetic integrationResource relation', () => {
    const kingdom: SchemaMap = {
      resources: {
        'db:organization': 'Organization',
        'db:integration': 'Integration',
        'db:integrationResource': 'IntegrationResource',
        'slack:channel': 'SlackChannelOperation',
      },
      fieldMap: { models: loadModels('kingdom') },
    };
    const schema: RebacSchema = {
      permissions: {
        'slack:channel': {
          actions: { act: reads('integrationResource.integration.provider', 'github') },
        },
      },
    };
    expect(validateSchema(kingdom, schema).ok).toBe(true);
    const surface = {
      operation: 'post',
      integrationResourceId: 'r1',
      integrationResource: {
        id: 'r1',
        integrationId: 'i1',
        integration: { id: 'i1', provider: 'github' },
      },
    };
    const ask = createRebacCheck(kingdom);
    expect(ask(actorAs('x'), schema, { resource: 'slack:channel', record: surface }, 'act')).toBe(
      true,
    );
  });
});
