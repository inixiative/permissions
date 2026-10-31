import { describe, expect, test } from 'bun:test';
import { type EntitlementEntry, wellFormedEntitlements } from '../index';

const manageS1: EntitlementEntry = {
  resource: 'db:space',
  anchor: { resource: 'db:space', id: 's1' },
  actions: { manage: true },
};

describe('wellFormedEntitlements: the stored entries a table can install', () => {
  test('anything but an array is none', () => {
    for (const value of [null, undefined, {}, 'x', 1, manageS1])
      expect(wellFormedEntitlements(value)).toEqual([]);
  });

  test('keeps well-formed entries, drops what entitlementProblem names and non-objects', () => {
    const value = [
      manageS1,
      null,
      'x',
      [manageS1],
      { ...manageS1, actions: {} },
      { ...manageS1, anchor: { resource: 'db:space', id: 's1', path: 'organization' } },
      { ...manageS1, where: null },
    ];
    expect(wellFormedEntitlements(value)).toEqual([manageS1]);
  });

  test('drops the redundant: a duplicate, and one another covers', () => {
    const wider = { ...manageS1, actions: { manage: true, own: true } };
    expect(wellFormedEntitlements([manageS1, wider, { ...manageS1 }])).toEqual([wider]);
  });
});
