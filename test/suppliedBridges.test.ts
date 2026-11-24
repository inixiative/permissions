import { describe, expect, test } from 'bun:test';
import type { FieldMap } from '@inixiative/field-map';
import { type Bridge, Operator } from '@inixiative/json-rules';
import {
  type ActionRule,
  makeHydrator,
  makeRebacCheck,
  type PermixLike,
  type Row,
  ruleFieldEqualsPath,
  type SchemaMap,
  suppliedMapNamesOf,
  validateActionRule,
  validateSchemaMap,
} from '../index';

const id = { kind: 'scalar', type: 'String', isId: true } as const;
const column = { kind: 'scalar', type: 'String' } as const;

const db: FieldMap = {
  models: {
    Doc: {
      fields: {
        id,
        ownerId: column,
        orgId: column,
        org: {
          kind: 'object',
          type: 'Org',
          isList: false,
          fromFields: ['orgId'],
          toFields: ['id'],
        },
      },
    },
    Org: { fields: { id, ownerId: column } },
  },
};
const crm: FieldMap = { models: { Account: { fields: { id, ownerId: column } } } };
const actor: FieldMap = { models: { User: { fields: { id, deviceSerial: column } } } };
const sec: FieldMap = { models: { Device: { fields: { serial: column, risk: column } } } };
const tool: FieldMap = { models: { Scan: { fields: { verdict: column } } } };

const supplied = (near: { fieldMap: string; model?: string }, far: string): Bridge => {
  const [fieldMap = '', model = ''] = far.split(':');
  return {
    endpoints: [near as { fieldMap: string }, { fieldMap, model }],
    cardinality: 'oneToOne',
  };
};
const actorFromDb = supplied({ fieldMap: 'db' }, 'actor:User');
const deviceOfActor: Bridge = {
  endpoints: [
    { fieldMap: 'actor', model: 'User', on: 'deviceSerial' },
    { fieldMap: 'sec', model: 'Device', on: 'serial' },
  ],
  cardinality: 'oneToOne',
};

const mine = ruleFieldEqualsPath('ownerId', 'actor:User.id');
const schemaMapOf = (
  permissions: SchemaMap['permissions'],
  bridges: Bridge[] = [actorFromDb],
  fieldMaps: SchemaMap['fieldMaps'] = { db, crm, actor, sec, tool },
): SchemaMap => ({ fieldMaps, bridges, permissions });

const nobody: PermixLike = { check: () => false };
const u1 = { 'actor:User': [{ id: 'u1', deviceSerial: 's1' }] };
const reads = (schemaMap: SchemaMap, resource: string, record: Row, bridgeData?: Row) =>
  makeRebacCheck(schemaMap)(
    nobody,
    {
      resource,
      record,
      ...(bridgeData ? { bridgeData: bridgeData as Record<string, Row[]> } : {}),
    },
    'read',
  );
const messages = (schemaMap: SchemaMap) =>
  validateSchemaMap(schemaMap).errors.map((issue) => issue.message);

describe('a supplied map is a field map a declared supplied bridge ends in', () => {
  test('a rule on any model of the map the bridge starts from reads the supplied row', () => {
    const schemaMap = schemaMapOf({
      'db:Doc': { actions: { read: mine } },
      'db:Org': { actions: { read: mine } },
    });
    expect(messages(schemaMap)).toEqual([]);
    expect(reads(schemaMap, 'db:Doc', { ownerId: 'u1' }, u1)).toBe(true);
    expect(reads(schemaMap, 'db:Org', { ownerId: 'u1' }, u1)).toBe(true);
    expect(reads(schemaMap, 'db:Doc', { ownerId: 'u2' }, u1)).toBe(false);
  });

  test('a model of a map no supplied bridge starts from cannot read it', () => {
    const schemaMap = schemaMapOf({
      'db:Doc': { actions: { read: true } },
      'crm:Account': { actions: { read: mine } },
    });
    expect(messages(schemaMap).join()).toMatch(/crm:Account\.read|actor:User/);
    expect(() => reads(schemaMap, 'crm:Account', { ownerId: 'u1' }, u1)).toThrow();
  });

  test('declare another bridge and that map reads it too', () => {
    const schemaMap = schemaMapOf(
      { 'db:Doc': { actions: { read: true } }, 'crm:Account': { actions: { read: mine } } },
      [actorFromDb, supplied({ fieldMap: 'crm' }, 'actor:User')],
    );
    expect(messages(schemaMap)).toEqual([]);
    expect(reads(schemaMap, 'crm:Account', { ownerId: 'u1' }, u1)).toBe(true);
  });

  test('a supplied bridge from one model is read on that model and refused on its neighbours', () => {
    const scanned: ActionRule = {
      rule: {
        all: [
          { field: 'tool:Scan.verdict', operator: Operator.exists },
          { field: 'tool:Scan.verdict', operator: Operator.equals, value: 'clean' },
        ],
      },
    };
    const bridges = [actorFromDb, supplied({ fieldMap: 'db', model: 'Doc' }, 'tool:Scan')];
    const onDoc = schemaMapOf({ 'db:Doc': { actions: { read: scanned } } }, bridges);
    expect(messages(onDoc)).toEqual([]);
    expect(reads(onDoc, 'db:Doc', {}, { 'tool:Scan': [{ verdict: 'clean' }] })).toBe(true);
    const onOrg = schemaMapOf({ 'db:Org': { actions: { read: scanned } } }, bridges);
    expect(messages(onOrg).join()).toMatch(/tool:Scan/);
  });

  test('a map joined from a supplied model is supplied: its rows are found by key, not given', () => {
    const lowRisk: ActionRule = {
      rule: {
        all: [
          { field: 'actor:User.sec:Device.risk', operator: Operator.exists },
          { field: 'actor:User.sec:Device.risk', operator: Operator.equals, value: 'low' },
        ],
      },
    };
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: lowRisk } } }, [
      actorFromDb,
      deviceOfActor,
    ]);
    expect(messages(schemaMap)).toEqual([]);
    const data = { ...u1, 'sec:Device': [{ serial: 's1', risk: 'low' }] };
    expect(reads(schemaMap, 'db:Doc', {}, data)).toBe(true);
    expect(reads(schemaMap, 'db:Doc', {}, u1)).toBe(false);
  });
});

describe('what a supplied map may not do', () => {
  test('it has no rules: a supplied bridge that ends in a map with rules is refused', () => {
    const schemaMap = schemaMapOf({
      'db:Doc': { actions: { read: true } },
      'actor:User': { actions: { read: true } },
    });
    const refusal = /has no join, so its far end is supplied, but `actor` holds records/;
    expect(messages(schemaMap).join()).toMatch(refusal);
    expect(() => reads(schemaMap, 'db:Doc', {})).toThrow(refusal);
  });

  test('it starts no supplied bridge: nothing is given from a given row', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      actorFromDb,
      supplied({ fieldMap: 'actor' }, 'tool:Scan'),
    ]);
    expect(messages(schemaMap).join()).toMatch(
      /has no join, so its far end is supplied, but `actor` holds records/,
    );
  });

  test('it is not joined to a map of records: no chain leads from a supplied row into the records', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      actorFromDb,
      {
        endpoints: [
          { fieldMap: 'actor', model: 'User', on: 'id' },
          { fieldMap: 'db', model: 'Doc', on: 'ownerId' },
        ],
        cardinality: 'oneToMany',
      },
    ]);
    const refusal = /a bridge between `actor:User` and `db:Doc` has one end supplied/;
    expect(messages(schemaMap).join()).toMatch(refusal);
    expect(() => reads(schemaMap, 'db:Doc', {})).toThrow(refusal);
  });

  test('it ends in a field map: a supplied bridge to a map that is not declared is refused', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      supplied({ fieldMap: 'db' }, 'nope:Thing'),
    ]);
    expect(messages(schemaMap).join()).toMatch(
      /ends in the map `nope`, which is not in `fieldMaps`/,
    );
  });
});

describe('what stays true of a supplied row', () => {
  const schemaMap = schemaMapOf({
    'db:Doc': {
      actions: {
        read: mine,
        throughOrg: { rule: { field: 'org.actor:User.id', operator: Operator.exists } },
      },
    },
    'db:Org': { actions: { read: false } },
  });

  test('it is read at the row the rule is on, never under a relation', () => {
    expect(messages(schemaMap).join()).toMatch(/org\.actor:User\.id/);
  });

  test('a row that is not given is absent: the rule fails', () => {
    const only = schemaMapOf({ 'db:Doc': { actions: { read: mine } } });
    expect(reads(only, 'db:Doc', { ownerId: 'u1' })).toBe(false);
    expect(reads(only, 'db:Doc', { ownerId: 'u1' }, {})).toBe(false);
  });

  test('a record cannot bring its own supplied row', () => {
    const only = schemaMapOf({ 'db:Doc': { actions: { read: mine } } });
    const forged = { ownerId: 'u1', 'actor:User': { id: 'u1' } };
    expect(reads(only, 'db:Doc', forged)).toBe(false);
    expect(reads(only, 'db:Doc', forged, { 'actor:User': [{ id: 'other' }] })).toBe(false);
  });

  test('a supplied bridge is never crossed by a rel', () => {
    const walked = schemaMapOf({
      'db:Doc': { actions: { read: { rel: 'actor:User', action: 'read' } } },
    });
    expect(messages(walked).length).toBeGreaterThan(0);
  });
});

describe('found by an adversarial review of this change', () => {
  test('a schema map whose rules are replaced after it was validated is checked on the new rules', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } });
    expect(messages(schemaMap)).toEqual([]);
    schemaMap.permissions = { 'db:Doc': { actions: { read: false } } };
    expect(reads(schemaMap, 'db:Doc', {})).toBe(false);
  });

  test('a check made before its schema map’s rules are replaced follows them too', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } });
    const check = makeRebacCheck(schemaMap);
    expect(check(nobody, { resource: 'db:Doc', record: {} }, 'read')).toBe(true);
    schemaMap.permissions = { 'db:Doc': { actions: { read: false } } };
    expect(check(nobody, { resource: 'db:Doc', record: {} }, 'read')).toBe(false);
  });

  test('a list arm over a supplied row is refused where no supplied bridge gives that row', () => {
    const grouped: SchemaMap['fieldMaps'] = {
      db,
      crm,
      actor: {
        models: {
          User: {
            fields: {
              id,
              groups: {
                kind: 'object',
                type: 'Group',
                isList: true,
                fromFields: [],
                toFields: [],
                annotations: { permissions: { down: [] } },
              },
            },
          },
          Group: { fields: { id, name: column } },
        },
      },
    };
    const inAGroup: ActionRule = {
      rel: 'actor:User.groups',
      arrayOperator: 'any',
      condition: { rule: { field: 'name', operator: Operator.exists } },
    };
    const fromDocOnly = [supplied({ fieldMap: 'db', model: 'Doc' }, 'actor:User')];
    const onDoc = schemaMapOf({ 'db:Doc': { actions: { read: inAGroup } } }, fromDocOnly, grouped);
    expect(messages(onDoc)).toEqual([]);
    const onOrg = schemaMapOf({ 'db:Org': { actions: { read: inAGroup } } }, fromDocOnly, grouped);
    expect(messages(onOrg).join()).toMatch(/no supplied bridge gives `actor:User` at `db:Org`/);
  });

  test('a read of a supplied row where no bridge gives it says so', () => {
    const schemaMap = schemaMapOf({
      'db:Doc': { actions: { read: true } },
      'crm:Account': { actions: { read: mine } },
    });
    expect(messages(schemaMap).join()).toMatch(
      /no supplied bridge gives `actor:User` at `crm:Account`/,
    );
  });

  test('a supplied bridge whose far end names no model of its map is reported, not thrown', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      supplied({ fieldMap: 'db' }, 'actor:Usr'),
    ]);
    expect(messages(schemaMap).join()).toMatch(/`actor:Usr` is not a model of the map `actor`/);
  });

  test('a supplied bridge that starts from a model its map does not have is reported', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      supplied({ fieldMap: 'db', model: 'Dco' }, 'actor:User'),
    ]);
    expect(messages(schemaMap).join()).toMatch(/`db:Dco` is not a model of the map `db`/);
  });

  test('a model is given or found by key, never both', () => {
    const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      actorFromDb,
      deviceOfActor,
      supplied({ fieldMap: 'db' }, 'sec:Device'),
    ]);
    expect(messages(schemaMap).join()).toMatch(
      /`sec:Device` is given by a supplied bridge and found by key through a joined one/,
    );
  });

  test('a rule asked on the spot at a resource with no bridge is refused', () => {
    const schemaMap = schemaMapOf({
      'db:Doc': { actions: { read: true } },
      'crm:Account': { actions: { read: true } },
    });
    const check = makeRebacCheck(schemaMap);
    expect(() =>
      check(nobody, { resource: 'crm:Account', record: {}, bridgeData: u1 }, mine),
    ).toThrow(/no supplied bridge gives `actor:User` at `crm:Account`/);
    expect(
      check(nobody, { resource: 'db:Doc', record: { ownerId: 'u1' }, bridgeData: u1 }, mine),
    ).toBe(true);
  });
});

describe('a hydrator hydrates its own field map', () => {
  const load = async () => null;

  test('a resource of another map is refused, not passed through with the caller’s rows', async () => {
    const hydrate = makeHydrator({ mapName: 'db', fieldMap: db, load });
    await expect(hydrate('crm:Account', { id: 'a1' })).rejects.toThrow(
      /`crm:Account` is not a model of the map `db` this hydrator was made for/,
    );
    await expect(hydrate('db:Nope', { id: 'x' })).rejects.toThrow(
      /`db:Nope` is not a model of the map `db` this hydrator was made for/,
    );
  });

  test('a map name that is no name is refused when the hydrator is made', () => {
    expect(() => makeHydrator({ mapName: 'a:b', fieldMap: db, load })).toThrow(
      /a map is named `a:b`/,
    );
  });
});

describe('found by the review of the consumers', () => {
  const schemaMap = schemaMapOf({ 'db:Doc': { actions: { read: true } } });
  const reading: ActionRule = { rule: { field: 'secret', operator: Operator.exists } };

  test('a rule validated at a resource the schema map does not have is reported, not passed', () => {
    const at = (resource: string) =>
      validateActionRule(reading, { schemaMap, resource }).errors.map((issue) => issue.message);
    expect(at('db:Doc').join()).toMatch(/secret/);
    expect(at('db:doc').join()).toMatch(/`db:doc` is not a model of the map `db`/);
    expect(at('Doc').join()).toMatch(/`Doc` names no map/);
    expect(at('nope:Thing').join()).toMatch(/`nope:Thing` is not a model of a map in `fieldMaps`/);
  });

  test('an app can ask which maps are supplied', () => {
    expect([...suppliedMapNamesOf(schemaMap)]).toEqual(['actor']);
    const joined = schemaMapOf({ 'db:Doc': { actions: { read: true } } }, [
      actorFromDb,
      deviceOfActor,
    ]);
    expect([...suppliedMapNamesOf(joined)].sort()).toEqual(['actor', 'sec']);
  });
});
