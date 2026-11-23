import { describe, expect, test } from 'bun:test';
import { Operator } from '@inixiative/json-rules';
import { validateSchema } from '../index';
import { mapOf, mapWith, type Rules } from './schemaMaps';

const map = mapOf(
  {
    'db:document': { organization: 'db:organization', author: 'db:user', folder: 'db:folder' },
    'db:folder': { organization: 'db:organization', archive: 'db:archive' },
    'db:organization': { billing: 'db:billing' },
  },
  { 'db:user': ['name'] },
);

const schema: Rules = {
  permissions: {
    'db:organization': { actions: { manage: null, read: 'manage' } },
    'db:folder': { actions: { read: { rel: 'organization', action: 'read' } } },
    'db:document': {
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
    expect(validateSchema(mapWith(map, schema))).toEqual({ ok: true, errors: [], warnings: [] });
  });

  test('names a relation the map does not have', () => {
    const bad: Rules = {
      permissions: { 'db:document': { actions: { read: { rel: 'orgnization', action: 'read' } } } },
    };
    expect(validateSchema(mapWith(map, bad)).errors).toEqual([
      {
        path: 'db:document.read',
        code: 'relation',
        message: '`db:document` has no relation `orgnization`',
      },
    ]);
  });

  test('names an action missing where the walk lands, or a delegation to a missing action', () => {
    const bad: Rules = {
      permissions: {
        'db:organization': { actions: { manage: null } },
        'db:document': {
          actions: { read: { rel: 'organization', action: 'view' }, edit: 'write' },
        },
      },
    };
    expect(validateSchema(mapWith(map, bad)).errors.map((issue) => issue.message)).toEqual([
      '`db:organization` has no action `view`',
      '`db:document` has no action `write`',
    ]);
  });

  test('carries validateActionRule’s refusals, e.g. a negated rule', () => {
    const bad: Rules = {
      permissions: {
        document: {
          actions: { read: { rule: { field: 'state', operator: Operator.notEquals, value: 'x' } } },
        },
      },
    };
    expect(validateSchema(mapWith(map, bad)).ok).toBe(false);
  });
});
