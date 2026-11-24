import { isScalarField } from '@inixiative/field-map';
import { hasNoValue, idField } from './recordId';
import { indexMap, type Relation } from './relations';
import { fieldOfResource, modelOfResource } from './resourceNames';
import type { RecordFieldMaps } from './schemaMap';
import type { Row } from './types';

/** The foreign-key columns a child holds for `parent`, leaving out any the parent has no value for. */
export const keysFrom = (relation: Pick<Relation, 'from' | 'to'>, parent: Row): Row =>
  Object.fromEntries(
    relation.from.flatMap((column, index) => {
      const value = parent[relation.to[index] as string];
      return hasNoValue(value) ? [] : [[column, value]];
    }),
  );

/** The one encoding of a row's key: its resource and the columns that pick it, in column order. */
export const keyFromResourceAndColumns = (resource: string, where: Row): string =>
  `${resource}\u0000${JSON.stringify(
    Object.entries(where).sort(([a], [b]) => a.localeCompare(b)),
    (_column, value) => (typeof value === 'bigint' ? `${value}n` : value),
  )}`;

// why: the engine id field is what the app loads by (Zealot's `uuid`), so it wins over the model's `isId`
/** The columns that pick a row, with the values the row holds: the engine id field when the model has it and the row a value, else the model's id columns, else undefined. */
export const identityColumnsOfRow = (
  map: RecordFieldMaps,
  resource: string,
  record: Row,
  field = idField(),
): Row | undefined => {
  const model = modelOfResource(map, resource);
  if (fieldOfResource(map, resource, field) && !hasNoValue(record[field]))
    return { [field]: record[field] };
  const { idColumns } = indexMap(map);
  if (!idColumns.has(resource)) {
    const single = Object.entries(model?.fields ?? {})
      .filter(([, entry]) => isScalarField(entry) && entry.isId)
      .map(([name]) => name);
    idColumns.set(
      resource,
      single.length ? single : (model?.indexes?.find((index) => index.kind === 'id')?.fields ?? []),
    );
  }
  const columns = idColumns.get(resource) as readonly string[];
  if (!columns.length || columns.some((column) => hasNoValue(record[column]))) return undefined;
  const identity: Row = {};
  for (const column of columns) identity[column] = record[column];
  return identity;
};

// why: a key is text, so `5` and `'5'` are one row here while `load` is asked with the value as held
/** A row's key (`identityColumnsOfRow`, each value as a string, encoded with its resource), or undefined (the object). */
export const identityKeyOfRow = (
  map: RecordFieldMaps,
  resource: string,
  record: Row,
  field = idField(),
): string | undefined => {
  const columns = identityColumnsOfRow(map, resource, record, field);
  if (!columns) return undefined;
  const asText: Row = {};
  for (const [column, value] of Object.entries(columns)) asText[column] = String(value);
  return keyFromResourceAndColumns(resource, asText);
};
