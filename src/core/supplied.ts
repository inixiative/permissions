import { fieldOf, own } from '@inixiative/field-map';
import {
  type BridgeDictionary,
  endpointKey,
  type FieldMapSet,
  isJoinedBridge,
  parseEndpointKey,
  type Row,
  recordWithBridgeData,
  relationTargetOf,
  type SuppliedBridge,
  stitchFieldMaps,
} from '@inixiative/json-rules';
import { answerOnce } from './freezeThenJudgeOnce';
import type { SchemaMap } from './schemaMap';

/** The name the map's own models go by in a rule lens beside the supplied maps (`app:Doc`). */
export const resourcesMapName = 'app';

const stitchedSets = new WeakMap<SchemaMap, Map<'', FieldMapSet>>();

// why: stitched alone, a supplied bridge naming the map of resources has no endpoint and throws, so no chain leads back into it
/** The supplied maps and their bridges, stitched. */
export const stitchedSuppliedSet = (map: SchemaMap): FieldMapSet =>
  answerOnce(stitchedSets, map, '', () => {
    const supplied: FieldMapSet = map.supplied ?? { maps: {} };
    if (Object.hasOwn(supplied.maps, resourcesMapName))
      throw new Error(`a supplied map is named \`${resourcesMapName}\`, the map's own: rename it`);
    return stitchFieldMaps(supplied);
  });

/** The supplied model a key names (`actor:User`), or undefined when no supplied map has it. */
export const suppliedModelAt = (map: SchemaMap, key: string) => {
  if (!key.includes(':')) return undefined;
  const { mapName, modelName } = parseEndpointKey(key, '');
  const fieldMap = own(stitchedSuppliedSet(map).maps, mapName);
  const model = fieldMap ? own(fieldMap.models, modelName) : undefined;
  return fieldMap && model ? { fieldMap, mapName, modelName, model } : undefined;
};

/** The relations and to-one bridges a supplied model's row leads on through, by field: lists are crossed with the list arm. */
export const followedToOnesOfSupplied = (
  map: SchemaMap,
  key: string,
): [string, { resource: string }][] => {
  const at = suppliedModelAt(map, key);
  if (!at) return [];
  return Object.entries(at.model.fields).flatMap(([name, entry]) => {
    const target = 'isList' in entry && entry.isList ? null : relationTargetOf(entry, at.mapName);
    return target
      ? [[name, { resource: endpointKey({ fieldMap: target.mapName, model: target.modelName }) }]]
      : [];
  });
};

/** The supplied model a list field of a supplied row holds (`actor:User` `devices` → `actor:Device`), or undefined. */
export const suppliedListAt = (map: SchemaMap, key: string, field: string): string | undefined => {
  const at = suppliedModelAt(map, key);
  const entry = at ? fieldOf(at.fieldMap, at.modelName, field) : undefined;
  const target =
    at && entry && 'isList' in entry && entry.isList ? relationTargetOf(entry, at.mapName) : null;
  return target ? endpointKey({ fieldMap: target.mapName, model: target.modelName }) : undefined;
};

/** The supplied models the call gives one row of, which every rule reads from its row: all but the far end of a joined bridge, whose rows are found by key. */
export const suppliedModelsAtRoot = (map: SchemaMap): string[] => {
  const { maps, bridges = [] } = stitchedSuppliedSet(map);
  const found = new Set(
    bridges.filter(isJoinedBridge).map(({ endpoints: [, far] }) => endpointKey(far)),
  );
  return Object.entries(maps)
    .flatMap(([fieldMap, { models }]) =>
      Object.keys(models).map((model) => endpointKey({ fieldMap, model })),
    )
    .filter((key) => !found.has(key));
};

const rootBridges = (map: SchemaMap, model: string): SuppliedBridge[] =>
  suppliedModelsAtRoot(map).map((key) => {
    const { mapName, modelName } = parseEndpointKey(key, '');
    return {
      endpoints: [
        { fieldMap: resourcesMapName, model },
        { fieldMap: mapName, model: modelName },
      ],
      cardinality: 'oneToOne',
    };
  });

const setsAt = new WeakMap<SchemaMap, Map<string, FieldMapSet>>();

/** The maps a rule at `model` reads beside the map's own: the supplied set, and a bridge from `model` to every supplied model at the root. */
export const suppliedSetAt = (map: SchemaMap, model: string): FieldMapSet =>
  answerOnce(setsAt, map, model, () => {
    const supplied = map.supplied ?? { maps: {} };
    stitchedSuppliedSet(map);
    return {
      maps: { [resourcesMapName]: map.fieldMap, ...supplied.maps },
      bridges: [...(supplied.bridges ?? []), ...rootBridges(map, model)],
    };
  });

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

/** The supplied maps' joined bridges, whose rows a check indexes once with the schema's. */
export const joinedBridgesOfSupplied = (map: SchemaMap) =>
  (map.supplied?.bridges ?? []).filter(isJoinedBridge);

/** The record a `{ rule }` at `model` is checked on: its bridges to the supplied maps filled from `data`, and theirs in turn. */
export const recordWithSuppliedData = (
  map: SchemaMap,
  model: string,
  record: Row,
  data: Record<string, Row[]> | undefined,
  dictionary: BridgeDictionary | undefined,
): Row =>
  recordWithBridgeData(
    suppliedSetAtRoot(map, model),
    endpointKey({ fieldMap: resourcesMapName, model }),
    record,
    data,
    dictionary,
  );
