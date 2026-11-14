import {
  type Condition,
  check as checkRule,
  type FieldMap,
  listFields,
} from '@inixiative/json-rules';
import { entitlementProblem } from './entitlementProblem';
import { withExactStrings } from './exactStrings';
import type { EntitlementEntry } from './permix';
import { idField, recordId } from './recordId';
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

type Leaf = { field: string; operator: string; value: unknown };

const isLiteralLeaf = (rule: unknown): rule is Leaf =>
  typeof rule === 'object' &&
  rule !== null &&
  typeof (rule as Leaf).field === 'string' &&
  typeof (rule as Leaf).operator === 'string' &&
  'value' in rule &&
  Object.keys(rule).every((key) => exactKeys.has(key));

export const conjuncts = (where: Condition | null | undefined): unknown[] => {
  if (where == null) return [];
  if (
    typeof where === 'object' &&
    'all' in where &&
    Array.isArray(where.all) &&
    Object.keys(where).length === 1
  )
    return where.all;
  return [where];
};

const rootLeaves = (where: Condition | undefined): Leaf[] => conjuncts(where).filter(isLiteralLeaf);

const pinned = (leaves: Leaf[]): Row =>
  Object.fromEntries(
    leaves
      .filter((leaf) => leaf.operator === 'equals' && !leaf.field.includes('.'))
      .map((leaf) => [leaf.field, leaf.value]),
  );

/** The most pseudo records the literal `in` lists of one entry place; past it they pin nothing. */
const maxListPlacements = 256;

const isLiteral = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The values a root leaf admits when it is an `equals` or an `in` of literals, else null. */
export const literalValues = (rule: unknown): unknown[] | null => {
  if (!isLiteralLeaf(rule) || rule.field.includes('.')) return null;
  if (rule.operator === 'equals') return [rule.value];
  if (rule.operator === 'in' && Array.isArray(rule.value) && rule.value.every(isLiteral))
    return rule.value;
  return null;
};

const listedFields = (leaves: Leaf[], fixed: Row): [string, unknown[]][] => {
  const lists = new Map<string, unknown[]>();
  for (const leaf of leaves) {
    if (leaf.operator !== 'in' || leaf.field in fixed) continue;
    const values = literalValues(leaf);
    if (!values) continue;
    const held = lists.get(leaf.field);
    lists.set(
      leaf.field,
      held ? held.filter((value) => values.includes(value)) : [...new Set(values)],
    );
  }
  return [...lists].filter(([, values]) => values.length > 0);
};

const pinnedRows = (where: Condition | undefined, placed: Row = {}): Row[] => {
  const leaves = rootLeaves(where);
  const exact = pinned(leaves);
  const lists = listedFields(leaves, { ...exact, ...placed });
  const count = lists.reduce((product, [, values]) => product * values.length, 1);
  if (count > maxListPlacements) return [exact];
  return lists.reduce<Row[]>(
    (rows, [field, values]) =>
      rows.flatMap((row) => values.map((value) => ({ ...row, [field]: value }))),
    [exact],
  );
};

const admits = (leaves: Leaf[], field: string, value: string) =>
  leaves.every(
    (leaf) => leaf.field !== field || checkRule(leaf as Condition, { [field]: value }) === true,
  );

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
 * owner placed under the anchor along every relation that leads there; a root leaf of `where` on
 * the first step's kind field (the `where` itself, or a leaf of its top `all`) drops the kinds it
 * fails. Ids below the anchor stay unknown. Empty when the path does not lead to the anchor's
 * resource.
 */
export const placeUnder = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  path: string,
  anchorResource: R,
  anchor: Row,
  where?: Condition,
): Row[] => {
  const leaves = rootLeaves(where);
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
    return values
      .filter((value) => !top || admits(leaves, field, value))
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
        return owner ? [{ ...row, ...keysFrom(ownerRelation, owner), [ownerName]: owner }] : [row];
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
  return withExactStrings(() => place(resource, path.split('.'), true));
};

const withoutPath = (row: Row, [segment, ...rest]: string[]): Row => {
  if (segment === undefined || !(segment in row)) return row;
  const { [segment]: value, ...others } = row;
  if (!rest.length) return others;
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...others, [segment]: withoutPath(value as Row, rest) }
    : row;
};

const placeSelf = (anchor: Row, where: Condition | undefined): Row[] => {
  if (where === undefined) return [anchor];
  const unread = listFields(where).reduce(
    (row, field) => withoutPath(row, field.split('.')),
    anchor,
  );
  return pinnedRows(where).map((pins) => ({ ...unread, ...pins, [idField()]: anchor[idField()] }));
};

/**
 * The pseudo records a grant is checked on: `placeUnder` from the hydrated `anchor` along the entry's
 * path, less the kinds of its first step a root leaf of the `where` (the `where` itself, or a leaf
 * of its top `all`) on the kind field fails, each given the root's exact `equals` values (the path
 * wins over a pinned foreign key). A root `in` of literals (strings, numbers, booleans) on a field
 * no `equals` pins and the path does not set places one record per value, the lists on one field
 * intersected and those on several multiplied; lists sharing no value, or placing more than
 * `maxListPlacements` records, pin nothing. A self anchor is the anchor row with every field the
 * `where` reads unknown, save those pins and the anchor's id, so a held `where` is decided by the
 * entry's own `where`, never by the row as it is today. Null when the entry is malformed (the rules
 * `setup` applies), the anchor is not the entry's, or the path reaches nothing; the writer must
 * pass on every record.
 */
export const placeEntitlement = <R extends string>(
  map: SchemaMap<R>,
  entry: EntitlementEntry,
  anchor: Row,
): Row[] | null => {
  if (entitlementProblem(entry) !== null || recordId(anchor) !== entry.anchor.id) return null;
  if (entry.anchor.path === undefined) return placeSelf(anchor, entry.where);
  const placed = placeUnder(
    map,
    entry.resource as R,
    entry.anchor.path,
    entry.anchor.resource as R,
    anchor,
    entry.where,
  ).flatMap((record) => pinnedRows(entry.where, record).map((pin) => ({ ...pin, ...record })));
  return placed.length ? placed : null;
};
