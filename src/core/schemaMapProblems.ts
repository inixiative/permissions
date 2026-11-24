import { modelOf, own } from '@inixiative/field-map';
import {
  bridgeHasOneEndSupplied,
  mapNameIsNoName,
  polymorphismNamesNoMap,
  polymorphismNamesNoModel,
  suppliedBridgeEndsInARecordMap,
  suppliedBridgeEndsInNoFieldMap,
} from './errors';
import { recordMapNamesOf } from './resolvedSchemaMap';
import { isSuppliedMap } from './resourceNames';
import type { ResolvedSchemaMap } from './schemaMap';

/** What is wrong with the map's names, which stops it being indexed: a map name that is no name, a polymorphism entry for a map or model the record maps do not have, a supplied bridge that ends in a map of records or in no field map. */
export const problemsOfMapNames = (schemaMap: ResolvedSchemaMap): string[] => {
  const records = recordMapNamesOf(schemaMap.declared);
  return [
    ...Object.keys(schemaMap.declared.fieldMaps)
      .filter((mapName) => !mapName || mapName.includes(':'))
      .map(mapNameIsNoName),
    ...Object.entries(schemaMap.polymorphismRegistries ?? {}).flatMap(([mapName, models]) => {
      const fieldMap = own(schemaMap.fieldMaps, mapName);
      if (!fieldMap) return [polymorphismNamesNoMap(mapName)];
      return Object.keys(models ?? {})
        .filter((model) => !modelOf(fieldMap, model))
        .map((model) => polymorphismNamesNoModel(mapName, model));
    }),
    ...schemaMap.suppliedBridges.flatMap((bridge) => {
      const far = bridge.endpoints[1].fieldMap;
      if (records.has(far)) return [suppliedBridgeEndsInARecordMap(bridge, far)];
      return own(schemaMap.declared.fieldMaps, far)
        ? []
        : [suppliedBridgeEndsInNoFieldMap(bridge, far)];
    }),
  ];
};

/** What is wrong with the map's joined bridges: one with a single end in a supplied map. */
export const problemsOfBridges = (schemaMap: ResolvedSchemaMap): string[] =>
  schemaMap.bridges.flatMap((bridge) => {
    const supplied = bridge.endpoints.filter((end) =>
      isSuppliedMap(schemaMap, end.fieldMap),
    ).length;
    return supplied === 1 ? [bridgeHasOneEndSupplied(bridge)] : [];
  });
