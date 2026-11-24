import { modelOf, own } from '@inixiative/field-map';
import { endpointKey } from '@inixiative/json-rules';
import {
  bridgeHasOneEndSupplied,
  mapNameIsNoName,
  modelIsGivenAndFoundByKey,
  nameIsNoModelOfItsMap,
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
  const records = recordMapNamesOf({
    fieldMaps: schemaMap.declaredFieldMaps,
    bridges: schemaMap.declaredBridges,
    permissions: schemaMap.permissions,
  });
  const foundByKey = new Set(
    schemaMap.bridges
      .filter(({ endpoints }) => endpoints.every((end) => isSuppliedMap(schemaMap, end.fieldMap)))
      .map(({ endpoints: [, far] }) => endpointKey(far)),
  );
  return [
    ...Object.keys(schemaMap.declaredFieldMaps)
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
      const [near, far] = bridge.endpoints;
      if (records.has(far.fieldMap)) return [suppliedBridgeEndsInARecordMap(bridge, far.fieldMap)];
      const farMap = own(schemaMap.declaredFieldMaps, far.fieldMap);
      if (!farMap) return [suppliedBridgeEndsInNoFieldMap(bridge, far.fieldMap)];
      const nearMap = own(schemaMap.declaredFieldMaps, near.fieldMap);
      return [
        ...(modelOf(farMap, far.model)
          ? []
          : [nameIsNoModelOfItsMap(endpointKey(far), far.fieldMap)]),
        ...('model' in near && nearMap && !modelOf(nearMap, near.model)
          ? [nameIsNoModelOfItsMap(endpointKey(near), near.fieldMap)]
          : []),
        ...(foundByKey.has(endpointKey(far)) ? [modelIsGivenAndFoundByKey(endpointKey(far))] : []),
      ];
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
