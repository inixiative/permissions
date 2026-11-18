import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AnnoValue, type FieldMap, fieldOf, modelOf } from '@inixiative/field-map';

type Models = FieldMap['models'];

/** A slice of the app's Prisma schema as field-map emits it, annotations included. */
export const loadModels = (name: 'zealot' | 'kingdom'): Models =>
  JSON.parse(readFileSync(join(import.meta.dir, `${name}.map.json`), 'utf8')) as Models;

/** `models` with one field's `@permissions(...)` annotation replaced, or removed. */
export const annotate = (
  models: Models,
  model: string,
  field: string,
  permissions?: { readonly [key: string]: AnnoValue },
): Models => {
  const entry = fieldOf({ models }, model, field);
  if (!entry) throw new Error(`no ${model}.${field}`);
  const { annotations: _annotations, ...rest } = entry;
  const annotated = permissions ? { ...rest, annotations: { permissions } } : rest;
  const at = modelOf({ models }, model);
  return { ...models, [model]: { ...at, fields: { ...at?.fields, [field]: annotated } } };
};
