import { describe, expect, test } from 'bun:test';
import { BindError, createInterpolator } from '../index';

const inquiryGrant = createInterpolator(['source', 'target', 'content']);
const roots = {
  source: { id: 'i7', provider: 'slack', organizationId: 'o1' },
  target: { id: 'u1' },
  content: { purpose: 'sync' },
};

describe('createInterpolator', () => {
  test('binds $root keys to the root id and leaves self alone', () => {
    expect(
      inquiryGrant(
        {
          'db:integration:$source': { manage: true },
          'db:user:$target': { read: true },
          'db:user:self': { read: true },
        },
        roots,
      ),
    ).toEqual({
      'db:integration:i7': { manage: true },
      'db:user:u1': { read: true },
      'db:user:self': { read: true },
    });
  });

  test('binds rule values from a root path', () => {
    expect(
      inquiryGrant(
        {
          'db:integration': {
            read: {
              rule: {
                all: [
                  { field: 'provider', operator: 'equals', value: { bind: 'source.provider' } },
                  {
                    field: 'organizationId',
                    operator: 'equals',
                    value: { bind: 'source.organizationId' },
                  },
                ],
              },
            },
          },
        },
        roots,
      ),
    ).toEqual({
      'db:integration': {
        read: {
          rule: {
            all: [
              { field: 'provider', operator: 'equals', value: 'slack' },
              { field: 'organizationId', operator: 'equals', value: 'o1' },
            ],
          },
        },
      },
    });
  });

  test('refuses a literal id, a dotted id path, a literal key id and an unregistered root', () => {
    expect(() => inquiryGrant({ 'db:integration:i9': { read: true } }, roots)).toThrow(BindError);
    expect(() =>
      inquiryGrant(
        {
          'db:integration': {
            read: { rule: { field: 'organizationId', operator: 'equals', value: 'o2' } },
          },
        },
        roots,
      ),
    ).toThrow('bound, never written');
    expect(() =>
      inquiryGrant(
        {
          'db:integration': {
            read: { rule: { field: 'organization.id', operator: 'equals', value: 'o2' } },
          },
        },
        roots,
      ),
    ).toThrow('bound, never written');
    expect(() => inquiryGrant({ 'db:integration:$self2': { read: true } }, roots)).toThrow(
      'not a root',
    );
    expect(() =>
      createInterpolator([])(
        {
          'db:integration': {
            read: {
              rule: { field: 'provider', operator: 'equals', value: { bind: 'source.provider' } },
            },
          },
        },
        roots,
      ),
    ).toThrow('not a root');
  });

  test('null stays null', () => {
    expect(inquiryGrant(null, roots)).toBeNull();
  });
});
