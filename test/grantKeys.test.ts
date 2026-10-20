import { describe, expect, test } from 'bun:test';
import {
  entitlementEntries,
  interpolateSelf,
  parseGrantKey,
  SELF,
  selfPlaceholders,
} from '../index';

const resources = ['db:integration', 'db:integrationRecord', 'db:user', 'db'];

describe('parseGrantKey', () => {
  test('a bare key is the whole resource; an id key is that row', () => {
    expect(parseGrantKey('db:integration', resources)).toEqual({ resource: 'db:integration' });
    expect(parseGrantKey('db:integration:i1', resources)).toEqual({
      resource: 'db:integration',
      id: 'i1',
    });
  });

  test('the longest resource prefix wins', () => {
    expect(parseGrantKey('db:integrationRecord:r1', resources)).toEqual({
      resource: 'db:integrationRecord',
      id: 'r1',
    });
  });

  test('an unknown key is null', () => {
    expect(parseGrantKey('crm:account', resources)).toBeNull();
    expect(parseGrantKey('db:integration:', resources)).toBeNull();
  });
});

describe('interpolateSelf', () => {
  test('a placeholder becomes the literal id of the grant subject', () => {
    expect(
      interpolateSelf(
        { [`db:integration:${SELF}`]: { 'integration.manage': true }, 'db:user': { read: true } },
        { 'db:integration': 'i1' },
      ),
    ).toEqual({
      ok: true,
      value: { 'db:integration:i1': { 'integration.manage': true }, 'db:user': { read: true } },
    });
  });

  test('two keys landing on one row merge', () => {
    expect(
      interpolateSelf<Record<string, boolean>>(
        { 'db:integration:i1': { read: true }, [`db:integration:${SELF}`]: { manage: true } },
        { 'db:integration': 'i1' },
      ),
    ).toEqual({ ok: true, value: { 'db:integration:i1': { read: true, manage: true } } });
  });

  test('an unresolvable placeholder refuses the whole grant', () => {
    expect(
      interpolateSelf({ [`db:integration:${SELF}`]: { read: true } }, { 'db:integration': null }),
    ).toEqual({ ok: false, unresolved: [`db:integration:${SELF}`] });
  });

  test('null passes through', () => {
    expect(interpolateSelf(null, {})).toEqual({ ok: true, value: null });
  });

  test('selfPlaceholders lists only present subjects', () => {
    expect(
      selfPlaceholders({ 'db:integration': 'i1', 'db:user': null, 'db:organization': '' }),
    ).toEqual([`db:integration:${SELF}`]);
  });
});

describe('entitlementEntries', () => {
  test('keys become resource-wide or id-keyed permix entries', () => {
    expect(
      entitlementEntries(
        { 'db:integration': { read: true }, 'db:integration:i1': { manage: 'read' } },
        resources,
      ),
    ).toEqual([
      { resource: 'db:integration', actions: { read: true } },
      { resource: 'db:integration', id: 'i1', actions: { manage: 'read' } },
    ]);
  });

  test('an unknown or uninterpolated key throws', () => {
    expect(() => entitlementEntries({ 'crm:x': { read: true } }, resources)).toThrow(
      'Unknown grant key',
    );
    expect(() =>
      entitlementEntries({ [`db:integration:${SELF}`]: { read: true } }, resources),
    ).toThrow('Uninterpolated');
  });
});
