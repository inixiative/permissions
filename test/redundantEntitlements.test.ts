import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  coversEntitlement,
  createPermissions,
  type EntitlementEntry,
  withoutRedundantEntitlements,
} from '../index';

const line = (value: string) => ({ field: 'line', operator: Operator.equals, value });
const entry = (actions: string[], overrides: Partial<EntitlementEntry> = {}): EntitlementEntry => ({
  resource: 'db:product',
  anchor: { resource: 'db:distributor', id: 'd', path: 'distributor' },
  actions: Object.fromEntries(actions.map((action) => [action, true])),
  ...overrides,
});

describe('an entitlement is redundant when another is identical aside from holding more actions', () => {
  test('identical, or the same with fewer actions: covered', () => {
    expect(coversEntitlement(entry(['read']), entry(['read']))).toBe(true);
    expect(coversEntitlement(entry(['read', 'order']), entry(['read']))).toBe(true);
    expect(coversEntitlement(entry(['read']), entry(['read', 'order']))).toBe(false);
  });

  test('a false action counts as not held', () => {
    expect(
      coversEntitlement(entry(['read']), {
        ...entry(['read']),
        actions: { read: true, order: false },
      }),
    ).toBe(true);
  });

  test('a different resource, anchor, path or where is never covered', () => {
    const held = entry(['read', 'order'], { where: line('tools') });
    expect(
      coversEntitlement(held, entry(['read'], { resource: 'db:order', where: line('tools') })),
    ).toBe(false);
    expect(
      coversEntitlement(
        held,
        entry(['read'], {
          anchor: { resource: 'db:distributor', id: 'd2', path: 'distributor' },
          where: line('tools'),
        }),
      ),
    ).toBe(false);
    expect(coversEntitlement(held, entry(['read']))).toBe(false);
    expect(coversEntitlement(held, entry(['read'], { where: line('paint') }))).toBe(false);
    expect(coversEntitlement(held, entry(['read'], { where: { all: [line('tools')] } }))).toBe(
      false,
    );
    expect(coversEntitlement(held, entry(['read'], { where: line('tools') }))).toBe(true);
  });

  test('withoutRedundantEntitlements keeps one of each: the first of identical ones, the widest of the rest', () => {
    const a = entry(['read']);
    const b = entry(['read', 'order']);
    const c = entry(['read']);
    const other = entry(['read'], { where: line('tools') });
    expect(withoutRedundantEntitlements([a, b, c, other])).toEqual([b, other]);
    expect(withoutRedundantEntitlements([a, c])).toEqual([a]);
    expect(withoutRedundantEntitlements([])).toEqual([]);
  });
});

describe('setup does not grow on an entitlement it already holds from the same granter', () => {
  test('identical or narrower from the same owner: a no-op; from another owner: kept', async () => {
    const owner = createPermissions();
    const another = createPermissions();
    const holder = createPermissions();
    await holder.setup([entry(['read', 'order'])], { owner });
    await holder.setup([entry(['read', 'order']), entry(['read'])], { owner });
    expect(holder.entitlements('db:product', 'read')).toHaveLength(1);
    await holder.setup([entry(['read'])], { owner: another });
    expect(holder.entitlements('db:product', 'read')).toHaveLength(2);
  });
});
