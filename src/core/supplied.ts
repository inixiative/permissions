import type { FieldMap } from '@inixiative/field-map';
import {
  type FieldMapSet,
  type Row,
  recordWithBridgeData,
  type SuppliedBridge,
} from '@inixiative/json-rules';
import type { SchemaMap } from './schemaMap';

/** The name the map's own models go by in a rule lens beside the supplied maps (`app:Doc`). */
export const resourcesMapName = 'app';

// why: a rule lens and an embed for the same model are asked on every check; one set per (map, model)
const setsAt = new WeakMap<SchemaMap, Map<string, FieldMapSet>>();

/**
 * The maps a rule at `model` reads beside the map's own: every supplied map, each of its models over
 * a supplied bridge from `model` (`actor:User`), so a `{ rule }` reads `<prefix>:<Model>.<column>`
 * and the call's `data` gives the row.
 */
export const suppliedSetAt = (map: SchemaMap, model: string): FieldMapSet => {
  const byModel = setsAt.get(map) ?? new Map<string, FieldMapSet>();
  setsAt.set(map, byModel);
  const known = byModel.get(model);
  if (known) return known;
  const supplied: Record<string, FieldMap> = map.supplied ?? {};
  if (Object.hasOwn(supplied, resourcesMapName))
    throw new Error(`a supplied map is named \`${resourcesMapName}\`, the map's own: rename it`);
  const bridges: SuppliedBridge[] = Object.entries(supplied).flatMap(([prefix, fieldMap]) =>
    Object.keys(fieldMap.models).map((far) => ({
      endpoints: [
        { fieldMap: resourcesMapName, model },
        { fieldMap: prefix, model: far },
      ],
      cardinality: 'oneToOne' as const,
    })),
  );
  const set: FieldMapSet = { maps: { [resourcesMapName]: map.fieldMap, ...supplied }, bridges };
  byModel.set(model, set);
  return set;
};

/** The endpoint keys a rule at `model` may read across (`actor:User`), each turned on at the root. */
export const suppliedEndpointsAt = (map: SchemaMap, model: string): string[] =>
  (suppliedSetAt(map, model).bridges ?? []).map(
    ({ endpoints: [, far] }) => `${far.fieldMap}:${far.model}`,
  );

/** The record a `{ rule }` at `model` is checked on: its bridges to the supplied maps filled from `data`. */
export const recordWithSuppliedData = (
  map: SchemaMap,
  model: string,
  record: Row,
  data: Record<string, Row[]> | undefined,
): Row =>
  recordWithBridgeData(suppliedSetAt(map, model), `${resourcesMapName}:${model}`, record, data);
