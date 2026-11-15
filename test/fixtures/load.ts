import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldMap } from '@inixiative/json-rules';

type Models = FieldMap['models'];
type Annotations = { permissions?: Record<string, unknown> };

/** A slice of the app's Prisma schema as prisma-map emits it, annotations included. */
export const loadModels = (name: 'zealot' | 'kingdom'): Models =>
  JSON.parse(readFileSync(join(import.meta.dir, `${name}.map.json`), 'utf8')) as Models;

/** A copy of `models` with one field's `@permissions(...)` annotation replaced, or removed. */
export const annotate = (
  models: Models,
  model: string,
  field: string,
  permissions?: Record<string, unknown>,
): Models => {
  const copy = structuredClone(models);
  const entry = copy[model]?.fields[field] as { annotations?: Annotations } | undefined;
  if (!entry) throw new Error(`no ${model}.${field}`);
  if (permissions) entry.annotations = { permissions };
  else delete entry.annotations;
  return copy;
};
