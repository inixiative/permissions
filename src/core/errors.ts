import { type Bridge, endpointKey } from '@inixiative/json-rules';

/** What is wrong with a schema map's own shape, in the words every refusal and validator uses. */

export const nameHasNoMap = (name: string) =>
  `\`${name}\` names no map: a resource is \`map:Model\``;

export const nameIsNoModelOfItsMap = (name: string, mapName: string) =>
  `\`${name}\` is not a model of the map \`${mapName}\``;

export const mapNameIsNoName = (mapName: string) =>
  `a map is named \`${mapName}\`: a map's name is the part of \`map:Model\` before the colon`;

export const mapIsInBothMapsAndSupplied = (mapName: string) =>
  `\`${mapName}\` is in both \`fieldMaps\` and \`suppliedFieldMaps\`: a map is one or the other`;

export const polymorphismNamesNoMap = (mapName: string) =>
  `\`polymorphismRegistries\` names the map \`${mapName}\`, which is not in \`fieldMaps\`: it is keyed by map name, then model`;

export const polymorphismNamesNoModel = (mapName: string, model: string) =>
  `\`polymorphismRegistries\` names \`${endpointKey({ fieldMap: mapName, model })}\`, which is not a model of the map \`${mapName}\``;

const between = ({ endpoints: [a, b] }: Bridge) =>
  `a bridge between \`${endpointKey(a)}\` and \`${endpointKey(b)}\``;

export const bridgeHasOneEndSupplied = (bridge: Bridge) =>
  `${between(bridge)} has one end supplied: no chain leads from a supplied row into the records`;

export const bridgeFromRecordHasNoJoin = (bridge: Bridge) =>
  `${between(bridge)} has no join: only a bridge between supplied maps is given its row`;

export const resourceHasNoFieldMap = (resource: string) =>
  `\`${resource}\` is not a model of a map in \`fieldMaps\`, nor the far end of a bridge from one: nothing its rules read is checked`;
