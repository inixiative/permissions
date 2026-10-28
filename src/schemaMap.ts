import type { Condition, FieldMap } from '@inixiative/json-rules';
import type { EntitlementEntry } from './permix';
import { recordId } from './recordId';
import type { Row } from './types';

/** A polymorphic model's discriminator: `field` names the kind, `fkMap` the columns each kind carries. */
export type PolymorphicAxis = { field: string; fkMap: Partial<Record<string, readonly string[]>> };

/** Polymorphic models by model name, in the shape of a false-polymorphism registry. */
export type Polymorphism = Partial<Record<string, { axes: readonly PolymorphicAxis[] }>>;

/**
 * The schema the checks walk: `resources` names the `fieldMap` model behind each resource, the
 * `fieldMap` (json-rules, structurally a prisma-map) lists each model's relations and foreign keys,
 * and `polymorphism` says which kind a relation makes a polymorphic record.
 */
export type SchemaMap<R extends string = string> = {
  resources: Record<R, string>;
  fieldMap: FieldMap;
  polymorphism?: Polymorphism;
};

/** A to-one relation that owns its foreign key: where it leads, its columns, and the kind it implies. */
export type Relation<R extends string = string> = {
  resource: R;
  from: readonly string[];
  to: readonly string[];
  kind: { field: string; value: string } | null;
};

const resourceOf = <R extends string>(map: SchemaMap<R>, model: string): R | null =>
  (Object.entries(map.resources) as [R, string][]).find(([, name]) => name === model)?.[0] ?? null;

const fieldOf = <R extends string>(map: SchemaMap<R>, resource: R, segment: string) => {
  const model = map.resources[resource];
  return model ? map.fieldMap.models[model]?.fields[segment] : undefined;
};

export const resolveField = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  segment: string,
): R | null => {
  const field = fieldOf(map, resource, segment);
  return field?.kind === 'object' ? resourceOf(map, field.type) : null;
};

const kindOf = (axes: readonly PolymorphicAxis[], columns: readonly string[]) => {
  for (const axis of axes) {
    const [value] = Object.entries(axis.fkMap)
      .filter(([, fks]) => fks?.length && columns.every((column) => fks.includes(column)))
      .sort(([, a], [, b]) => (a?.length ?? 0) - (b?.length ?? 0))
      .map(([candidate]) => candidate);
    if (value) return { field: axis.field, value };
  }
  return null;
};

export const relationOf = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  segment: string,
): Relation<R> | null => {
  const field = fieldOf(map, resource, segment);
  if (field?.kind !== 'object' || field.isList || !field.fromFields?.length) return null;
  const target = resourceOf(map, field.type);
  if (!target) return null;
  const axes = map.polymorphism?.[map.resources[resource]]?.axes ?? [];
  return {
    resource: target,
    from: field.fromFields,
    to: field.toFields ?? [],
    kind: kindOf(axes, field.fromFields),
  };
};

const exactKeys = new Set(['field', 'operator', 'value']);

const pinned = (where: Condition | undefined): Row => {
  if (!where || typeof where !== 'object') return {};
  if ('all' in where && Array.isArray(where.all) && Object.keys(where).length === 1)
    return Object.assign({}, ...where.all.map(pinned));
  const leaf = where as Record<string, unknown>;
  const exact =
    leaf.operator === 'equals' &&
    typeof leaf.field === 'string' &&
    !leaf.field.includes('.') &&
    'value' in leaf &&
    Object.keys(leaf).every((key) => exactKeys.has(key));
  return exact ? { [leaf.field as string]: leaf.value } : {};
};

/**
 * The pseudo record a grant is checked on, built from the hydrated `anchor` down the entry's path:
 * at each step the foreign keys whose values the parent knows and the kind the relation implies,
 * with the parent attached under the relation. Ids below the anchor stay unknown. The `where`'s
 * exact `equals` values fill the rest; the path wins over a pinned foreign key. Null when the
 * anchor is not the entry's, or the path does not end at its model through to-one relations.
 */
export const placeEntitlement = <R extends string>(
  map: SchemaMap<R>,
  entry: EntitlementEntry,
  anchor: Row,
): Row | null => {
  if (recordId(anchor) !== entry.anchor.id) return null;
  const anchorResource = entry.anchor.resource as R;
  const place = (resource: R, segments: string[]): Row | null => {
    const [segment, ...rest] = segments;
    if (segment === undefined) return resource === anchorResource ? anchor : null;
    const relation = relationOf(map, resource, segment);
    if (!relation) return null;
    const parent = place(relation.resource, rest);
    if (!parent) return null;
    const keys = Object.fromEntries(
      relation.from.flatMap((column, index) => {
        const value = parent[relation.to[index] as string];
        return value == null || value === '' ? [] : [[column, value]];
      }),
    );
    const kind = relation.kind ? { [relation.kind.field]: relation.kind.value } : {};
    return { ...keys, ...kind, [segment]: parent };
  };
  if (entry.anchor.path === undefined)
    return entry.resource === entry.anchor.resource ? anchor : null;
  const placed = place(entry.resource as R, entry.anchor.path.split('.'));
  return placed && { ...pinned(entry.where), ...placed };
};
