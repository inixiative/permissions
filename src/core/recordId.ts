import { engineGlobals, registerEngineGlobals } from '@inixiative/json-rules';
import type { Row } from './types';

registerEngineGlobals('permissions', { idField: 'id' });

/** The engine's id field, `permissions.idField` in `engineGlobals`. */
export const idField = (): string => engineGlobals.get('permissions.idField');

// permix keys grants by string id; coerce so a numeric id matches (the bridge path already does
// `String(farId)` — keep the direct path consistent). A record without the field has no id.
export const recordId = (record: Row, field = idField()): string | undefined => {
  const value = record[field];
  return hasNoValue(value) ? undefined : String(value);
};

/** Whether a column holds nothing a key can use: null, undefined or the empty string. */
export const hasNoValue = (value: unknown): boolean => value == null || value === '';
