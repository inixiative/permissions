import {
  type FieldEntry,
  type FieldMap,
  fieldOf,
  type ModelEntry,
  modelOf,
  own,
  type RelationField,
} from '@inixiative/field-map';
import { endpointKey, parseEndpointKey, relationTargetOf } from '@inixiative/json-rules';
import { nameHasNoMap, nameIsNoModelOfItsMap } from './errors';
import type { FieldMapsWithPolymorphism, PolymorphicAxis, SchemaMap } from './schemaMap';

const whyNameHasNoMap = (name: string): string | null =>
  name.includes(':') ? null : nameHasNoMap(name);

/** The map and model a name holds (`db:Inquiry`); a name with no map throws. */
export const mapAndModelNamed = (name: string): { mapName: string; modelName: string } => {
  const why = whyNameHasNoMap(name);
  if (why) throw new Error(why);
  return parseEndpointKey(name, '');
};

/** Whether `mapName` is one of the map's supplied maps, whose rows a check is given. */
export const isSuppliedMap = (schemaMap: SchemaMap, mapName: string): boolean =>
  Object.hasOwn(schemaMap.suppliedFieldMaps ?? {}, mapName);

/** The field map a record's resource is in, or undefined when its map is not in `maps`. */
export const fieldMapOfResource = (
  fieldMapsWithPolymorphism: FieldMapsWithPolymorphism,
  resource: string,
): FieldMap | undefined =>
  own(fieldMapsWithPolymorphism.fieldMaps, parseEndpointKey(resource, '').mapName);

/** A record's model entry, or undefined when the map has no field map or no such model for it. */
export const modelOfResource = (
  fieldMapsWithPolymorphism: FieldMapsWithPolymorphism,
  resource: string,
): ModelEntry | undefined => {
  const fieldMap = fieldMapOfResource(fieldMapsWithPolymorphism, resource);
  return fieldMap ? modelOf(fieldMap, parseEndpointKey(resource, '').modelName) : undefined;
};

/** A field of a record's model. */
export const fieldOfResource = (
  fieldMapsWithPolymorphism: FieldMapsWithPolymorphism,
  resource: string,
  name: string,
): FieldEntry | undefined => {
  const fieldMap = fieldMapOfResource(fieldMapsWithPolymorphism, resource);
  return fieldMap ? fieldOf(fieldMap, parseEndpointKey(resource, '').modelName, name) : undefined;
};

/** Why `name` is not a resource of the map, or null: it names no map, or a model its map (in `maps` or `supplied`) does not have. A map in neither is not judged here. */
export const whyNameIsNoModel = (schemaMap: SchemaMap, name: string): string | null => {
  const { mapName, modelName } = parseEndpointKey(name, '');
  const fieldMap =
    fieldMapOfResource(schemaMap, name) ?? own(schemaMap.suppliedFieldMaps ?? {}, mapName);
  return (
    whyNameHasNoMap(name) ??
    (fieldMap && !modelOf(fieldMap, modelName) ? nameIsNoModelOfItsMap(name, mapName) : null)
  );
};

/** The resource a relation field of `resource` leads to (json-rules' `relationTargetOf`, named `map:Model`). */
export const resourceLedToBy = (resource: string, field: RelationField): string => {
  const led = relationTargetOf(field, parseEndpointKey(resource, '').mapName);
  return endpointKey({ fieldMap: led?.mapName ?? '', model: led?.modelName ?? field.type });
};

export const axesOfResource = (
  fieldMapsWithPolymorphism: FieldMapsWithPolymorphism,
  resource: string,
): readonly PolymorphicAxis[] => {
  const { mapName, modelName } = parseEndpointKey(resource, '');
  return fieldMapsWithPolymorphism.polymorphismRegistries?.[mapName]?.[modelName]?.axes ?? [];
};

/** Every model of the given field maps, named `map:Model`. */
export const modelsNamedIn = (
  maps: Record<string, { readonly models: Readonly<Record<string, unknown>> }>,
): string[] =>
  Object.entries(maps).flatMap(([fieldMap, { models }]) =>
    Object.keys(models).map((model) => endpointKey({ fieldMap, model })),
  );

/** `resource`'s polymorphic axis on `field`, from `map.polymorphism`. */
export const axisOf = <R extends string>(
  fieldMapsWithPolymorphism: FieldMapsWithPolymorphism,
  resource: R,
  field: string,
): PolymorphicAxis | undefined =>
  axesOfResource(fieldMapsWithPolymorphism, resource).find((axis) => axis.field === field);
