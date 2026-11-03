import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { type RebacSchema, validateSchema } from '../index';
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
