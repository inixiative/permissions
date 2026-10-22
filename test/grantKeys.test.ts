import { describe, expect, test } from 'bun:test';
import { entitlementEntries, parseGrantKey } from '../index';

describe('grant keys', () => {
  test('a bare key is the whole resource; a third segment is the row', () => {
    expect(parseGrantKey('db:integration')).toEqual({ resource: 'db:integration' });
    expect(parseGrantKey('db:integration:i7')).toEqual({ resource: 'db:integration', id: 'i7' });
  });

  test('a key without a model is refused', () => {
    expect(() => parseGrantKey('integration')).toThrow('"map:model"');
  });

  test('entitlementEntries turns keys into permix entries', () => {
    expect(
      entitlementEntries({
        'db:user:u1': { read: true },
        'db:contact': { read: 'manage' },
      }),
    ).toEqual([
      { resource: 'db:user', id: 'u1', actions: { read: true } },
      { resource: 'db:contact', actions: { read: 'manage' } },
    ]);
    expect(entitlementEntries(null)).toEqual([]);
  });
});
