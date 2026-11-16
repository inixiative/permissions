import { describe, expect, test } from 'bun:test';
import {
  createCanGrantEntitlement,
  createPermissions,
  createRebacCheck,
  createRebacPaths,
  type PermissionEntry,
  type RebacSchema,
} from '../index';
import { mapOf } from './schemaMaps';

// `visited` holds only the nodes on the current path: a node leaves it when its walk returns, so a
// node a finished sibling walked is walked again by an owner that reaches it.

const map = mapOf({ 'db:space': { organization: 'db:organization' } });
const schema: RebacSchema = {
  permissions: {
    'db:organization': { actions: { own: null } },
    'db:space': {
      actions: { view: null, read: 'view' },
    },
  },
};
const s1 = { id: 's1', organizationId: 'o1', organization: { id: 'o1' } };
const atS1 = { resource: 'db:space', id: 's1' };

// H views s1 and holds read on s1 from O; O holds view on s1 from H. The schema branch of H's read
// walks H's view and finishes; the entitlement branch then walks O, whose view comes back to H's view.
const holderAndOwner = async () => {
  const holder = createPermissions();
  const owner = createPermissions();
  await holder.setup([
    { resource: 'db:space', id: 's1', actions: { view: true } } as PermissionEntry,
  ]);
  await holder.setup(
    [{ resource: 'db:space', anchor: atS1, actions: { read: true }, ref: 'fromO' }],
    { owner },
  );
  await owner.setup(
    [{ resource: 'db:space', anchor: atS1, actions: { view: true }, ref: 'fromH' }],
    { owner: holder },
  );
  return holder;
};

describe('`visited` holds only the nodes on the current path', () => {
  test('paths reports the admission through a node a finished sibling walked', async () => {
    const holder = await holderAndOwner();
    const paths = createRebacPaths(map)(
      holder,
      schema,
      { resource: 'db:space', record: s1 },
      'read',
    );
    expect(paths.map((admission) => admission.map((chain) => chain.join('>')))).toEqual([
      [],
      ['fromO>fromH'],
    ]);
  });

  test('check and the grant check admit on the same case', async () => {
    const holder = await holderAndOwner();
    const subject = { resource: 'db:space', record: s1 };
    expect(createRebacCheck(map)(holder, schema, subject, 'read')).toBe(true);
    expect(
      createCanGrantEntitlement(map)(
        holder,
        schema,
        { resource: 'db:space', anchor: atS1, actions: { read: true } },
        s1,
      ),
    ).toBe(true);
  });
});
