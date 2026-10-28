import type { Condition, FieldMap } from '@inixiative/json-rules';
import { entitlementProblem } from './entitlementProblem';
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

/**
 * A to-one relation that owns its foreign key: where it leads, its columns, and on a polymorphic
 * record the kinds it admits (every kind whose registry columns hold the relation's columns).
 */
export type Relation<R extends string = string> = {
  resource: R;
  from: readonly string[];
  to: readonly string[];
  kinds: { field: string; values: string[] } | null;
};

type MapIndex = { resources: Map<string, string>; relations: Map<string, Relation | null> };

const indexes = new WeakMap<SchemaMap, MapIndex>();

export const indexMap = (map: SchemaMap): MapIndex => {
  const known = indexes.get(map);
  if (known) return known;
  const resources = new Map<string, string>();
  for (const [resource, model] of Object.entries(map.resources)) {
    if (resources.has(model))
      throw new Error(`${model} is the model of two resources: give each resource its own model`);
    resources.set(model, resource);
  }
  const index = { resources, relations: new Map<string, Relation | null>() };
  indexes.set(map, index);
  return index;
};

const resourceOf = <R extends string>(map: SchemaMap<R>, model: string): R | null =>
  (indexMap(map as SchemaMap).resources.get(model) as R | undefined) ?? null;

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

const kindsOf = (axes: readonly PolymorphicAxis[], columns: readonly string[]) => {
  for (const axis of axes) {
    const values = Object.entries(axis.fkMap)
      .filter(([, fks]) => fks?.length && columns.every((column) => fks.includes(column)))
      .map(([value]) => value);
    if (values.length) return { field: axis.field, values };
  }
  return null;
};

export const relationOf = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  segment: string,
): Relation<R> | null => {
  const cache = indexMap(map as SchemaMap).relations;
  const key = `${resource}\u0000${segment}`;
  if (!cache.has(key)) cache.set(key, relationFor(map, resource, segment));
  return (cache.get(key) as Relation<R> | null | undefined) ?? null;
};

const relationFor = <R extends string>(
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
    kinds: kindsOf(axes, field.fromFields),
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

const keysFrom = (relation: Relation, parent: Row): Row =>
  Object.fromEntries(
    relation.from.flatMap((column, index) => {
      const value = parent[relation.to[index] as string];
      return value == null || value === '' ? [] : [[column, value]];
    }),
  );

const relationNames = <R extends string>(map: SchemaMap<R>, resource: R): string[] =>
  Object.keys(map.fieldMap.models[map.resources[resource]]?.fields ?? {});

const ownerRelationOf = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  field: string,
  value: string,
): string | undefined => {
  const axis = map.polymorphism?.[map.resources[resource]]?.axes.find((a) => a.field === field);
  const columns = [...(axis?.fkMap[value] ?? [])].sort().join(',');
  return relationNames(map, resource).find(
    (name) => [...(relationOf(map, resource, name)?.from ?? [])].sort().join(',') === columns,
  );
};

const chainOf = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  row: Row,
  segments: string[],
): Map<R, Row> => {
  const chain = new Map<R, Row>([[resource, row]]);
  let current = resource;
  let at = row;
  for (const segment of segments) {
    const relation = relationOf(map, current, segment);
    const next = at[segment] as Row | undefined;
    if (!relation || !next) break;
    current = relation.resource;
    at = next;
    chain.set(current, at);
  }
  return chain;
};

const placeTowards = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  chain: ReadonlyMap<R, Row>,
  depth: number,
  seen: ReadonlySet<R>,
): Row | null => {
  const row: Row = {};
  let reached = false;
  for (const name of relationNames(map, resource)) {
    const relation = relationOf(map, resource, name);
    if (!relation) continue;
    const parent =
      chain.get(relation.resource) ??
      (depth > 1 && !seen.has(relation.resource)
        ? placeTowards(map, relation.resource, chain, depth - 1, new Set([...seen, resource]))
        : null);
    if (!parent) continue;
    Object.assign(row, keysFrom(relation, parent), { [name]: parent });
    reached = true;
  }
  return reached ? row : null;
};

/**
 * The records of `resource` that sit under the hydrated `anchor` (a record of `anchorResource`)
 * along `path` (dotted to-one relation names that own their foreign keys): at each step the foreign
 * keys whose values the parent knows, composite ones included, and the parent attached under the
 * relation. On a polymorphic step there is one record per kind the relation admits, each with its
 * owner placed under the anchor along every relation that leads there; `pins` (exact values, as a
 * `where` pins them) narrow the kinds. Ids below the anchor stay unknown. Empty when the path does
 * not lead to the anchor's resource.
 */
export const placeUnder = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  path: string,
  anchorResource: R,
  anchor: Row,
  pins: Row = {},
): Row[] => {
  const step = (
    current: R,
    segment: string,
    rest: string[],
    relation: Relation<R>,
    parent: Row,
    top: boolean,
  ): Row[] => {
    const base: Row = { ...keysFrom(relation, parent), [segment]: parent };
    if (!relation.kinds) return [base];
    const { field, values } = relation.kinds;
    const pinnedKind = top ? pins[field] : undefined;
    return values
      .filter((value) => pinnedKind === undefined || value === pinnedKind)
      .flatMap((value) => {
        const row: Row = { ...base, [field]: value };
        const ownerName = ownerRelationOf(map, current, field, value);
        if (!ownerName || ownerName === segment) return [row];
        const ownerRelation = relationOf(map, current, ownerName) as Relation<R>;
        const owner = placeTowards(
          map,
          ownerRelation.resource,
          chainOf(map, relation.resource, parent, rest),
          3,
          new Set(),
        );
        return owner ? [{ ...row, ...keysFrom(ownerRelation, owner), [ownerName]: owner }] : [];
      });
  };
  const place = (current: R, segments: string[], top: boolean): Row[] => {
    const [segment, ...rest] = segments;
    if (segment === undefined) return current === anchorResource ? [anchor] : [];
    const relation = relationOf(map, current, segment);
    if (!relation) return [];
    return place(relation.resource, rest, false).flatMap((parent) =>
      step(current, segment, rest, relation, parent, top),
    );
  };
  return place(resource, path.split('.'), true);
};

/**
 * The pseudo records a grant is checked on: `placeUnder` from the hydrated `anchor` along the entry's
 * path, narrowed by the kinds its `where` pins, each given the `where`'s exact `equals` values (the
 * path wins over a pinned foreign key). A self anchor is the anchor row itself. Null when the entry
 * is malformed (the rules `setup` applies), the anchor is not the entry's, or the path reaches
 * nothing; the writer must pass on every record.
 */
export const placeEntitlement = <R extends string>(
  map: SchemaMap<R>,
  entry: EntitlementEntry,
  anchor: Row,
): Row[] | null => {
  if (entitlementProblem(entry) !== null || recordId(anchor) !== entry.anchor.id) return null;
  if (entry.anchor.path === undefined) return [anchor];
  const pins = pinned(entry.where);
  const placed = placeUnder(
    map,
    entry.resource as R,
    entry.anchor.path,
    entry.anchor.resource as R,
    anchor,
    pins,
  ).map((record) => ({ ...pins, ...record }));
  return placed.length ? placed : null;
};
