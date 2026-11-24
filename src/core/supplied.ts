import { fieldOf, own } from '@inixiative/field-map';
import {
  type BridgeDictionary,
  endpointKey,
  type FieldMapSet,
  type JoinedBridge,
  parseEndpointKey,
  type Row,
  recordWithBridgeData,
  relationTargetOf,
  type SuppliedBridge,
  stitchFieldMaps,
} from '@inixiative/json-rules';
import { answerOnce } from './freezeThenJudgeOnce';
import { fieldMapOfResource, isSuppliedMap, mapAndModelNamed } from './resourceNames';
import type { ResolvedSchemaMap } from './schemaMap';

/** The joined bridges between two supplied maps, which a `{ rule }` reads along from a supplied row and a check indexes once. */
export const bridgesBetweenSuppliedMaps = (schemaMap: ResolvedSchemaMap): JoinedBridge[] =>
  schemaMap.bridges.filter((bridge) =>
    bridge.endpoints.every((end) => isSuppliedMap(schemaMap, end.fieldMap)),
  );

/** The joined bridges with no end supplied, which a `rel` walk crosses from a record. */
export const bridgesWalkedFromRecords = (schemaMap: ResolvedSchemaMap): JoinedBridge[] =>
  schemaMap.bridges.filter(
    (bridge) => !bridge.endpoints.some((end) => isSuppliedMap(schemaMap, end.fieldMap)),
  );

const stitchedSets = new WeakMap<ResolvedSchemaMap, Map<'', FieldMapSet>>();

// why: stitched alone, the supplied maps hold no model of the records, so no chain leads back into them
/** The supplied maps and the bridges between them, stitched. */
export const stitchedSuppliedSet = (schemaMap: ResolvedSchemaMap): FieldMapSet =>
  answerOnce(stitchedSets, schemaMap, '', () =>
    stitchFieldMaps({
      maps: schemaMap.suppliedFieldMaps ?? {},
      bridges: bridgesBetweenSuppliedMaps(schemaMap),
    }),
  );

/** The supplied model a key names (`actor:User`), or undefined when no supplied map has it. */
export const suppliedModelAt = (schemaMap: ResolvedSchemaMap, key: string) => {
  const { mapName, modelName } = parseEndpointKey(key, '');
  const fieldMap = own(stitchedSuppliedSet(schemaMap).maps, mapName);
  const model = fieldMap ? own(fieldMap.models, modelName) : undefined;
  return fieldMap && model ? { fieldMap, mapName, modelName, model } : undefined;
};

/** The relations and to-one bridges a supplied model's row leads on through, by field: lists are crossed with the list arm. */
export const followedToOnesOfSupplied = (
  schemaMap: ResolvedSchemaMap,
  key: string,
): [string, { resource: string }][] => {
  const at = suppliedModelAt(schemaMap, key);
  if (!at) return [];
  return Object.entries(at.model.fields).flatMap(([name, entry]) => {
    const target = 'isList' in entry && entry.isList ? null : relationTargetOf(entry, at.mapName);
    return target
      ? [[name, { resource: endpointKey({ fieldMap: target.mapName, model: target.modelName }) }]]
      : [];
  });
};

/** The supplied model a list field of a supplied row holds (`actor:User` `devices` → `actor:Device`), or undefined. */
export const suppliedListAt = (
  schemaMap: ResolvedSchemaMap,
  key: string,
  field: string,
): string | undefined => {
  const at = suppliedModelAt(schemaMap, key);
  const entry = at ? fieldOf(at.fieldMap, at.modelName, field) : undefined;
  const target =
    at && entry && 'isList' in entry && entry.isList ? relationTargetOf(entry, at.mapName) : null;
  return target ? endpointKey({ fieldMap: target.mapName, model: target.modelName }) : undefined;
};

/** The supplied models the call gives one row of: the far end of a declared supplied bridge. A model joined from one is found by key, not given. */
export const suppliedModelsAtRoot = (schemaMap: ResolvedSchemaMap): string[] => [
  ...new Set(schemaMap.suppliedBridges.map(({ endpoints: [, far] }) => endpointKey(far))),
];

/** The supplied models a rule at `resource` reads from its row: those a supplied bridge leads to from its model, or from every model of its map. */
export const suppliedModelsGivenAt = (schemaMap: ResolvedSchemaMap, resource: string): string[] => {
  const { mapName, modelName } = mapAndModelNamed(resource);
  return [
    ...new Set(
      schemaMap.suppliedBridges
        .filter(
          ({ endpoints: [near] }) =>
            near.fieldMap === mapName && (!('model' in near) || near.model === modelName),
        )
        .map(({ endpoints: [, far] }) => endpointKey(far)),
    ),
  ];
};

const rootBridges = (schemaMap: ResolvedSchemaMap, resource: string): SuppliedBridge[] => {
  const { mapName: fieldMap, modelName: model } = mapAndModelNamed(resource);
  return suppliedModelsGivenAt(schemaMap, resource).map((key) => {
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

const setsAt = new WeakMap<ResolvedSchemaMap, Map<string, FieldMapSet>>();

/** The maps a rule at `resource` reads: its own, the supplied ones with their bridges, and a bridge from it to each supplied model a declared supplied bridge gives it. */
export const suppliedSetAt = (schemaMap: ResolvedSchemaMap, resource: string): FieldMapSet =>
  answerOnce(setsAt, schemaMap, resource, () => {
    stitchedSuppliedSet(schemaMap);
    const fieldMap = fieldMapOfResource(schemaMap, resource);
    return {
      maps: {
        ...(fieldMap ? { [mapAndModelNamed(resource).mapName]: fieldMap } : {}),
        ...(schemaMap.suppliedFieldMaps ?? {}),
      },
      bridges: [...bridgesBetweenSuppliedMaps(schemaMap), ...rootBridges(schemaMap, resource)],
    };
  });

const rootSetsAt = new WeakMap<ResolvedSchemaMap, Map<string, FieldMapSet>>();

// why: the lens bridges supplied rows at the root only, so the embed fills the root and never copies the rows below it
const suppliedSetAtRoot = (schemaMap: ResolvedSchemaMap, resource: string): FieldMapSet =>
  answerOnce(rootSetsAt, schemaMap, resource, () => {
    const { maps, bridges } = suppliedSetAt(schemaMap, resource);
    const { mapName, modelName } = mapAndModelNamed(resource);
    return {
      maps: { ...maps, [mapName]: { models: { [modelName]: { fields: {} } } } },
      ...(bridges ? { bridges } : {}),
    };
  });

/** The record a `{ rule }` at `resource` is checked on: its bridges to the supplied maps filled from `bridgeData`, and theirs in turn. */
export const recordWithSuppliedData = (
  schemaMap: ResolvedSchemaMap,
  resource: string,
  record: Row,
  bridgeData: Record<string, Row[]> | undefined,
  dictionary: BridgeDictionary | undefined,
): Row =>
  recordWithBridgeData(
    suppliedSetAtRoot(schemaMap, resource),
    resource,
    record,
    bridgeData,
    dictionary,
  );
