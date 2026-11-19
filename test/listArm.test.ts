import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AnnoValue, FieldMap } from '@inixiative/field-map';
import { engineGlobals, type JoinedBridge } from '@inixiative/json-rules';
import {
  type ActionRule,
  capAtRole,
  createCanGrantEntitlement,
  createHydrator,
  createPermissions,
  createRebacCheck,
  createRebacPaths,
  type EntitlementEntry,
  PathLimitError,
  type PermissionEntry,
  placeEntitlement,
  type RebacSchema,
  type ResourcePermission,
  type Row,
  reachableFrom,
  type SchemaMap,
  validateActionRule,
  validateSchema,
} from '../index';
import { annotate, loadModels } from './fixtures/load';
import { stringColumn } from './schemaMaps';

// Zealot's conversation slice (schemas/zealot.prisma), as field-map reads it. The list field reads
//   /// @permissions(down: [forumUser.fanUser.user, forumUser.brandUser.user])
//   participants ConversationParticipant[]
const models = loadModels('zealot');
const resources = {
  'db:user': 'User',
  'db:brands': 'Brands',
  'db:fanUsers': 'FanUsers',
  'db:brandUsers': 'BrandUsers',
  'db:forumUser': 'ForumUser',
  'db:conversation': 'Conversation',
  'db:conversationParticipant': 'ConversationParticipant',
  'db:chatMessage': 'ChatMessage',
};
const mapOver = (over: typeof models): SchemaMap => ({
  resources,
  fieldMap: { models: over },
  actors: { models: ['User'] },
});
const map = mapOver(models);

const actorIsUser = {
  rule: { field: 'actor:User.uuid', operator: 'exists' },
} as const satisfies ActionRule;

// BEFORE (zealot origin/main, packages/permissions/src/rebac/conversation.ts): a json-rules array
// condition inside `{ rule }`, comparing each participant's person to whoever is asking.
const actorIsParticipant = {
  rule: {
    field: 'participants',
    arrayOperator: 'any',
    condition: {
      any: [
        {
          all: [
            { field: 'actor:User.uuid', operator: 'exists' },
            { field: 'forumUser.fanUser.userUuid', operator: 'equals', path: 'actor:User.uuid' },
          ],
        },
        {
          all: [
            { field: 'actor:User.uuid', operator: 'exists' },
            { field: 'forumUser.brandUser.userUuid', operator: 'equals', path: 'actor:User.uuid' },
          ],
        },
      ],
    },
  },
} as const satisfies ActionRule;

// AFTER: the list arm. Some participant who has not left is the person, reached by walking
// through the membership into the table (ZLT-5652: `{ rel: 'fanUser', action: 'isSelf' }`).
const isParticipant = {
  rel: 'participants',
  arrayOperator: 'any',
  condition: {
    all: [
      { rule: { field: 'leftAt', operator: 'equals', value: null } },
      {
        any: [
          { rel: 'forumUser.fanUser', action: 'isSelf' },
          { rel: 'forumUser.brandUser', action: 'isSelf' },
        ],
      },
    ],
  },
} as const satisfies ActionRule;

const conversationWith = (participant: ActionRule): ResourcePermission => ({
  actions: {
    manage: { rel: 'brand', action: 'manage' },
    create: {
      all: [
        actorIsUser,
        {
          any: [
            { rel: 'brand', action: 'manage' },
            { rel: 'brand', action: 'advocate' },
          ],
        },
      ],
    },
    read: { all: [actorIsUser, { any: ['create', { rel: 'brand', action: 'read' }] }] },
    chat: { all: ['create', participant] },
    chatRead: { all: ['read', participant] },
    isParticipant: participant,
  },
});

const membership: ResourcePermission = {
  actions: {
    isSelf: { rel: 'user', action: 'own' },
    operate: { rel: 'user', action: 'operate' },
    manage: { rel: 'brand', action: 'manage' },
  },
};

const schemaWith = (participant: ActionRule): RebacSchema => ({
  permissions: {
    'db:user': { actions: { own: null, operate: 'own', read: 'operate' } },
    'db:brands': { actions: { manage: null, read: 'manage', advocate: null } },
    'db:fanUsers': membership,
    'db:brandUsers': membership,
    'db:forumUser': { actions: {} },
    'db:conversationParticipant': { actions: {} },
    'db:conversation': conversationWith(participant),
    'db:chatMessage': {
      actions: { inConversation: { rel: 'conversation', action: 'isParticipant' } },
    },
  },
});
const schema = schemaWith(isParticipant);

type Store = Record<string, Row[]>;
const store = (): Store => ({
  'db:user': ['u-fay', 'u-rex', 'u-ada', 'u-otto', 'u-lee', 'u-dual', 'u-hal'].map((uuid) => ({
    uuid,
  })),
  'db:brands': [{ uuid: 'b1' }],
  'db:fanUsers': [
    { uuid: 'f-fay', userUuid: 'u-fay', brandUuid: 'b1' },
    { uuid: 'f-otto', userUuid: 'u-otto', brandUuid: 'b1' },
    { uuid: 'f-lee', userUuid: 'u-lee', brandUuid: 'b1' },
    { uuid: 'f-dual', userUuid: 'u-dual', brandUuid: 'b1' },
  ],
  'db:brandUsers': [
    { uuid: 'bu-rex', userUuid: 'u-rex', brandUuid: 'b1' },
    { uuid: 'bu-ada', userUuid: 'u-ada', brandUuid: 'b1' },
    { uuid: 'bu-dual', userUuid: 'u-dual', brandUuid: 'b1' },
  ],
  'db:forumUser': [
    { uuid: 'fu-fay', fanUserUuid: 'f-fay', brandUserUuid: null, brandUuid: 'b1' },
    { uuid: 'fu-rex', fanUserUuid: null, brandUserUuid: 'bu-rex', brandUuid: 'b1' },
    { uuid: 'fu-lee', fanUserUuid: 'f-lee', brandUserUuid: null, brandUuid: 'b1' },
    { uuid: 'fu-dual-fan', fanUserUuid: 'f-dual', brandUserUuid: null, brandUuid: 'b1' },
    { uuid: 'fu-dual-rep', fanUserUuid: null, brandUserUuid: 'bu-dual', brandUuid: 'b1' },
    { uuid: 'fu-ghost', fanUserUuid: null, brandUserUuid: null, brandUuid: 'b1' },
  ],
  'db:conversation': [
    { uuid: 'c1', brandUuid: 'b1', createdByUuid: 'fu-rex' },
    { uuid: 'c-empty', brandUuid: 'b1', createdByUuid: 'fu-rex' },
    { uuid: 'c-dual', brandUuid: 'b1', createdByUuid: 'fu-rex' },
    { uuid: 'c-ghost', brandUuid: 'b1', createdByUuid: 'fu-rex' },
  ],
  'db:conversationParticipant': [
    { uuid: 'p-fay', conversationUuid: 'c1', forumUserUuid: 'fu-fay', leftAt: null },
    { uuid: 'p-rex', conversationUuid: 'c1', forumUserUuid: 'fu-rex', leftAt: null },
    { uuid: 'p-lee', conversationUuid: 'c1', forumUserUuid: 'fu-lee', leftAt: '2026-11-01' },
    { uuid: 'p-d1', conversationUuid: 'c-dual', forumUserUuid: 'fu-dual-fan', leftAt: null },
    { uuid: 'p-d2', conversationUuid: 'c-dual', forumUserUuid: 'fu-dual-rep', leftAt: null },
    { uuid: 'p-ghost', conversationUuid: 'c-ghost', forumUserUuid: 'fu-ghost', leftAt: null },
  ],
  'db:chatMessage': [{ uuid: 'm1', conversationUuid: 'c1' }],
});

const matches = (where: Row) => (row: Row) =>
  Object.entries(where).every(([key, value]) => row[key] === value);

const hydratorOver = (data: Store, over: SchemaMap = map, loads: string[] = []) =>
  createHydrator({
    map: over,
    load: async (resource, where) => {
      loads.push(`load ${resource} ${JSON.stringify(where)}`);
      return data[resource]?.find(matches(where)) ?? null;
    },
    loadMany: async (resource, where) => {
      loads.push(`loadMany ${resource} ${JSON.stringify(where)}`);
      return data[resource]?.filter(matches(where)) ?? [];
    },
  });

const conversation = async (uuid: string, data: Store = store()) =>
  hydratorOver(data)('db:conversation', data['db:conversation']?.find(matches({ uuid })) as Row);

type Role = 'manage' | 'advocate';
const person = async (uuid: string, brand?: Role) => {
  const permix = createPermissions();
  await permix.setup([
    { resource: 'db:user', id: uuid, actions: { own: true } },
    ...(brand ? [{ resource: 'db:brands', id: 'b1', actions: { [brand]: true } }] : []),
  ]);
  permix.setActor({ model: 'User', record: { uuid } });
  return permix;
};

const check = createRebacCheck(map);
const paths = createRebacPaths(map);
const canGrant = createCanGrantEntitlement(map);
const on = (record: Row, resource = 'db:conversation') => ({ resource, record });

beforeAll(() => engineGlobals.set('permissions.idField', 'uuid'));
afterAll(() => engineGlobals.reset());

describe('Zealot’s conversation rule on the list arm', () => {
  test('the schema validates against the map', () => {
    expect(validateSchema(map, schema)).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test('a participant chats and reads the chat', async () => {
    const c1 = await conversation('c1');
    const fay = await person('u-fay', 'advocate');
    const rex = await person('u-rex', 'manage');
    for (const who of [fay, rex]) {
      expect(check(who, schema, on(c1), 'chat')).toBe(true);
      expect(check(who, schema, on(c1), 'chatRead')).toBe(true);
    }
  });

  test('a non-participant does not, though they may start conversations in the brand', async () => {
    const c1 = await conversation('c1');
    const otto = await person('u-otto', 'advocate');
    expect(check(otto, schema, on(c1), 'create')).toBe(true);
    expect(check(otto, schema, on(c1), 'chat')).toBe(false);
    expect(check(otto, schema, on(c1), 'chatRead')).toBe(false);
  });

  test('a participant who left does not: the condition on the item reads `leftAt`', async () => {
    const c1 = await conversation('c1');
    expect(check(await person('u-lee', 'advocate'), schema, on(c1), 'chat')).toBe(false);
  });

  test('a brand admin still manages, and the brand role does not make them a participant', async () => {
    const c1 = await conversation('c1');
    const ada = await person('u-ada', 'manage');
    expect(check(ada, schema, on(c1), 'manage')).toBe(true);
    expect(check(ada, schema, on(c1), 'isParticipant')).toBe(false);
    expect(check(ada, schema, on(c1), 'chat')).toBe(false);
  });

  test('nobody acting denies, even on a membership with no person', async () => {
    const nobody = createPermissions();
    expect(check(nobody, schema, on(await conversation('c1')), 'chat')).toBe(false);
    expect(check(nobody, schema, on(await conversation('c1')), 'isParticipant')).toBe(false);
    expect(check(nobody, schema, on(await conversation('c-ghost')), 'isParticipant')).toBe(false);
  });

  test('a list not loaded denies; an empty one denies', async () => {
    const fay = await person('u-fay', 'advocate');
    const bare = store()['db:conversation']?.[0] as Row;
    expect(check(fay, schema, on({ ...bare, brand: { uuid: 'b1' } }), 'chat')).toBe(false);
    expect(check(fay, schema, on(await conversation('c-empty')), 'chat')).toBe(false);
    const all = createPermissions();
    await all.setup([
      { resource: 'db:conversationParticipant', actions: { isSelf: true } },
      { resource: 'db:fanUsers', actions: { isSelf: true } },
    ]);
    expect(check(all, schema, on(await conversation('c-empty')), 'isParticipant')).toBe(false);
  });

  test('a message reaches the list through its conversation', async () => {
    const data = store();
    const m1 = await hydratorOver(data)('db:chatMessage', data['db:chatMessage']?.[0] as Row);
    expect(check(await person('u-fay'), schema, on(m1, 'db:chatMessage'), 'inConversation')).toBe(
      true,
    );
    expect(check(await person('u-otto'), schema, on(m1, 'db:chatMessage'), 'inConversation')).toBe(
      false,
    );
  });
});

describe('the grantor side: an entitlement asks whether its grantor is a participant', () => {
  const chatOnC1: EntitlementEntry = {
    resource: 'db:conversation',
    anchor: { resource: 'db:conversation', id: 'c1' },
    actions: { chat: true },
    ref: 'chat-c1',
  };
  const held = async (holder: string, owner: Awaited<ReturnType<typeof person>>, role?: Role) => {
    const permix = await person(holder, role);
    await permix.setup([chatOnC1], { owner });
    return permix;
  };

  test('a holder who is no participant chats while the grantor is one, and stops when they leave', async () => {
    const hal = await held('u-hal', await person('u-fay', 'advocate'));
    expect(check(hal, schema, on(await conversation('c1')), 'chat')).toBe(true);
    expect(paths(hal, schema, on(await conversation('c1')), 'chat')).toEqual([[['chat-c1']]]);
    const left = store();
    (left['db:conversationParticipant']?.[0] as Row).leftAt = '2026-11-14';
    expect(check(hal, schema, on(await conversation('c1', left)), 'chat')).toBe(false);
  });

  test('a holder who is a participant gains nothing from a grantor who is not', async () => {
    const pat = await held('u-fay', await person('u-otto', 'advocate'));
    expect(check(pat, schema, on(await conversation('c1')), 'isParticipant')).toBe(true);
    expect(check(pat, schema, on(await conversation('c1')), 'chat')).toBe(false);
  });
});

describe('the grant check', () => {
  const participates = (anchor: EntitlementEntry['anchor'], resource = 'db:conversation') =>
    ({ resource, anchor, actions: { isParticipant: true } }) satisfies EntitlementEntry;
  const selfAnchored = participates({ resource: 'db:conversation', id: 'c1' });
  const underBrand = participates({ resource: 'db:brands', id: 'b1', path: 'brand' });

  test('a self-anchored entry is judged on the real row, list included', async () => {
    const c1 = await conversation('c1');
    const [placed] = placeEntitlement(map, selfAnchored, c1) as Row[];
    expect(placed).toBe(c1);
    expect(canGrant(await person('u-fay'), schema, selfAnchored, c1)).toBe(true);
    expect(canGrant(await person('u-otto'), schema, selfAnchored, c1)).toBe(false);
    expect(canGrant(await person('u-ada', 'manage'), schema, selfAnchored, c1)).toBe(false);
  });

  test('a stand-in below a real anchor walks up into the anchor’s list', async () => {
    const entry: EntitlementEntry = {
      resource: 'db:chatMessage',
      anchor: { resource: 'db:conversation', id: 'c1', path: 'conversation' },
      actions: { inConversation: true },
    };
    const c1 = await conversation('c1');
    const [placed] = placeEntitlement(map, entry, c1) as Row[];
    expect(canGrant(await person('u-fay'), schema, entry, placed as Row)).toBe(true);
    expect(canGrant(await person('u-otto'), schema, entry, placed as Row)).toBe(false);
  });

  test('a stand-in conversation has no list: nobody grants "participant of every conversation"', async () => {
    const b1 = { uuid: 'b1' };
    const [placed] = placeEntitlement(map, underBrand, b1) as Row[];
    expect(placed).toEqual({ brandUuid: 'b1', brand: b1 });
    for (const who of [await person('u-fay', 'advocate'), await person('u-ada', 'manage')])
      expect(canGrant(who, schema, underBrand, placed as Row)).toBe(false);
  });

  test('a `where` cannot pin a list onto the stand-in', async () => {
    const forged = [{ leftAt: null, forumUser: { fanUser: { user: { uuid: 'u-fay' } } } }];
    const entry = {
      ...underBrand,
      where: { field: 'participants', operator: 'equals', value: forged },
    } as EntitlementEntry;
    const [placed] = placeEntitlement(map, entry, { uuid: 'b1' }) as Row[];
    expect(placed).not.toHaveProperty('participants');
    expect(canGrant(await person('u-fay'), schema, entry, placed as Row)).toBe(false);
  });

  test('a copy is backed only where its grantor’s list is: the liveness walk has no list on a stand-in', async () => {
    const fay = await person('u-fay');
    const hal = await person('u-hal');
    await hal.setup([selfAnchored, underBrand], { owner: fay });
    const c1 = await conversation('c1');
    expect(canGrant(hal, schema, selfAnchored, c1)).toBe(true);
    const [standIn] = placeEntitlement(map, underBrand, { uuid: 'b1' }) as Row[];
    expect(canGrant(hal, schema, underBrand, standIn as Row)).toBe(false);
    const left = store();
    (left['db:conversationParticipant']?.[0] as Row).leftAt = '2026-11-14';
    expect(canGrant(hal, schema, selfAnchored, await conversation('c1', left))).toBe(false);
  });

  test('Zealot’s `chat` itself is not grantable: `create` asks who is acting, and a grant has no actor', async () => {
    const entry = { ...selfAnchored, actions: { chat: true } };
    expect(
      canGrant(await person('u-fay', 'advocate'), schema, entry, await conversation('c1')),
    ).toBe(false);
  });
});

describe('entitlements met on an item', () => {
  const asFay = (ref: string, anchor: EntitlementEntry['anchor']): EntitlementEntry => ({
    resource: 'db:fanUsers',
    anchor,
    actions: { isSelf: true },
    ref,
    grantsBelow: true,
  });
  const onFay = asFay('fay-fan', { resource: 'db:fanUsers', id: 'f-fay' });

  test('one anchored at the membership row counts: a delegate of the participant is in', async () => {
    const hal = await person('u-hal');
    await hal.setup([onFay], { owner: await person('u-fay') });
    const c1 = await conversation('c1');
    expect(check(hal, schema, on(c1), 'isParticipant')).toBe(true);
    expect(paths(hal, schema, on(c1), 'isParticipant')).toEqual([[['fay-fan']]]);
  });

  test('one whose anchor path is not loaded under the item reaches nothing', async () => {
    const hal = await person('u-hal');
    const viaBrand = asFay('via-brand', { resource: 'db:brands', id: 'b1', path: 'brand' });
    delete viaBrand.grantsBelow;
    await hal.setup([viaBrand], { owner: await person('u-fay') });
    expect(check(hal, schema, on(await conversation('c1')), 'isParticipant')).toBe(false);
  });

  test('it does not count in the grant check’s first pass: an item is not a row above', async () => {
    const hal = await person('u-hal');
    await hal.setup([onFay], { owner: await person('u-fay') });
    const entry: EntitlementEntry = {
      resource: 'db:conversation',
      anchor: { resource: 'db:conversation', id: 'c1' },
      actions: { isParticipant: true },
    };
    expect(canGrant(hal, schema, entry, await conversation('c1'))).toBe(false);
  });
});

describe('capping, paths and cycles', () => {
  test('the list arm is not pure delegation: nothing is reached or kept through it', () => {
    expect([...reachableFrom(schema, 'db:conversation', 'chat')]).toEqual(['chat']);
    expect([...reachableFrom(schema, 'db:conversation', 'isParticipant')]).toEqual([
      'isParticipant',
    ]);
    const entry: PermissionEntry = { resource: 'db:conversation', actions: { manage: true } };
    expect(capAtRole(schema, entry, 'isParticipant')).toBeNull();
  });

  test('two items admitting the same way are one path', async () => {
    const dual = await person('u-dual');
    const record = await conversation('c-dual');
    expect((record.participants as Row[]).length).toBe(2);
    expect(paths(dual, schema, on(record), 'isParticipant')).toEqual([[]]);
  });

  test('items admitting through different entitlements are one path each, counted against the limit', async () => {
    const hal = await person('u-hal');
    const dual = await person('u-dual');
    const through = (ref: string, resource: string, id: string): EntitlementEntry => ({
      resource,
      anchor: { resource, id },
      actions: { isSelf: true },
      ref,
    });
    await hal.setup(
      [through('fan', 'db:fanUsers', 'f-dual'), through('rep', 'db:brandUsers', 'bu-dual')],
      { owner: dual },
    );
    const record = await conversation('c-dual');
    expect(paths(hal, schema, on(record), 'isParticipant')).toEqual([[['fan']], [['rep']]]);
    const one = createRebacPaths(map, { limit: 1 });
    expect(() => one(hal, schema, on(record), 'isParticipant')).toThrow(PathLimitError);
  });

  test('two items that hold the same row are parallel paths, not a cycle', async () => {
    const c1 = await conversation('c1');
    const [first] = c1.participants as Row[];
    const twice = { ...c1, participants: [first, first] };
    expect(check(await person('u-otto'), schema, on(twice), 'isParticipant')).toBe(false);
    expect(check(await person('u-fay'), schema, on(twice), 'isParticipant')).toBe(true);
  });
});

describe('validateActionRule: the arm’s shape', () => {
  const arm = (over: Row) => ({
    rel: 'participants',
    arrayOperator: 'any',
    condition: true,
    ...over,
  });

  test('only `any` crosses a list', () => {
    expect(validateActionRule(arm({})).ok).toBe(true);
    for (const operator of ['all', 'none', 'atLeast', 'atMost', 'exactly', 'empty', 'notEmpty'])
      expect(validateActionRule(arm({ arrayOperator: operator })).errors).toEqual([
        expect.objectContaining({ path: '$.arrayOperator', code: 'arrayOperator' }),
      ]);
    expect(validateActionRule(arm({ arrayOperator: 'some' })).ok).toBe(false);
  });

  test('a schema is frozen on its first check: an operator edited onto it afterwards throws', async () => {
    const edited = schemaWith(structuredClone(isParticipant));
    const arm = edited.permissions['db:conversation']?.actions.isParticipant as {
      arrayOperator: string;
    };
    const fay = await person('u-fay', 'advocate');
    const c1 = await conversation('c1');
    expect(check(fay, edited, on(c1), 'isParticipant')).toBe(true);
    expect(() => {
      arm.arrayOperator = 'none';
    }).toThrow();
    expect(arm.arrayOperator).toBe('any');
  });

  test('one list, a condition, nothing else', () => {
    expect(validateActionRule(arm({ rel: 'conversation.participants' })).ok).toBe(false);
    expect(validateActionRule(arm({ count: 2 })).ok).toBe(false);
    expect(validateActionRule({ rel: 'participants', arrayOperator: 'any' }).ok).toBe(false);
    expect(validateActionRule(arm({ action: 'chat' })).ok).toBe(false);
    expect(
      validateActionRule(arm({ condition: { rule: actorIsParticipant.rule } })).errors,
    ).toEqual([expect.objectContaining({ path: '$.condition.rule', code: 'notPositive' })]);
  });

  test('a schema holding a refused operator throws on every check', async () => {
    const bad = schemaWith({ ...isParticipant, arrayOperator: 'none' } as unknown as ActionRule);
    expect(() => check(createPermissions(), bad, on({ uuid: 'c1' }), 'manage')).toThrow(
      /not a well-formed positive rule/,
    );
  });
});

describe('validateSchema: what a list arm may cross and read', () => {
  const codes = (over: SchemaMap, rules: RebacSchema) =>
    validateSchema(over, rules).errors.map((issue) => `${issue.path} ${issue.code}`);
  const withConversation = (actions: Record<string, ActionRule>): RebacSchema => ({
    permissions: {
      ...schema.permissions,
      'db:conversation': { actions: { isParticipant, ...actions } },
    },
  });
  const item = (condition: ActionRule): ActionRule => ({
    rel: 'participants',
    arrayOperator: 'any',
    condition,
  });

  test('a plain `rel` through a list is invalid, declared or not', () => {
    expect(codes(map, withConversation({ a: { rel: 'participants', action: 'isSelf' } }))).toEqual([
      'db:conversation.a relation',
    ]);
    expect(
      codes(map, withConversation({ a: { rel: 'messages', action: 'inConversation' } })),
    ).toEqual(['db:conversation.a relation']);
  });

  test('a list arm over a list that is not declared is invalid', () => {
    const rule: ActionRule = { rel: 'messages', arrayOperator: 'any', condition: true };
    expect(codes(map, withConversation({ a: rule }))).toEqual(['db:conversation.a down']);
    expect(codes(mapOver(annotate(models, 'Conversation', 'participants')), schema)).toEqual([
      'db:conversation.chat.all[1] down',
      'db:conversation.chatRead.all[1] down',
      'db:conversation.isParticipant down',
    ]);
  });

  test('a walk under an item must stay inside what the declaration loads', () => {
    expect(
      codes(map, withConversation({ a: item({ rel: 'forumUser.brand', action: 'manage' }) })),
    ).toEqual(['db:conversation.a.condition down']);
    expect(
      codes(map, withConversation({ a: item({ rel: 'conversation', action: 'manage' }) })),
    ).toEqual(['db:conversation.a.condition down']);
    expect(
      codes(map, withConversation({ a: item({ rel: 'forumUser.fanUser', action: 'manage' }) })),
    ).toEqual(['db:conversation.a.condition down']);
  });

  test('the declaration the ruling wrote loads one hop too few for a walk into the table', () => {
    const short = mapOver(
      annotate(models, 'Conversation', 'participants', {
        down: ['forumUser.fanUser', 'forumUser.brandUser'],
      }),
    );
    const result = validateSchema(short, withConversation({ isParticipant }));
    expect(result.errors.map((issue) => issue.message)).toEqual([
      '`db:conversation.participants` loads no `forumUser.fanUser.user` under an item: name it in `/// @permissions(down: [...])`',
      '`db:conversation.participants` loads no `forumUser.brandUser.user` under an item: name it in `/// @permissions(down: [...])`',
    ]);
  });

  test('a `{ rule }` under an item may read only loaded relations', () => {
    const reads = (field: string): ActionRule =>
      item({ rule: { field, operator: 'equals', value: 'x' } });
    expect(codes(map, withConversation({ a: reads('forumUser.fanUser.userUuid') }))).toEqual([]);
    expect(codes(map, withConversation({ a: reads('leftAt') }))).toEqual([]);
    expect(codes(map, withConversation({ a: reads('forumUser.brand.uuid') }))).toEqual([
      'db:conversation.a.condition down',
    ]);
    expect(codes(map, withConversation({ a: reads('conversation.brandUuid') }))).toEqual([
      'db:conversation.a.condition down',
    ]);
  });

  test('one list per walk', () => {
    const nested = item({ rel: 'participants', arrayOperator: 'any', condition: true });
    expect(codes(map, withConversation({ a: nested }))).toEqual([
      'db:conversation.a.condition down',
    ]);
  });
});

describe('the declaration, read strictly when the map is first used', () => {
  const boot = (model: string, field: string, permissions: Record<string, AnnoValue>) => () =>
    createRebacCheck(mapOver(annotate(models, model, field, permissions)));
  const down = (value: AnnoValue) => boot('Conversation', 'participants', { down: value });

  test('a value field-map keeps mangled is refused, not guessed at', () => {
    expect(down('participants[forumUser')).toThrow(/list of dotted relation paths/);
    expect(down(['{ forumUser: [userUuid'])).toThrow(/list of dotted relation paths/);
    expect(down('forumUser.fanUser')).toThrow(/list of dotted relation paths/);
    expect(down([])).not.toThrow();
  });

  test('each path is to-one relations that own their key, never back up, never a second list', () => {
    expect(down(['conversation'])).toThrow(/goes back up/);
    expect(down(['forumUser.nope'])).toThrow(/not a to-one relation/);
    expect(down(['leftAt'])).toThrow(/not a to-one relation/);
    expect(down(['conversation.participants'])).toThrow(/goes back up/);
    expect(boot('Conversation', 'brand', { down: [] })).toThrow(/sits on a list relation/);
  });

  test('unknown keys and an empty annotation are refused', () => {
    expect(boot('Conversation', 'participants', { dwon: [] })).toThrow(/unknown key `dwon`/);
    expect(boot('Conversation', 'participants', {})).toThrow(/no `key: value` read/);
  });

  test('a list with no foreign key back (an implicit many-to-many) is refused', () => {
    const copy = annotate(models, 'Conversation', 'participants', { down: [] });
    const { conversation: _back, ...fields } = copy.ConversationParticipant?.fields ?? {};
    const withoutBack = {
      ...copy,
      ConversationParticipant: { ...copy.ConversationParticipant, fields },
    };
    expect(() => createRebacCheck(mapOver(withoutBack))).toThrow(/exactly one foreign key back/);
  });
});

describe('createHydrator: one jump down', () => {
  test('one list load, then only the declared paths under each item', async () => {
    const loads: string[] = [];
    const data = store();
    const c1 = await hydratorOver(
      data,
      map,
      loads,
    )('db:conversation', data['db:conversation']?.[0] as Row);
    expect(loads.filter((line) => line.startsWith('loadMany'))).toEqual([
      'loadMany db:conversationParticipant {"conversationUuid":"c1"}',
    ]);
    const [fay] = c1.participants as Row[];
    expect(fay).toEqual({
      uuid: 'p-fay',
      conversationUuid: 'c1',
      forumUserUuid: 'fu-fay',
      leftAt: null,
      forumUser: {
        uuid: 'fu-fay',
        fanUserUuid: 'f-fay',
        brandUserUuid: null,
        brandUuid: 'b1',
        fanUser: { uuid: 'f-fay', userUuid: 'u-fay', brandUuid: 'b1', user: { uuid: 'u-fay' } },
      },
    });
  });

  test('the list is set by the hydrator: a list the caller supplied is replaced', async () => {
    const loads: string[] = [];
    const forged = [{ leftAt: null, forumUser: { fanUser: { user: { uuid: 'u-otto' } } } }];
    const hydrate = hydratorOver(store(), map, loads);
    const created = await hydrate('db:conversation', { brandUuid: 'b1', participants: forged });
    expect(created.participants).toEqual([]);
    expect(loads.some((line) => line.startsWith('loadMany'))).toBe(false);
    expect(check(await person('u-otto', 'advocate'), schema, on(created), 'chat')).toBe(false);
    const existing = await hydrate('db:conversation', {
      uuid: 'c-empty',
      brandUuid: 'b1',
      participants: forged,
    });
    expect(existing.participants).toEqual([]);
  });

  test('a list on a model reached under an item is not followed', async () => {
    const copy = annotate(models, 'Conversation', 'participants', { down: ['forumUser'] });
    const withBack: SchemaMap = mapOver(copy);
    const data = store();
    const loads: string[] = [];
    await hydratorOver(
      data,
      withBack,
      loads,
    )('db:conversation', data['db:conversation']?.[0] as Row);
    expect(loads.filter((line) => line.startsWith('loadMany')).length).toBe(1);
    expect(loads.some((line) => line.includes('db:fanUsers'))).toBe(false);
  });

  test('a map that declares a list needs `loadMany`', () => {
    expect(() => createHydrator({ map, load: async () => null })).toThrow(/pass `loadMany`/);
  });
});

// The adversarial review's reproductions (A-1 to A-6), each asserting the fixed behaviour.
describe('what a record may carry into a check', () => {
  const forged = [
    { leftAt: null, forumUser: { fanUser: { uuid: 'f-otto', user: { uuid: 'u-otto' } } } },
  ];
  const inConversation = async (record: Row) =>
    check(
      await person('u-otto', 'advocate'),
      schema,
      on(record, 'db:chatMessage'),
      'inConversation',
    );

  test('the hydrator keeps no value it did not load under a to-one or a declared list', async () => {
    const hydrate = hydratorOver(store());
    const claimed = { uuid: 'c1', participants: forged };
    const noKey = await hydrate('db:chatMessage', { conversation: claimed });
    const deadKey = await hydrate('db:chatMessage', {
      conversationUuid: 'c-nope',
      conversation: claimed,
    });
    const realKey = await hydrate('db:chatMessage', {
      conversationUuid: 'c1',
      conversation: claimed,
    });
    expect(noKey).not.toHaveProperty('conversation');
    expect(deadKey).not.toHaveProperty('conversation');
    expect(((realKey.conversation as Row).participants as Row[]).map((item) => item.uuid)).toEqual([
      'p-fay',
      'p-rex',
      'p-lee',
    ]);
    for (const record of [noKey, deadKey, realKey])
      expect(await inConversation(record)).toBe(false);
  });

  test('under an item too: a declared relation holds the loaded row or nothing', async () => {
    const data = store();
    const hydrate = createHydrator({
      map,
      load: async (resource, where) => data[resource]?.find(matches(where)) ?? null,
      loadMany: async () =>
        [
          { uuid: 'p-x', forumUserUuid: null },
          { uuid: 'p-y', forumUserUuid: 'fu-nope' },
        ].map((item) => ({ ...forged[0], conversationUuid: 'c1', ...item })),
    });
    const c1 = await hydrate('db:conversation', { uuid: 'c1', brandUuid: 'b1' });
    for (const item of c1.participants as Row[]) expect(item).not.toHaveProperty('forumUser');
    expect(check(await person('u-otto'), schema, on(c1), 'isParticipant')).toBe(false);
  });

  test('a field an item does not carry is unknown: it never passes `equals null`', async () => {
    const lee = await person('u-lee');
    // a left member whose row came back without `leftAt` (a select, a projection)
    const member = { forumUser: { fanUser: { uuid: 'f-lee', user: { uuid: 'u-lee' } } } };
    expect(check(lee, schema, on({ uuid: 'c1', participants: [member] }), 'isParticipant')).toBe(
      false,
    );
    const present = { uuid: 'c1', participants: [{ ...member, leftAt: null }] };
    expect(check(lee, schema, on(present), 'isParticipant')).toBe(true);
  });

  test('a read under an item of a path nothing loaded is refused inline and widens nothing in a row rule', async () => {
    const otto = await person('u-otto');
    const c1 = await conversation('c1');
    const reads: ActionRule = {
      rel: 'participants',
      arrayOperator: 'any',
      condition: { rule: { field: 'forumUser.brand.deletedAt', operator: 'equals', value: null } },
    };
    expect(() => check(otto, schema, on(c1), reads)).toThrow(
      /loads no `forumUser.brand` under an item/,
    );
    const rowRule = { ...c1, permissionRules: { isParticipant: reads } };
    expect(check(otto, schema, on(rowRule), 'isParticipant')).toBe(false);
    // off an item the same read is unknown too: a check never reads a missing value as null
    const offItem: ActionRule = {
      rule: { field: 'brand.deletedAt', operator: 'equals', value: null },
    };
    expect(check(otto, schema, on(c1), offItem)).toBe(false);
  });

  test('the same read written in the schema is refused on first use', async () => {
    const reads: ActionRule = {
      rel: 'participants',
      arrayOperator: 'any',
      condition: { rule: { field: 'forumUser.brand.deletedAt', operator: 'equals', value: null } },
    };
    const undeclared = schemaWith(reads);
    expect(validateSchema(map, undeclared).ok).toBe(false);
    const c1 = await conversation('c1');
    const otto = await person('u-otto');
    expect(() => check(otto, undeclared, on(c1), 'manage')).toThrow(
      /loads no `forumUser.brand` under an item/,
    );
  });
});

describe('one list per walk', () => {
  const scalar = stringColumn;
  const list = (type: string, down: string[]) => ({
    kind: 'object' as const,
    type,
    isList: true,
    fromFields: [],
    toFields: [],
    annotations: { permissions: { down } },
  });
  const toOne = (type: string, key: string) => ({
    kind: 'object' as const,
    type,
    isList: false,
    fromFields: [key],
    toFields: ['uuid'],
  });
  const twoLists: SchemaMap = {
    resources: { a: 'A', b: 'B', c: 'C', 'db:user': 'User' },
    fieldMap: {
      models: {
        A: { fields: { uuid: scalar, bs: list('B', []) } },
        B: {
          fields: { uuid: scalar, aUuid: scalar, a: toOne('A', 'aUuid'), cs: list('C', ['user']) },
        },
        C: {
          fields: {
            uuid: scalar,
            bUuid: scalar,
            userUuid: scalar,
            b: toOne('B', 'bUuid'),
            user: toOne('User', 'userUuid'),
          },
        },
        User: { fields: { uuid: scalar } },
      },
    },
  };
  const inner: ActionRule = {
    rel: 'cs',
    arrayOperator: 'any',
    condition: { rel: 'user', action: 'own' },
  };
  const rules = (a: Record<string, ActionRule>): RebacSchema => ({
    permissions: {
      a: { actions: a },
      b: { actions: { inner } },
      c: { actions: {} },
      'db:user': { actions: { own: null } },
    },
  });
  const b1 = { uuid: 'b1', cs: [{ uuid: 'c1', user: { uuid: 'u-fay' } }] };
  const record = { uuid: 'a1', bs: [b1] };

  test('the engine does not cross a second list, though the data is there', async () => {
    const fay = await person('u-fay');
    const ask = createRebacCheck(twoLists);
    const nested: ActionRule = { rel: 'bs', arrayOperator: 'any', condition: inner };
    const delegated: ActionRule = { rel: 'bs', arrayOperator: 'any', condition: 'inner' };
    // the one list crossed from its own row passes: the data and the rule are sound
    expect(ask(fay, rules({}), { resource: 'b', record: b1 }, 'inner')).toBe(true);
    for (const second of [nested, delegated]) {
      expect(() => ask(fay, rules({}), { resource: 'a', record }, second)).toThrow(
        /second list under an item/,
      );
      const rowRule = { ...record, permissionRules: { in: second } };
      expect(ask(fay, rules({ in: null }), { resource: 'a', record: rowRule }, 'in')).toBe(false);
    }
    for (const second of [nested, delegated]) {
      const schemaWithSecond = rules({ in: second });
      expect(validateSchema(twoLists, schemaWithSecond).errors.map((issue) => issue.code)).toEqual([
        'down',
      ]);
      expect(() => ask(fay, schemaWithSecond, { resource: 'a', record }, 'in')).toThrow(
        /second list under an item/,
      );
    }
  });

  test('nothing under an item counts in the grant check’s first pass, whatever object it is', async () => {
    const rex = await person('u-rex');
    const c1 = await conversation('c1');
    const entry: EntitlementEntry = {
      resource: 'db:conversation',
      anchor: { resource: 'db:conversation', id: 'c1' },
      actions: { isParticipant: true },
    };
    const hal = await person('u-hal');
    await hal.setup(
      [
        {
          resource: 'db:brandUsers',
          anchor: { resource: 'db:brandUsers', id: 'bu-rex' },
          actions: { isSelf: true },
          grantsBelow: true,
        },
      ],
      { owner: rex },
    );
    // bu-rex is above c1 (createdBy -> brandUser) and also under the item p-rex
    expect(canGrant(hal, schema, entry, c1)).toBe(false);
    const createdBy = c1.createdBy as Row;
    const rexItem = (c1.participants as Row[]).find((item) => item.uuid === 'p-rex') as Row;
    // what a memoising loader hands out: the item holds the very object that sits above
    const shared = {
      ...c1,
      participants: [
        {
          ...rexItem,
          forumUser: { ...(rexItem.forumUser as Row), brandUser: createdBy.brandUser },
        },
      ],
    };
    expect(canGrant(hal, schema, entry, shared)).toBe(false);
    // at read the same entitlement still makes its holder a participant
    expect(check(hal, schema, on(c1), 'isParticipant')).toBe(true);
    // the writer's own table under an item is its role, and counts
    const keyed = createPermissions();
    await keyed.setup([{ resource: 'db:brandUsers', id: 'bu-rex', actions: { isSelf: true } }]);
    expect(canGrant(keyed, schema, entry, c1)).toBe(true);
  });

  test('a `where` pins scalar values only: no relation, and so no list, lands on a stand-in', async () => {
    const copy = structuredClone(models);
    const message = copy.ChatMessage?.fields as Record<string, unknown>;
    message.senderUuid = { kind: 'scalar', type: 'String', isList: false };
    message.sender = {
      kind: 'object',
      type: 'ForumUser',
      isList: false,
      fromFields: ['senderUuid'],
      toFields: ['uuid'],
    };
    const withSender = mapOver(copy);
    const claimed = {
      participants: [
        { leftAt: null, forumUser: { fanUser: { uuid: 'f-otto', user: { uuid: 'u-otto' } } } },
      ],
    };
    const entry = (where: EntitlementEntry['where']): EntitlementEntry => ({
      resource: 'db:chatMessage',
      anchor: { resource: 'db:brands', id: 'b1', path: 'sender.brand' },
      where,
      actions: { inConversation: true },
    });
    const forged = entry({ field: 'conversation', operator: 'equals', value: claimed });
    const placed = placeEntitlement(withSender, forged, { uuid: 'b1' }) as Row[];
    expect(placed.length).toBe(1);
    for (const stand of placed) {
      expect(stand).not.toHaveProperty('conversation');
      expect(
        createCanGrantEntitlement(withSender)(await person('u-otto'), schema, forged, stand),
      ).toBe(false);
    }
    const pins = (field: string, value: unknown) =>
      (
        placeEntitlement(
          withSender,
          entry({ field, operator: 'equals', value } as EntitlementEntry['where']),
          { uuid: 'b1' },
        ) as Row[]
      )[0];
    expect(pins('uuid', ['m1'])).not.toHaveProperty('uuid');
    expect(pins('uuid', { in: 'm1' })).not.toHaveProperty('uuid');
    expect(pins('uuid', 'm1')).toHaveProperty('uuid', 'm1');
    expect(pins('conversationUuid', null)).toHaveProperty('conversationUuid', null);
  });
});

describe('the declaration carries what the rule walks', () => {
  const twoSegments = mapOver(
    annotate(models, 'Conversation', 'participants', {
      down: ['forumUser.fanUser', 'forumUser.brandUser'],
    }),
  );
  const participantBy = (action: string): ActionRule => ({
    rel: 'participants',
    arrayOperator: 'any',
    condition: {
      all: [
        { rule: { field: 'leftAt', operator: 'equals', value: null } },
        {
          any: [
            { rel: 'forumUser.fanUser', action },
            { rel: 'forumUser.brandUser', action },
          ],
        },
      ],
    },
  });
  // Zealot's own grants: an id-keyed table grant on the person's membership row.
  const fayWith = async (action: string) => {
    const fay = await person('u-fay');
    await fay.setup([{ resource: 'db:fanUsers', id: 'f-fay', actions: { [action]: true } }]);
    return fay;
  };
  const c1Over = (over: SchemaMap, loads: string[] = []) => {
    const data = store();
    return hydratorOver(data, over, loads)('db:conversation', data['db:conversation']?.[0] as Row);
  };

  test('an action whose rule walks on to the person needs the person declared: both refuse', async () => {
    const rules = schemaWith(participantBy('operate'));
    expect(validateSchema(twoSegments, rules).errors.map((issue) => issue.message)).toEqual([
      '`db:conversation.participants` loads no `forumUser.fanUser.user` under an item: name it in `/// @permissions(down: [...])`',
      '`db:conversation.participants` loads no `forumUser.brandUser.user` under an item: name it in `/// @permissions(down: [...])`',
      '`db:conversation.participants` loads no `forumUser.fanUser.user` under an item: name it in `/// @permissions(down: [...])`',
      '`db:conversation.participants` loads no `forumUser.brandUser.user` under an item: name it in `/// @permissions(down: [...])`',
      '`db:conversation.participants` loads no `forumUser.fanUser.user` under an item: name it in `/// @permissions(down: [...])`',
      '`db:conversation.participants` loads no `forumUser.brandUser.user` under an item: name it in `/// @permissions(down: [...])`',
    ]);
    const ask = createRebacCheck(twoSegments);
    const c1 = await c1Over(twoSegments);
    const fay = await fayWith('operate');
    expect(() => ask(fay, rules, on(c1), 'isParticipant')).toThrow(
      /loads no `forumUser.fanUser.user` under an item/,
    );
    // with the person declared the same rule validates, and needs no grant on the membership
    expect(validateSchema(map, rules).ok).toBe(true);
    expect(check(await person('u-fay'), rules, on(await c1Over(map)), 'isParticipant')).toBe(true);
    expect(check(await person('u-otto'), rules, on(await c1Over(map)), 'isParticipant')).toBe(
      false,
    );
  });

  test('an action answered by the table on the membership row needs only the membership', async () => {
    const tableOnly: RebacSchema = {
      permissions: {
        ...schemaWith(participantBy('self')).permissions,
        'db:fanUsers': { actions: { self: null } },
        'db:brandUsers': { actions: { self: null } },
      },
    };
    expect(validateSchema(twoSegments, tableOnly)).toEqual({ ok: true, errors: [], warnings: [] });
    const loads: string[] = [];
    const c1 = await c1Over(twoSegments, loads);
    // the only user row loaded is the creator's, by the ordinary upward walk; none under an item
    expect(loads.filter((line) => line.startsWith('load db:user'))).toEqual([
      'load db:user {"uuid":"u-rex"}',
    ]);
    const ask = createRebacCheck(twoSegments);
    expect(ask(await fayWith('self'), tableOnly, on(c1), 'isParticipant')).toBe(true);
    expect(ask(await person('u-fay'), tableOnly, on(c1), 'isParticipant')).toBe(false);
    expect(ask(await person('u-otto'), tableOnly, on(c1), 'isParticipant')).toBe(false);
  });
});

describe('validation edges under an item', () => {
  test('`down` beside `hydrate: false` is refused', () => {
    const both = annotate(models, 'Conversation', 'participants', { down: [], hydrate: false });
    expect(() => createRebacCheck(mapOver(both))).toThrow(/`hydrate: false` says not to/);
  });

  test('a `{ rule }` under an item that reads through a relation outside the map is reported', () => {
    const copy = structuredClone(models);
    (copy.ConversationParticipant?.fields as Record<string, unknown>).note = {
      kind: 'object',
      type: 'Note',
      isList: false,
      fromFields: ['noteUuid'],
      toFields: ['uuid'],
    };
    const reads: ActionRule = {
      rel: 'participants',
      arrayOperator: 'any',
      condition: { rule: { field: 'note.text', operator: 'equals', value: 'x' } },
    };
    const errors = validateSchema(mapOver(copy), schemaWith(reads)).errors;
    expect(errors.map((issue) => issue.code)).toEqual(['lens', 'lens', 'lens']);
    expect(errors[0]?.message).toMatch(/leads to `Note`, which is not a resource in the map/);
  });

  test('a bridge under an item is refused by validateSchema and inline, and widens nothing in a row rule', async () => {
    const bridges: JoinedBridge[] = [
      {
        endpoints: [
          { fieldMap: 'crm', model: 'Account', on: 'id' },
          { fieldMap: 'db', model: 'conversationParticipant', on: 'accountId' },
        ],
        cardinality: 'oneToMany',
      },
    ];
    const viaBridge: ActionRule = {
      rel: 'participants',
      arrayOperator: 'any',
      condition: { rel: 'crm:Account', action: 'open' },
    };
    const bridged = (over: Record<string, ActionRule>): RebacSchema => ({
      bridges,
      permissions: {
        ...schema.permissions,
        'db:conversation': { actions: { isParticipant, ...over } },
        'crm:Account': { actions: { open: true } },
      },
    });
    const [issue] = validateSchema(map, bridged({ a: viaBridge })).errors;
    expect(issue).toMatchObject({ code: 'down' });
    expect(issue?.message).toMatch(/stays on the declared relations/);
    const record = { uuid: 'c1', participants: [{ uuid: 'p1', accountId: 'acc1' }] };
    const subject = { ...on(record), data: { 'crm:Account': [{ id: 'acc1' }] } };
    const otto = await person('u-otto');
    expect(() => check(otto, bridged({}), subject, viaBridge)).toThrow(
      /stays on the declared relations/,
    );
    const rowRule = {
      ...subject,
      record: { ...record, permissionRules: { isParticipant: viaBridge } },
    };
    expect(check(otto, bridged({}), rowRule, 'isParticipant')).toBe(false);
    // control: off an item the same hop reaches the far row
    const item = { resource: 'db:conversationParticipant', record: record.participants[0] as Row };
    const hop: ActionRule = { rel: 'crm:Account', action: 'open' };
    expect(check(otto, bridged({}), { ...item, data: subject.data }, hop)).toBe(true);
  });

  test("a bridge in an item's own row rule is not crossed under the list arm", async () => {
    const bridges: JoinedBridge[] = [
      {
        endpoints: [
          { fieldMap: 'crm', model: 'Account', on: 'id' },
          { fieldMap: 'db', model: 'conversationParticipant', on: 'accountId' },
        ],
        cardinality: 'oneToMany',
      },
    ];
    const bridged: RebacSchema = {
      bridges,
      permissions: {
        ...schema.permissions,
        'db:conversation': {
          actions: {
            isParticipant,
            throughAnAccount: {
              rel: 'participants',
              arrayOperator: 'any',
              condition: 'viaAccount',
            },
          },
        },
        'db:conversationParticipant': {
          actions: {
            ...schema.permissions['db:conversationParticipant']?.actions,
            viaAccount: null,
          },
        },
        'crm:Account': { actions: { open: true } },
      },
    };
    expect(validateSchema(map, bridged).errors).toEqual([]);
    const participant = {
      uuid: 'p1',
      accountId: 'acc1',
      permissionRules: { viaAccount: { rel: 'crm:Account', action: 'open' } },
    };
    const subject = {
      ...on({ uuid: 'c1', participants: [participant] }),
      data: { 'crm:Account': [{ id: 'acc1' }] },
    };
    expect(check(await person('u-otto'), bridged, subject, 'throughAnAccount')).toBe(false);
  });
});

describe('what the hydrator does not follow, no check reads', () => {
  test('a value under hydrate: false, or under a to-one keyed on the other side, is left and never read', async () => {
    const fieldMap: FieldMap = {
      models: {
        Message: {
          fields: {
            id: { kind: 'scalar', type: 'String', isId: true },
            conversationId: { kind: 'scalar', type: 'String' },
            conversation: {
              kind: 'object',
              type: 'Conversation',
              isList: false,
              fromFields: ['conversationId'],
              toFields: ['id'],
              annotations: { permissions: { hydrate: false } },
            },
            pinnedIn: { kind: 'object', type: 'Conversation', isList: false },
            attachments: { kind: 'object', type: 'Attachment', isList: true },
            permissionRules: { kind: 'scalar', type: 'Json' },
          },
        },
        Conversation: { fields: { id: { kind: 'scalar', type: 'String', isId: true } } },
      },
    };
    const lib: SchemaMap = {
      resources: { 'db:message': 'Message', 'db:conversation': 'Conversation' },
      fieldMap,
    };
    const hydrate = createHydrator({ map: lib, load: async () => null });
    const hydrated = await hydrate('db:message', {
      id: 'm1',
      conversationId: 'c1',
      conversation: { id: 'c1', participants: [{ forged: true }] },
      pinnedIn: { id: 'c1' },
      attachments: [{ id: 'a1' }],
    });
    expect(hydrated.pinnedIn).toEqual({ id: 'c1' });
    expect(hydrated.attachments).toEqual([{ id: 'a1' }]);
    const ask = createRebacCheck(lib);
    const rules: RebacSchema = {
      permissions: {
        'db:message': { actions: { read: null } },
        'db:conversation': { actions: {} },
      },
    };
    const otto = await person('u-otto');
    const reads = (field: string): ActionRule => ({
      rule: { field, operator: 'equals', value: 'c1' },
    });
    expect(() =>
      ask(otto, rules, { resource: 'db:message', record: hydrated }, reads('conversation.id')),
    ).toThrow(/`hydrate: false`/);
    expect(() =>
      ask(otto, rules, { resource: 'db:message', record: hydrated }, reads('pinnedIn.id')),
    ).toThrow(/keeps its foreign key on `Conversation`/);
    const rowRule = { ...hydrated, permissionRules: { read: reads('pinnedIn.id') } };
    expect(ask(otto, rules, { resource: 'db:message', record: rowRule }, 'read')).toBe(false);
  });
});
