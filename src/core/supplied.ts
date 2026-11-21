import type { FieldMap } from '@inixiative/field-map';
import {
  endpointKey,
  type FieldMapSet,
  type Row,
  recordWithBridgeData,
  type SuppliedBridge,
} from '@inixiative/json-rules';
import { answerOnce } from './freezeThenJudgeOnce';
import type { SchemaMap } from './schemaMap';

/** The name the map's own models go by in a rule lens beside the supplied maps (`app:Doc`). */
export const resourcesMapName = 'app';

const setsAt = new WeakMap<SchemaMap, Map<string, FieldMapSet>>();

/**
 * The maps a rule at `model` reads beside the map's own: every supplied map, each of its models over
 * a supplied bridge from `model` (`actor:User`), so a `{ rule }` reads `<prefix>:<Model>.<column>`
 * and the call's `data` gives the row. One set per (map, model).
 */
export const suppliedSetAt = (map: SchemaMap, model: string): FieldMapSet =>
  answerOnce(setsAt, map, model, () => {
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
    return { maps: { [resourcesMapName]: map.fieldMap, ...supplied }, bridges };
  });

/** The endpoint keys a rule at `model` may read across (`actor:User`), each turned on at the root. */
export const suppliedEndpointsAt = (map: SchemaMap, model: string): string[] =>
  (suppliedSetAt(map, model).bridges ?? []).map(({ endpoints: [, far] }) => endpointKey(far));

const rootSetsAt = new WeakMap<SchemaMap, Map<string, FieldMapSet>>();

// why: the lens bridges supplied rows at the root only, so the embed fills the root and never copies the rows below it
const suppliedSetAtRoot = (map: SchemaMap, model: string): FieldMapSet =>
  answerOnce(rootSetsAt, map, model, () => {
    const { maps, bridges } = suppliedSetAt(map, model);
    return {
      maps: { ...maps, [resourcesMapName]: { models: { [model]: { fields: {} } } } },
      ...(bridges ? { bridges } : {}),
    };
  });

/** The record a `{ rule }` at `model` is checked on: its bridges to the supplied maps filled from `data`. */
export const recordWithSuppliedData = (
  map: SchemaMap,
  model: string,
  record: Row,
  data: Record<string, Row[]> | undefined,
): Row =>
  recordWithBridgeData(
    suppliedSetAtRoot(map, model),
    endpointKey({ fieldMap: resourcesMapName, model }),
    record,
    data,
  );
