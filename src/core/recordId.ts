import { engineGlobals, registerEngineGlobals } from '@inixiative/json-rules';
import type { Row } from './types';

registerEngineGlobals('permissions', { idField: 'id' });

/** The engine's id field, `permissions.idField` in `engineGlobals`. */
export const idField = (): string => engineGlobals.get('permissions.idField');

/** The row's id as permix keys grants: a string, or undefined when the field has no value. */
export const recordId = (record: Row, field = idField()): string | undefined => {
  const value = record[field];
  return hasNoValue(value) ? undefined : String(value);
};

/** Whether a column holds nothing a key can use: null, undefined or the empty string. */
export const hasNoValue = (value: unknown): boolean => value == null || value === '';
