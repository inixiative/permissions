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

/** What is wrong with the map's names: a map name that is no name, a map in both groups, a polymorphism entry for a map or model the maps do not have. */
export const problemsOfMapNames = (map: SchemaMap): string[] => [
  ...[...Object.keys(map.maps), ...Object.keys(map.supplied ?? {})]
    .filter((mapName) => !mapName || mapName.includes(':'))
    .map(mapNameIsNoName),
  ...Object.keys(map.maps)
    .filter((mapName) => isSuppliedMap(map, mapName))
    .map(mapIsInBothMapsAndSupplied),
  ...Object.entries(map.polymorphism ?? {}).flatMap(([mapName, models]) => {
    const fieldMap = own(map.maps, mapName);
    if (!fieldMap) return [polymorphismNamesNoMap(mapName)];
    return Object.keys(models ?? {})
      .filter((model) => !modelOf(fieldMap, model))
      .map((model) => polymorphismNamesNoModel(mapName, model));
  }),
];

/** What is wrong with the map's bridges: one with a single end supplied, or one crossed by a `rel` with no join. */
export const problemsOfBridges = (map: SchemaMap): string[] =>
  (map.bridges ?? []).flatMap((bridge) => {
    const supplied = bridge.endpoints.filter((end) => isSuppliedMap(map, end.fieldMap)).length;
    if (supplied === 1) return [bridgeHasOneEndSupplied(bridge)];
    return supplied === 0 && !isJoinedBridge(bridge) ? [bridgeFromRecordHasNoJoin(bridge)] : [];
  });

/** Everything wrong with the map's own shape, before any rule is read. */
export const problemsOfSchemaMap = (map: SchemaMap): string[] => [
  ...problemsOfMapNames(map),
  ...problemsOfBridges(map),
];
