import { afterEach, describe, expect, test } from 'bun:test';
import { engineGlobals } from '@inixiative/json-rules';
import type { RebacSchema } from '../index';
import { createPermissions, createRebacCheck } from '../index';
import { mapOf } from './schemaMaps';

const schema: RebacSchema = {
  permissions: {
    organization: { actions: { manage: null } },
    document: { actions: { manage: { rel: 'organization', action: 'manage' } } },
  },
};

const check = createRebacCheck(mapOf({ document: { organization: 'organization' } }));

const granted = async (id: string) => {
  const permix = createPermissions();
  await permix.setup([{ resource: 'organization', id, actions: { manage: true } }]);
  return permix;
};

afterEach(() => engineGlobals.reset());

describe('permissions.idField', () => {
  test('defaults to id', () => {
    expect(engineGlobals.get('permissions.idField')).toBe('id');
  });

  test('a grant keyed by the set idField hits the record carrying it, through a walk too', async () => {
    engineGlobals.set('permissions.idField', 'uuid');
    const permix = await granted('o-uuid');
    const organization = { id: 7, uuid: 'o-uuid' };
    expect(
      check(permix, schema, { resource: 'organization', record: organization }, 'manage'),
    ).toBe(true);
    expect(
      check(permix, schema, { resource: 'document', record: { organization } }, 'manage'),
    ).toBe(true);
  });

  test('unset, the grant is keyed by id and a uuid-keyed grant misses', async () => {
    const organization = { id: 7, uuid: 'o-uuid' };
    const record = { resource: 'organization', record: organization };
    expect(check(await granted('o-uuid'), schema, record, 'manage')).toBe(false);
    expect(check(await granted('7'), schema, record, 'manage')).toBe(true);
  });

  test('scoped with engineGlobals.with, any field name: _id', async () => {
    const permix = await granted('mongo-1');
    const seen = engineGlobals.with({ 'permissions.idField': '_id' }, () =>
      check(permix, schema, { resource: 'organization', record: { _id: 'mongo-1' } }, 'manage'),
    );
    expect(seen).toBe(true);
  });

  test('a record without the idField has no id and only resource-wide grants reach it', async () => {
    engineGlobals.set('permissions.idField', 'uuid');
    const record = { resource: 'organization', record: { id: 'o-uuid' } };
    expect(check(await granted('o-uuid'), schema, record, 'manage')).toBe(false);
  });
});
