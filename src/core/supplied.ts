import { fieldOf, own } from '@inixiative/field-map';
import {
  type Bridge,
  type BridgeDictionary,
  endpointKey,
  type FieldMapSet,
  isJoinedBridge,
  type JoinedBridge,
  parseEndpointKey,
  type Row,
  recordWithBridgeData,
  relationTargetOf,
  type SuppliedBridge,
  stitchFieldMaps,
} from '@inixiative/json-rules';
import { answerOnce } from './freezeThenJudgeOnce';
import {
  fieldMapOfResource,
  isSuppliedMap,
  mapAndModelNamed,
  modelsNamedIn,
} from './resourceNames';
import type { SchemaMap } from './schemaMap';

const isSuppliedEnd = (map: SchemaMap, end: { fieldMap: string }) =>
  isSuppliedMap(map, end.fieldMap);

/** The bridges between two supplied maps, which a `{ rule }` reads along from a supplied row. */
export const bridgesBetweenSuppliedMaps = (map: SchemaMap): Bridge[] =>
  (map.bridges ?? []).filter((bridge) => bridge.endpoints.every((end) => isSuppliedEnd(map, end)));

/** The joined bridges with no end supplied, which a `rel` walk crosses from a record. */
export const bridgesWalkedFromRecords = (map: SchemaMap): JoinedBridge[] =>
  (map.bridges ?? []).filter(
    (bridge): bridge is JoinedBridge =>
      isJoinedBridge(bridge) && !bridge.endpoints.some((end) => isSuppliedEnd(map, end)),
  );

const stitchedSets = new WeakMap<SchemaMap, Map<'', FieldMapSet>>();

// why: stitched alone, the supplied maps hold no model of the records, so no chain leads back into them
/** The supplied maps and the bridges between them, stitched. */
export const stitchedSuppliedSet = (map: SchemaMap): FieldMapSet =>
  answerOnce(stitchedSets, map, '', () =>
    stitchFieldMaps({ maps: map.supplied ?? {}, bridges: bridgesBetweenSuppliedMaps(map) }),
  );

/** The supplied model a key names (`actor:User`), or undefined when no supplied map has it. */
export const suppliedModelAt = (map: SchemaMap, key: string) => {
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
  return modelsNamedIn(maps).filter((key) => !found.has(key));
};

const rootBridges = (map: SchemaMap, resource: string): SuppliedBridge[] => {
  const { mapName: fieldMap, modelName: model } = mapAndModelNamed(resource);
  return suppliedModelsAtRoot(map).map((key) => {
    const { mapName, modelName } = parseEndpointKey(key, '');
    return {
      endpoints: [
        { fieldMap, model },
        { fieldMap: mapName, model: modelName },
      ],
      cardinality: 'oneToOne',
    };
  });
};

const setsAt = new WeakMap<SchemaMap, Map<string, FieldMapSet>>();

/** The maps a rule at `resource` reads: its own, the supplied ones with their bridges, and a bridge from it to every supplied model at the root. */
export const suppliedSetAt = (map: SchemaMap, resource: string): FieldMapSet =>
  answerOnce(setsAt, map, resource, () => {
    stitchedSuppliedSet(map);
    const fieldMap = fieldMapOfResource(map, resource);
    return {
      maps: {
        ...(fieldMap ? { [mapAndModelNamed(resource).mapName]: fieldMap } : {}),
        ...(map.supplied ?? {}),
      },
      bridges: [...bridgesBetweenSuppliedMaps(map), ...rootBridges(map, resource)],
    };
  });

const rootSetsAt = new WeakMap<SchemaMap, Map<string, FieldMapSet>>();

// why: the lens bridges supplied rows at the root only, so the embed fills the root and never copies the rows below it
const suppliedSetAtRoot = (map: SchemaMap, resource: string): FieldMapSet =>
  answerOnce(rootSetsAt, map, resource, () => {
    const { maps, bridges } = suppliedSetAt(map, resource);
    const { mapName, modelName } = mapAndModelNamed(resource);
    return {
      maps: { ...maps, [mapName]: { models: { [modelName]: { fields: {} } } } },
      ...(bridges ? { bridges } : {}),
    };
  });

/** The joined bridges between supplied maps, whose rows a check indexes once. */
export const joinedBridgesOfSupplied = (map: SchemaMap) =>
  bridgesBetweenSuppliedMaps(map).filter(isJoinedBridge);

/** The record a `{ rule }` at `resource` is checked on: its bridges to the supplied maps filled from `data`, and theirs in turn. */
export const recordWithSuppliedData = (
  map: SchemaMap,
  resource: string,
  record: Row,
  data: Record<string, Row[]> | undefined,
  dictionary: BridgeDictionary | undefined,
): Row =>
  recordWithBridgeData(suppliedSetAtRoot(map, resource), resource, record, data, dictionary);
