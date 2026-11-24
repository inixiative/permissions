import { type Bridge, endpointKey } from '@inixiative/json-rules';

/** What is wrong with a schema map's own shape, in the words every refusal and validator uses. */

export const nameHasNoMap = (name: string) =>
  `\`${name}\` names no map: a resource is \`map:Model\``;

export const nameIsNoModelOfItsMap = (name: string, mapName: string) =>
  `\`${name}\` is not a model of the map \`${mapName}\``;

export const mapNameIsNoName = (mapName: string) =>
  `a map is named \`${mapName}\`: a map's name is the part of \`map:Model\` before the colon`;

export const suppliedBridgeEndsInARecordMap = (bridge: Bridge, mapName: string) =>
  `${between(bridge)} has no join, so its far end is supplied, but \`${mapName}\` holds records (it has rules, or starts a supplied bridge): no chain leads from a supplied row into the records`;

export const suppliedBridgeEndsInNoFieldMap = (bridge: Bridge, mapName: string) =>
  `${between(bridge)} ends in the map \`${mapName}\`, which is not in \`fieldMaps\``;

export const polymorphismNamesNoMap = (mapName: string) =>
  `\`polymorphismRegistries\` names the map \`${mapName}\`, which is not a field map of records: it is keyed by map name, then model`;

export const polymorphismNamesNoModel = (mapName: string, model: string) =>
  `\`polymorphismRegistries\` names \`${endpointKey({ fieldMap: mapName, model })}\`, which is not a model of the map \`${mapName}\``;

const endName = (end: Bridge['endpoints'][number]) =>
  'model' in end ? endpointKey(end) : `every model of ${end.fieldMap}`;

const between = ({ endpoints: [a, b] }: Bridge) =>
  `a bridge between \`${endName(a)}\` and \`${endName(b)}\``;

export const bridgeHasOneEndSupplied = (bridge: Bridge) =>
  `${between(bridge)} has one end supplied: no chain leads from a supplied row into the records`;

export const resourceHasNoFieldMap = (resource: string) =>
  `\`${resource}\` is not a model of a map in \`fieldMaps\`, nor the far end of a bridge from one: nothing its rules read is checked`;
