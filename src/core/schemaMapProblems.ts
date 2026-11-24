import { modelOf, own } from '@inixiative/field-map';
import { isJoinedBridge } from '@inixiative/json-rules';
import {
  bridgeFromRecordHasNoJoin,
  bridgeHasOneEndSupplied,
  mapIsInBothMapsAndSupplied,
  mapNameIsNoName,
  polymorphismNamesNoMap,
  polymorphismNamesNoModel,
} from './errors';
import { isSuppliedMap } from './resourceNames';
import type { SchemaMap } from './schemaMap';

/** What is wrong with the map's names, which stops it being indexed: a map name that is no name, a polymorphism entry for a map or model the maps do not have, a map in both groups. */
export const problemsOfMapNames = (schemaMap: SchemaMap): string[] => [
  ...[...Object.keys(schemaMap.fieldMaps), ...Object.keys(schemaMap.suppliedFieldMaps ?? {})]
    .filter((mapName) => !mapName || mapName.includes(':'))
    .map(mapNameIsNoName),
  ...Object.entries(schemaMap.polymorphismRegistries ?? {}).flatMap(([mapName, models]) => {
    const fieldMap = own(schemaMap.fieldMaps, mapName);
    if (!fieldMap) return [polymorphismNamesNoMap(mapName)];
    return Object.keys(models ?? {})
      .filter((model) => !modelOf(fieldMap, model))
      .map((model) => polymorphismNamesNoModel(mapName, model));
  }),
  ...Object.keys(schemaMap.fieldMaps)
    .filter((mapName) => isSuppliedMap(schemaMap, mapName))
    .map(mapIsInBothMapsAndSupplied),
];

/** What is wrong with the map's bridges: one with a single end supplied, or one crossed by a `rel` with no join. */
export const problemsOfBridges = (schemaMap: SchemaMap): string[] =>
  (schemaMap.bridges ?? []).flatMap((bridge) => {
    const supplied = bridge.endpoints.filter((end) =>
      isSuppliedMap(schemaMap, end.fieldMap),
    ).length;
    if (supplied === 1) return [bridgeHasOneEndSupplied(bridge)];
    return supplied === 0 && !isJoinedBridge(bridge) ? [bridgeFromRecordHasNoJoin(bridge)] : [];
  });
