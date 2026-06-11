import { describe, expect, test } from 'bun:test';
import { createPermissions } from '../index';

describe('createPermissions (permix wrapper)', () => {
  test('grants checked by resource:id', async () => {
    const p = createPermissions();
    await p.setup([{ resource: 'organization', id: 'o1', actions: { own: true, read: true } }]);
    expect(p.check('organization', 'own', 'o1')).toBe(true);
    expect(p.check('organization', 'own', 'o2')).toBe(false);
    expect(p.check('organization', 'read', 'o1')).toBe(true);
  });

  test('resource-level grant (no id)', async () => {
    const p = createPermissions();
    await p.setup([{ resource: 'user', actions: { read: true } }]);
    expect(p.check('user', 'read')).toBe(true);
  });

  test('superadmin bypass returns true for anything', async () => {
    const p = createPermissions();
    p.setSuperadmin(true);
    expect(p.isSuperadmin()).toBe(true);
    expect(p.check('anything', 'own', 'x')).toBe(true);
  });

  test('setup accumulates; replace clears', async () => {
    const p = createPermissions();
    await p.setup([{ resource: 'organization', id: 'o1', actions: { own: true } }]);
    await p.setup([{ resource: 'space', id: 's1', actions: { read: true } }]);
    expect(p.check('organization', 'own', 'o1')).toBe(true);
    expect(p.check('space', 'read', 's1')).toBe(true);

    await p.setup([{ resource: 'space', id: 's2', actions: { read: true } }], { replace: true });
    expect(p.check('organization', 'own', 'o1')).toBe(false);
    expect(p.check('space', 'read', 's2')).toBe(true);
  });

  test('actor id round-trips', () => {
    const p = createPermissions();
    expect(p.getUserId()).toBeNull();
    p.setUserId('u1');
    expect(p.getUserId()).toBe('u1');
  });
});
