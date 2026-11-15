import { describe, expect, test } from 'bun:test';
import type { Condition, FieldMap, FieldMapEntry } from '@inixiative/json-rules';
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
  whereLensProblem,
} from '../index';
import { lensOf, whereNodeProblem } from '../src/core/lens';
import { loadModels } from './fixtures/load';

// One lens decides what hydration loads, what a check reads of a record, and which paths a rule
// may name. Each case below returned true on 0.22.0 (the adversarial review's probes, T1–T8).

const column = (type: string, extra: Partial<FieldMapEntry> = {}): FieldMapEntry => ({
  kind: 'scalar',
  type,
  isList: false,
  ...extra,
});
const toOne = (type: string, key?: string, extra: Partial<FieldMapEntry> = {}): FieldMapEntry => ({
  kind: 'object',
  type,
  isList: false,
  ...(key ? { fromFields: [key], toFields: ['id'] } : {}),
  ...extra,
});
const toMany = (type: string, extra: Partial<FieldMapEntry> = {}): FieldMapEntry => ({
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
        } as Partial<FieldMapEntry>),
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

describe('the review probes: each returned true on 0.22.0', () => {
  test('T1: a path through an undeclared list a request body filled is refused', async () => {
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

  test('T2: the same read in a bracket spelling is refused, on a declared list too', async () => {
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

  test('T3: a relation keyed on the other side is refused, so a banned user never reads as unbanned', async () => {
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

  test('T5: a schema is frozen on its first check; an edit afterwards throws and changes nothing', async () => {
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

  test('T6: an entitlement whose where reads into a list never holds, and is never granted', async () => {
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
    expect(whereLensProblem(map, entry.resource, entry.where)).toMatch(
      /reads outside the lens: `conversation.drafts` is a list/,
    );
    const writer: PermixLike = { check: () => true, getActor: () => null };
    expect(createCanGrantEntitlement(map)(writer, schema, entry, record)).toBe(false);
  });

  test('T8: a path around a cycle reads the same row again, so a set name never reads as null', async () => {
    const attacker = await hydrate('user', db.user?.attacker as Row);
    const org = attacker.org as Row;
    expect((org.creator as Row).org).toBe(org);
    const at = (field: string, value: unknown) =>
      check(
        actorAs('attacker'),
        ruled('user', reads(field, value)),
        { resource: 'user', record: attacker },
        'act',
      );
    expect(at('org.creator.org.name', null)).toBe(false);
    expect(at('org.creator.org.name', 'acme')).toBe(true);
    expect(at('org.creator.org.creator.org.creator.name', 'Una')).toBe(true);
  });

  test('P1: chained { rel } hops and a where held on the row past the old cut read the real row', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    expect(((u1.org as Row).creator as Row).org).toBe(u1.org);
    const chained: RebacSchema = {
      permissions: {
        user: {
          actions: { act: { rel: 'org.creator', action: 'vouch' }, vouch: reads('org.name', null) },
        },
      },
    };
    expect(check(actorAs('x'), chained, { resource: 'user', record: u1 }, 'act')).toBe(false);
    const held: EntitlementEntry = {
      resource: 'user',
      anchor: { resource: 'user', id: 'u1' },
      where: { field: 'org.name', operator: 'equals', value: null },
      actions: { vouch: true },
    };
    const viaWhere: RebacSchema = {
      permissions: {
        user: { actions: { act: { rel: 'org.creator', action: 'vouch' }, vouch: null } },
      },
    };
    expect(check(actorAs('x', [held]), viaWhere, { resource: 'user', record: u1 }, 'act')).toBe(
      false,
    );
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

  test('a sibling arm beside the looping arm is still judged', async () => {
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

  test('a rule that names itself on the same record still throws', async () => {
    const u1 = await hydrate('user', db.user?.u1 as Row);
    const selfLoop: RebacSchema = {
      permissions: { user: { actions: { read: { any: ['read'] } } } },
    };
    expect(() => check(actorAs('x'), selfLoop, { resource: 'user', record: u1 }, 'read')).toThrow(
      /Cycle detected/,
    );
  });
});

describe('the second review: each returned true on the first build', () => {
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

  test('A: a relation held as a class instance is read, not dropped', () => {
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

  test('B: an entitlement where is frozen when first judged; an edit afterwards throws', () => {
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

  test('C: a where reads the record alone, so an `__actor` path in it is refused', () => {
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
    expect(whereLensProblem(map, 'user', entry.where)).toMatch(/`__actor` is not on it/);
    expect(codes(ruled('user', actorWrote('id')))).toEqual([]);
  });
});

describe('what the lens keeps', () => {
  test('a column of a relation, a Json sub-path, an index into a scalar list, a computed root key', async () => {
    const message = await hydrate('message', db.message?.m1 as Row);
    const passes = (rule: ActionRule, record: Row = message) =>
      check(actorAs('attacker'), ruled('message', rule), { resource: 'message', record }, 'act');
    expect(passes(reads('conversation.org.name', 'acme'))).toBe(true);
    expect(passes(reads('mentions.0', 'aron'))).toBe(true);
    expect(
      passes(reads('conversation.meta.flags.0', 'x'), {
        ...message,
        conversation: { ...(message.conversation as Row), meta: { flags: ['x'] } },
      }),
    ).toBe(true);
    const scored = { resource: 'message', record: { ...message, score: 7 } };
    expect(check(actorAs('x'), ruled('message', null), scored, reads('score', 7))).toBe(true);
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
    expect(whereLensProblem(map, entry.resource, entry.where)).toBeNull();
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
    expect(codes(ruled('message', reads('author.org.creator.name')))).toEqual([]);
  });

  test('a key the model does not have and an index are refused; a computed key only inline, at the subject', () => {
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
    expect(inline(reads('plann', 1))).toBe(true);
    expect(inline({ any: [reads('plann', 1)] })).toBe(true);
    const rowRule = { id: 'u1', plann: 1, permissionRules: { act: reads('plann', 1) } };
    expect(
      check(actorAs('x'), ruled('user', null), { resource: 'user', record: rowRule }, 'act'),
    ).toBe(false);
    expect(whereLensProblem(map, 'user', { field: 'plann', operator: 'equals', value: 1 })).toMatch(
      /`user` has no field `plann`/,
    );
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

describe('the second review of the final build', () => {
  test('an edge back to the root loads the stored row: the caller’s record is not believed there', async () => {
    const named = (value: unknown): RebacSchema => ({
      permissions: {
        user: {
          actions: { act: { rel: 'org.creator', action: 'named' }, named: reads('name', value) },
        },
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
              } as Partial<FieldMapEntry>),
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

  test('a where consulted on a list item is judged at the item’s declared node', () => {
    const where: Condition = {
      field: 'author.org.creator.org.name',
      operator: 'equals',
      value: 'acme',
    };
    const item = lensOf(map, 'conversation').lists.get('messages')?.item;
    expect(whereNodeProblem(map, lensOf(map, 'message'), where)).toBeNull();
    expect(whereNodeProblem(map, item as never, where)).toMatch(
      /loads no `author.org.creator.org`/,
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

  test('Zealot: under a participant, a declared path reads (outside `down`: listArm A-2)', () => {
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
