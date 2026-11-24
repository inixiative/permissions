import { describe, expect, spyOn, test } from 'bun:test';
import { model, nobody, pool, schema, schemaMap } from '../bench/fixtures';
import { createPermissions } from '../index';
import * as rowKeys from '../src/core/rowKeys';
import * as ruleReads from '../src/core/ruleReads';
import * as validateActionRule from '../src/core/validateActionRule';
import { checkWithRules, mapOf, pathsWithRules, type Rules } from './schemaMaps';

// One check remembers what it computed (src/core/evaluate.ts, `WhatOneCheckRemembers`); nothing
// it remembers outlives the check.

describe('a row is identified once per row per check', () => {
  test('a denied read 6 hops down keys each of its 7 rows once, and again on the next check', async () => {
    const check = checkWithRules(schemaMap);
    const permix = await nobody();
    const record = pool(6)[0] as never;
    const keyed = spyOn(rowKeys, 'identityKeyOfRow');
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
  // Three owners each walk the start row (no hop, so no node memo): only the row-rule cache keeps
  // their walks from judging its rule again.
  const rowRuleCalls = async () => {
    const spaceMap = mapOf({ 'db:space': { organization: 'db:organization' } });
    const spaceSchema: Rules = {
      permissions: {
        'db:organization': { actions: { own: null } },
        'db:space': { actions: { view: null, read: null } },
      },
    };
    const anchor = { resource: 'db:space', id: 's1' };
    const owners = [createPermissions(), createPermissions(), createPermissions()];
    const holder = createPermissions();
    for (const [i, owner] of owners.entries())
      await holder.setup(
        [{ resource: 'db:space', anchor, actions: { read: true }, ref: `e${i}` }],
        {
          owner,
        },
      );
    const record = { id: 's1', organizationId: 'o1', permissionRules: { read: 'view' } };
    const judged = spyOn(validateActionRule, 'validateActionRule');
    const lens = spyOn(ruleReads, 'issuesForRuleReadsOutsideLens');
    try {
      expect(
        pathsWithRules(spaceMap)(holder, spaceSchema, { resource: 'db:space', record }, 'read'),
      ).toEqual([]);
      return [judged.mock.calls.length, lens.mock.calls.length];
    } finally {
      judged.mockRestore();
      lens.mockRestore();
    }
  };

  test('three entitlement owners walking one row judge its own read rule once among them', async () => {
    // validateActionRule: once for the row's rule, six for the schema's three rules on its first use
    expect(await rowRuleCalls()).toEqual([7, 1]);
  });
});
