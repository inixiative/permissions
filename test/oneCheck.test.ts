import { describe, expect, spyOn, test } from 'bun:test';
import { map, model, pool, recordAt, schema, table } from '../bench/fixtures';
import { createRebacCheck, type PermissionEntry } from '../index';
import * as schemaMap from '../src/core/schemaMap';
import * as validateActionRule from '../src/core/validateActionRule';
import * as validateSchema from '../src/core/validateSchema';

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

describe("a row's own rules are judged once per row per check", () => {
  test('a root row whose own operate rule the denied read reaches many times is judged once, and again on the next check', async () => {
    const check = createRebacCheck(map);
    const permix = await nobody();
    const record = recordAt(6, 'leaf');
    let root = record;
    while (root.parent) root = root.parent as typeof record;
    root.permissionRules = { operate: 'manage' };
    const judged = spyOn(validateActionRule, 'validateActionRule');
    const lens = spyOn(validateSchema, 'issuesForRuleReadsOutsideLens');
    try {
      expect(check(permix, schema, { resource: model(6), record }, 'read')).toBe(false);
      expect(judged).toHaveBeenCalledTimes(1);
      expect(lens).toHaveBeenCalledTimes(1);
      expect(check(permix, schema, { resource: model(6), record }, 'read')).toBe(false);
      expect(judged).toHaveBeenCalledTimes(2);
      expect(lens).toHaveBeenCalledTimes(2);
    } finally {
      judged.mockRestore();
      lens.mockRestore();
    }
  });
});
