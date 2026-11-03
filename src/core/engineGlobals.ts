import type { EngineGlobalValues } from '@inixiative/json-rules';

declare module '@inixiative/json-rules' {
  interface EngineGlobalValues {
    /** The field a record's grants are keyed by: `id` unless the app sets another (`uuid`, `_id`). */
    'permissions.idField': string;
  }
}

/**
 * The engine settings this package registers, under the `permissions.` namespace in `engineGlobals`.
 * Exported so the d.ts bundle keeps the augmentation above: a consumer's
 * `engineGlobals.set('permissions.idField', 'uuid')` typechecks without redeclaring it.
 */
export type PermissionsEngineGlobals = Pick<EngineGlobalValues, 'permissions.idField'>;
