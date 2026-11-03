import { engineGlobals, registerEngineGlobals } from '@inixiative/json-rules';
import type { Row } from './types';

declare module '@inixiative/json-rules' {
  interface EngineGlobalValues {
    /** The field a record's grants are keyed by: `id` unless the app sets another (`uuid`, `_id`). */
    'permissions.idField': string;
  }
}

registerEngineGlobals('permissions', { idField: 'id' });

/** The engine's id field, `permissions.idField` in `engineGlobals`. */
export const idField = (): string => engineGlobals.get('permissions.idField');

// permix keys grants by string id; coerce so a numeric id matches (the bridge path already does
// `String(farId)` — keep the direct path consistent). A record without the field has no id.
export const recordId = (record: Row): string | undefined => {
  const value = record[idField()];
  return value == null ? undefined : String(value);
};
