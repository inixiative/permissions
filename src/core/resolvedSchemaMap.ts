import {
  isJoinedBridge,
  type JoinedBridge,
  parseEndpointKey,
  type SuppliedBridge,
} from '@inixiative/json-rules';
import { pickBy } from 'lodash-es';
import type { ResolvedSchemaMap, SchemaMap } from './schemaMap';

const resolved = new WeakMap<object, ResolvedSchemaMap>();

/** The maps that hold records: one that starts a supplied bridge, or that the rules name. */
export const recordMapNamesOf = (schemaMap: SchemaMap): Set<string> =>
  new Set([
    ...(schemaMap.bridges ?? [])
      .filter((bridge) => !isJoinedBridge(bridge))
      .map((bridge) => bridge.endpoints[0].fieldMap),
    ...Object.keys(schemaMap.permissions).map((resource) => parseEndpointKey(resource, '').mapName),
  ]);

/**
 * The supplied maps: the map a supplied bridge ends in, and any map joined from one (`sec:Device`
 * joined from `actor:User`). A map that holds records is never taken in: what joins it to a
 * supplied map is reported as a problem of the bridge.
 */
export const suppliedMapNamesOf = (schemaMap: SchemaMap): Set<string> => {
  const bridges = schemaMap.bridges ?? [];
  const records = recordMapNamesOf(schemaMap);
  const supplied = new Set(
    bridges
      .filter((bridge) => !isJoinedBridge(bridge))
      .map((bridge) => bridge.endpoints[1].fieldMap)
      .filter((mapName) => !records.has(mapName)),
  );
  const joined = bridges.filter(isJoinedBridge);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { endpoints } of joined)
      for (const [here, there] of [
        [endpoints[0].fieldMap, endpoints[1].fieldMap],
        [endpoints[1].fieldMap, endpoints[0].fieldMap],
      ] as const)
        if (supplied.has(here) && !supplied.has(there) && !records.has(there)) {
          supplied.add(there);
          grew = true;
        }
  }
  return supplied;
};

/** The schema map with its supplied maps told apart, made once per schema map object. */
export const resolvedSchemaMap = <R extends string = string>(
  schemaMap: SchemaMap<R> | ResolvedSchemaMap<R>,
): ResolvedSchemaMap<R> => {
  const known = resolved.get(schemaMap);
  if (known) return known as ResolvedSchemaMap<R>;
  const declared = schemaMap as SchemaMap<R>;
  const supplied = suppliedMapNamesOf(declared);
  const bridges = declared.bridges ?? [];
  const made: ResolvedSchemaMap<R> = {
    fieldMaps: pickBy(declared.fieldMaps, (_, mapName) => !supplied.has(mapName)),
    suppliedFieldMaps: pickBy(declared.fieldMaps, (_, mapName) => supplied.has(mapName)),
    ...(declared.polymorphismRegistries
      ? { polymorphismRegistries: declared.polymorphismRegistries }
      : {}),
    bridges: bridges.filter((bridge): bridge is JoinedBridge => isJoinedBridge(bridge)),
    suppliedBridges: bridges.filter((bridge): bridge is SuppliedBridge => !isJoinedBridge(bridge)),
    permissions: declared.permissions,
    declared,
  };
  resolved.set(declared, made);
  resolved.set(made, made);
  return made;
};
