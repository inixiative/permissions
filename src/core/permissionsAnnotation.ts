import { type FieldEntry, hasColumn, isScalarField } from '@inixiative/field-map';
import { idField } from './recordId';
import { axesOfResource, modelOfResource } from './resourceNames';
import type { SchemaMap } from './schemaMap';

/** A field's `/// @permissions(...)` annotation, as field-map carries it. */
export const permissionsAnnotation = (field: FieldEntry | undefined) =>
  field?.annotations?.permissions;

export const skipsHydration = (field: FieldEntry | undefined): boolean =>
  permissionsAnnotation(field)?.hydrate === false;

export const annotationKeys = ['hydrate', 'down', 'pseudoField'];
const pseudoFieldTypes = ['String', 'Int', 'Boolean'];
export const dottedPath = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

/** Why the field `name` of `resource` is no `pseudoField` with this value, or null. */
export const whyFieldIsNoPseudoField = (
  map: SchemaMap,
  resource: string,
  name: string,
  value: unknown,
): string | null => {
  const fields = modelOfResource(map, resource)?.fields ?? {};
  const field = fields[name];
  if (value !== true) return 'is true or absent';
  if (!field || !hasColumn(field)) return 'sits on a scalar or enum field';
  if (field.isList) return 'never sits on a list';
  if ((isScalarField(field) && field.isId) || name === idField()) return 'never sits on an id';
  if (
    Object.values(fields).some(
      (other) => other.kind === 'object' && other.fromFields?.includes(name),
    )
  )
    return 'never sits on a relation key: the path sets it';
  if (axesOfResource(map, resource).some((axis) => axis.field === name))
    return 'never sits on a discriminator: the path sets the kind';
  if (field.kind === 'scalar' && !pseudoFieldTypes.includes(field.type))
    return `sits on String, Int, Boolean or an enum, not ${field.type}`;
  return null;
};
