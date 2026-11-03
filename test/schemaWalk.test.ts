import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import {
  createHydrator,
  type RebacSchema,
  type Row,
  validateSchema,
  walkedRelations,
} from '../index';
import { mapOf } from './schemaMaps';

const map = mapOf({
  document: { organization: 'organization', author: 'user', folder: 'folder' },
  folder: { organization: 'organization', archive: 'archive' },
  organization: { billing: 'billing' },
});

const schema: RebacSchema = {
  permissions: {
    organization: { actions: { manage: null, read: 'manage' } },
    folder: { actions: { read: { rel: 'organization', action: 'read' } } },
    document: {
      actions: {
        read: {
          any: [
            { rel: 'folder', action: 'read' },
            { rule: { field: 'author.name', operator: Operator.equals, value: 'Ada' } },
          ],
        },
        manage: { rel: 'organization', action: 'manage' },
      },
    },
  },
};

const store: Record<string, Row[]> = {
  organization: [{ id: 'o1', billingId: 'b1' }],
  billing: [{ id: 'b1' }],
  user: [{ id: 'u1', name: 'Ada' }],
  folder: [{ id: 'f1', organizationId: 'o1', archiveId: 'a1' }],
  archive: [{ id: 'a1' }],
};

const loaderOver = (loads: string[]) => async (resource: string, where: Row) => {
  loads.push(resource);
  return store[resource]?.find((row) => row.id === where.id) ?? null;
};

const document = { id: 'd1', organizationId: 'o1', authorId: 'u1', folderId: 'f1' };

describe('walkedRelations', () => {
  test('rel paths and the relations a rule reads a field through, by resource', () => {
    const walked = walkedRelations(map, schema);
    expect([...(walked.get('document') ?? [])].sort()).toEqual([
      'author',
      'folder',
      'organization',
    ]);
    expect([...(walked.get('folder') ?? [])]).toEqual(['organization']);
    expect(walked.get('organization')).toBeUndefined();
  });
});

describe('createHydrator with a schema', () => {
  test('loads only what the rules walk', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(loads), schema });
    const record = await hydrate('document', document);
    expect(loads.sort()).toEqual(['folder', 'organization', 'user']);
    expect((record.folder as Row).archive).toBeUndefined();
    expect((record.organization as Row).billing).toBeUndefined();
    expect((record.author as Row).name).toBe('Ada');
  });

  test('without a schema it loads every to-one relation, as before', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(loads) });
    await hydrate('document', document);
    expect(loads).toContain('archive');
    expect(loads).toContain('billing');
  });

  test('a record’s own permissionRules add the relations they walk', async () => {
    const loads: string[] = [];
    const hydrate = createHydrator({ map, load: loaderOver(loads), schema });
    const record = await hydrate('folder', {
      id: 'f1',
      organizationId: 'o1',
      archiveId: 'a1',
      permissionRules: { read: { rel: 'organization.billing', action: 'read' } },
    });
    expect(((record.organization as Row).billing as Row).id).toBe('b1');
    expect(record.archive).toBeUndefined();
  });
});

describe('validateSchema', () => {
  test('a schema whose rels resolve and whose actions exist is valid', () => {
    expect(validateSchema(map, schema)).toEqual({ ok: true, errors: [] });
  });

  test('names a relation the map does not have', () => {
    const bad: RebacSchema = {
      permissions: { document: { actions: { read: { rel: 'orgnization', action: 'read' } } } },
    };
    expect(validateSchema(map, bad).errors).toEqual([
      {
        path: 'document.read',
        code: 'relation',
        message: '`document` has no relation `orgnization`',
      },
    ]);
  });

  test('names an action missing where the walk lands, or a delegation to a missing action', () => {
    const bad: RebacSchema = {
      permissions: {
        organization: { actions: { manage: null } },
        document: { actions: { read: { rel: 'organization', action: 'view' }, edit: 'write' } },
      },
    };
    expect(validateSchema(map, bad).errors.map((issue) => issue.message)).toEqual([
      '`organization` has no action `view`',
      '`document` has no action `write`',
    ]);
  });

  test('carries validateActionRule’s refusals, e.g. a negated rule', () => {
    const bad: RebacSchema = {
      permissions: {
        document: {
          actions: { read: { rule: { field: 'state', operator: Operator.notEquals, value: 'x' } } },
        },
      },
    };
    expect(validateSchema(map, bad).ok).toBe(false);
  });
});
