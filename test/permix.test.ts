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

  test('a resource-wide grant applies to a record that HAS an id', async () => {
    const p = createPermissions();
    await p.setup([{ resource: 'document', actions: { read: true } }]);
    // "role X can read all documents" — must hold even when checking a specific document id.
    expect(p.check('document', 'read', 'doc1')).toBe(true);
    expect(p.check('document', 'read')).toBe(true);
    // A grant the resource-wide entry does NOT include is still denied.
    expect(p.check('document', 'delete', 'doc1')).toBe(false);
  });

  test('an id-specific grant still wins and does not leak to other ids', async () => {
    const p = createPermissions();
    await p.setup([
      { resource: 'document', actions: { read: true } },
      { resource: 'document', id: 'doc1', actions: { manage: true } },
    ]);
    expect(p.check('document', 'manage', 'doc1')).toBe(true);
    // manage is id-specific to doc1 — the resource-wide fallback must not grant it on doc2.
    expect(p.check('document', 'manage', 'doc2')).toBe(false);
    // read is resource-wide — applies to any id.
    expect(p.check('document', 'read', 'doc2')).toBe(true);
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

  test('two setup calls for the same key merge actions instead of overwriting', async () => {
    const p = createPermissions();
    await p.setup([{ resource: 'organization', id: 'o1', actions: { read: true } }]);
    await p.setup([{ resource: 'organization', id: 'o1', actions: { manage: true } }]);
    // The second setup must not drop the `read` granted by the first.
    expect(p.check('organization', 'read', 'o1')).toBe(true);
    expect(p.check('organization', 'manage', 'o1')).toBe(true);
  });

  test('actor id round-trips', () => {
    const p = createPermissions();
    expect(p.getUserId()).toBeNull();
    p.setUserId('u1');
    expect(p.getUserId()).toBe('u1');
  });
});
