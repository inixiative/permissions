import { describe, expect, test } from 'bun:test';
import { createHydrator, type ParentRelation, type Row } from '../index';

// Tiny in-memory store + parent map standing in for a Prisma client + prisma-map.
const db: Record<string, Record<string, Row>> = {
  organization: { o1: { id: 'o1', name: 'Org' } },
  space: { s1: { id: 's1', organizationId: 'o1' } },
  membership: { m1: { id: 'm1', spaceId: 's1', userId: 'u1' } },
};

const parentMap: Record<string, ParentRelation[]> = {
  membership: [{ field: 'space', model: 'space', fk: 'spaceId' }],
  space: [{ field: 'organization', model: 'organization', fk: 'organizationId' }],
  organization: [],
};

const makeLoad =
  (sink?: string[]) =>
  async (model: string, id: string): Promise<Row | null> => {
    sink?.push(`${model}:${id}`);
    return db[model]?.[id] ?? null;
  };

describe('createHydrator', () => {
  test('recursively attaches the to-one ownership closure', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ parents: (m) => parentMap[m] ?? [], load: makeLoad(loads) });

    const record = await hydrate('membership', db.membership.m1);

    expect((record.space as Row).id).toBe('s1');
    expect(((record.space as Row).organization as Row).id).toBe('o1');
    expect(loads).toEqual(['space:s1', 'organization:o1']);
  });

  test('a null/absent FK stops the walk — a real deny, not a loading artifact', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ parents: (m) => parentMap[m] ?? [], load: makeLoad(loads) });

    const record = await hydrate('membership', { id: 'm2', spaceId: null, userId: 'u1' });

    expect(record.space).toBeUndefined();
    expect(loads).toEqual([]);
  });

  test('de-duplicates a parent reached twice within one hydration (diamond)', async () => {
    const diamond: Record<string, ParentRelation[]> = {
      doc: [
        { field: 'org', model: 'organization', fk: 'orgId' },
        { field: 'org2', model: 'organization', fk: 'orgId2' },
      ],
      organization: [],
    };
    const loads: string[] = [];
    const hydrate = createHydrator({ parents: (m) => diamond[m] ?? [], load: makeLoad(loads) });

    const rec = await hydrate('doc', { id: 'd1', orgId: 'o1', orgId2: 'o1' });

    expect((rec.org as Row).id).toBe('o1');
    expect((rec.org2 as Row).id).toBe('o1');
    expect(loads).toEqual(['organization:o1']); // fetched once, not twice
  });
});
