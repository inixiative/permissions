import { describe, expect, spyOn, test } from 'bun:test';
import { map, model, pool, schema, table } from '../bench/fixtures';
import { createRebacCheck, type PermissionEntry } from '../index';
import * as schemaMap from '../src/core/schemaMap';

// One check remembers what it computed (src/core/evaluate.ts, `WhatOneCheckRemembers`); nothing
// it remembers outlives the check.

const nobody = () =>
  table({ resource: 'elsewhere', id: 'x', actions: { own: true } } as PermissionEntry);

describe('a row is identified once per row per check', () => {
  test('a denied read 6 hops down keys each of its 7 rows once, and again on the next check', async () => {
    const check = createRebacCheck(map);
    const permix = await nobody();
    const record = pool(6)[0] as never;
    const keyed = spyOn(schemaMap, 'identityKeyOfRow');
    try {
      expect(check(permix, schema, { resource: model(6), record }, 'read')).toBe(false);
      expect(keyed).toHaveBeenCalledTimes(7);
      expect(check(permix, schema, { resource: model(6), record }, 'read')).toBe(false);
      expect(keyed).toHaveBeenCalledTimes(14);
    } finally {
      keyed.mockRestore();
    }
  });
});
