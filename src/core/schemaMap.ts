import { type Condition, check as checkRule, type FieldMap } from '@inixiative/json-rules';
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

/**
 * A list relation the walk may cross, declared `/// @permissions(down: [...])` on the list field:
 * the items' resource, the items' foreign key back to the parent (`from` on the item, `to` on the
 * parent), and the dotted to-one paths loaded under each item.
 */
export type ListRelation<R extends string = string> = {
  resource: R;
  from: readonly string[];
  to: readonly string[];
  paths: readonly (readonly string[])[];
};

type MapIndex = {
  resources: Map<string, string>;
  relations: Map<string, Relation | null>;
  lists: Map<string, ListRelation>;
  marks: Map<string, ReadonlySet<string>>;
};

type Annotated = { annotations?: { permissions?: Record<string, unknown> } };

/** A field's `/// @permissions(...)` annotation, as prisma-map carries it. */
export const permissionsAnnotation = (field: unknown): Record<string, unknown> | undefined =>
  (field as Annotated | undefined)?.annotations?.permissions;

const annotationKeys = ['hydrate', 'down', 'place'];
const placeableTypes = ['String', 'Int', 'Boolean'];
const dottedPath = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

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
  const index: MapIndex = {
    resources,
    relations: new Map<string, Relation | null>(),
    lists: new Map(),
    marks: new Map(),
  };
  indexes.set(map, index);
  try {
    indexAnnotations(map, index);
  } catch (error) {
    indexes.delete(map);
    throw error;
  }
  return index;
};

// why: prisma-map keeps a malformed annotation value without complaint, so every one is read strictly here
const indexAnnotations = (map: SchemaMap, index: MapIndex) => {
  for (const [resource, model] of Object.entries(map.resources)) {
    const fields = map.fieldMap.models[model]?.fields ?? {};
    const marks = new Set<string>();
    for (const [name, field] of Object.entries(fields)) {
      const annotation = permissionsAnnotation(field);
      if (!annotation) continue;
      const at = `${model}.${name} @permissions`;
      if (!Object.keys(annotation).length) throw new Error(`${at}: no \`key: value\` read`);
      const unknown = Object.keys(annotation).find((key) => !annotationKeys.includes(key));
      if (unknown) throw new Error(`${at}: unknown key \`${unknown}\``);
      if ('hydrate' in annotation && typeof annotation.hydrate !== 'boolean')
        throw new Error(`${at}: \`hydrate\` is true or false`);
      if ('down' in annotation && annotation.hydrate === false)
        throw new Error(`${at}: \`down\` loads the list, \`hydrate: false\` says not to`);
      if ('down' in annotation)
        index.lists.set(`${resource}\u0000${name}`, listFor(map, resource, name, annotation.down));
      if ('place' in annotation) {
        const problem = placeProblem(map, model, name, annotation.place);
        if (problem) throw new Error(`${at}: \`place\` ${problem}`);
        marks.add(name);
      }
    }
    if (marks.size) index.marks.set(resource, marks);
  }
};

const placeProblem = (map: SchemaMap, model: string, name: string, value: unknown) => {
  const fields = map.fieldMap.models[model]?.fields ?? {};
  const field = fields[name] as (typeof fields)[string] & { isId?: boolean };
  if (value !== true) return 'is true or absent';
  if (field.kind !== 'scalar' && field.kind !== 'enum') return 'marks a scalar or enum field';
  if (field.isList) return 'never marks a list';
  if (field.isId || name === idField()) return 'never marks an id';
  if (Object.values(fields).some((other) => other.fromFields?.includes(name)))
    return 'never marks a relation key: the path sets it';
  if (map.polymorphism?.[model]?.axes.some((axis) => axis.field === name))
    return 'never marks a discriminator: the path sets the kind';
  if (field.kind === 'scalar' && !placeableTypes.includes(field.type))
    return `marks String, Int, Boolean or an enum, not ${field.type}`;
  return null;
};

const listFor = (map: SchemaMap, resource: string, name: string, down: unknown): ListRelation => {
  const model = map.resources[resource] as string;
  const at = `${model}.${name} @permissions`;
  const field = map.fieldMap.models[model]?.fields[name];
  if (field?.kind !== 'object' || !field.isList)
    throw new Error(`${at}: \`down\` sits on a list relation`);
  const item = resourceOf(map, field.type);
  if (!item) throw new Error(`${at}: ${field.type} is not a resource in the map`);
  const back = Object.entries(map.fieldMap.models[field.type]?.fields ?? {}).filter(
    ([, other]) =>
      other.kind === 'object' &&
      !other.isList &&
      other.type === model &&
      other.fromFields?.length &&
      (!field.relationName || !other.relationName || other.relationName === field.relationName),
  );
  const [inverse] = back;
  if (back.length !== 1 || !inverse)
    throw new Error(
      `${at}: ${field.type} needs exactly one foreign key back to ${model} (found ${back.length}); an implicit many-to-many has none`,
    );
  if (
    !Array.isArray(down) ||
    down.some((path) => typeof path !== 'string' || !dottedPath.test(path))
  )
    throw new Error(
      `${at}: \`down\` is a list of dotted relation paths, \`[forumUser.fanUser, forumUser.brandUser]\`, got ${JSON.stringify(down)}`,
    );
  const paths = (down as string[]).map((path) => path.split('.'));
  for (const path of paths) {
    let current = item;
    for (const [depth, segment] of path.entries()) {
      const entry = map.fieldMap.models[map.resources[current] as string]?.fields[segment];
      const relation = relationOf(map, current, segment);
      if (!relation)
        throw new Error(
          `${at}: \`${path.join('.')}\`: \`${segment}\` is not a to-one relation of \`${current}\` that owns its foreign key and leads to a resource`,
        );
      if (depth === 0 && segment === inverse[0])
        throw new Error(`${at}: \`${path.join('.')}\` goes back up the list it came down`);
      if (permissionsAnnotation(entry)?.hydrate === false)
        throw new Error(`${at}: \`${path.join('.')}\`: \`${segment}\` is \`hydrate: false\``);
      current = relation.resource;
    }
  }
  return {
    resource: item,
    from: inverse[1].fromFields ?? [],
    to: inverse[1].toFields ?? [],
    paths,
  };
};

/** The declared list `segment` of `resource`, or null: an undeclared list is never crossed. */
export const listOf = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  segment: string,
): ListRelation<R> | null =>
  (indexMap(map as SchemaMap).lists.get(`${resource}\u0000${segment}`) as
    | ListRelation<R>
    | undefined) ?? null;

/** The declared lists of `resource`, by field name. */
export const listsOf = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
): [string, ListRelation<R>][] =>
  [...indexMap(map as SchemaMap).lists].flatMap(([key, list]) => {
    const [of, name] = key.split('\u0000') as [string, string];
    return of === resource ? [[name, list as ListRelation<R>] as [string, ListRelation<R>]] : [];
  });

const marksOf = <R extends string>(map: SchemaMap<R>, resource: R): ReadonlySet<string> =>
  indexMap(map as SchemaMap).marks.get(resource) ?? new Set();

const resourceOf = <R extends string>(map: SchemaMap<R>, model: string): R | null =>
  (indexMap(map as SchemaMap).resources.get(model) as R | undefined) ?? null;

export const fieldOf = <R extends string>(map: SchemaMap<R>, resource: R, segment: string) => {
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

const isScalar = (value: unknown) => value === null || typeof value !== 'object';

// The values the leaves state, by field. A field stated twice with different values is left
// unknown: no record holds both, and which one is written last must not decide a grant.
const stated = (pairs: (readonly [string, unknown])[]): Row => {
  const values = new Map<string, unknown>();
  const clashing = new Set<string>();
  for (const [field, value] of pairs) {
    if (values.has(field) && values.get(field) !== value) clashing.add(field);
    values.set(field, value);
  }
  return Object.fromEntries([...values].filter(([field]) => !clashing.has(field)));
};

// why: an object or a list pinned onto a stand-in would be a relation or a list the walk then reads
const pinned = <R extends string>(map: SchemaMap<R>, resource: R, leaves: Leaf[]): Row =>
  stated(
    leaves
      .filter((leaf) => {
        const field = fieldOf(map, resource, leaf.field);
        return (
          leaf.operator === 'equals' &&
          !leaf.field.includes('.') &&
          isScalar(leaf.value) &&
          field?.kind !== 'object' &&
          !field?.isList
        );
      })
      .map((leaf) => [leaf.field, leaf.value] as const),
  );

// The marked fields (`/// @permissions(place: true)`) of the stand-in at `prefix` that a root leaf
// states exactly: `prefix.field equals value`.
const placedMarks = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  prefix: string,
  leaves: Leaf[],
): Row => {
  const marks = marksOf(map, resource);
  if (!marks.size) return {};
  return stated(
    leaves.flatMap((leaf) => {
      const field = leaf.field.slice(prefix.length + 1);
      return leaf.operator === 'equals' &&
        leaf.field.startsWith(`${prefix}.`) &&
        marks.has(field) &&
        isScalar(leaf.value)
        ? [[field, leaf.value] as const]
        : [];
    }),
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
  // why: marks fill a fresh stand-in before its keys, so the path wins and the anchor is never written
  const place = (current: R, segments: string[], prefix: string): Row[] => {
    const [segment, ...rest] = segments;
    if (segment === undefined) return current === anchorResource ? [anchor] : [];
    const relation = relationOf(map, current, segment);
    if (!relation) return [];
    const marks = prefix === '' ? {} : placedMarks(map, current, prefix, leaves);
    return place(relation.resource, rest, prefix === '' ? segment : `${prefix}.${segment}`)
      .flatMap((parent) => step(current, segment, rest, relation, parent, prefix === ''))
      .map((row) => (Object.keys(marks).length ? { ...marks, ...row } : row));
  };
  return withExactStrings(() => place(resource, path.split('.'), ''));
};

/**
 * The pseudo records a grant is checked on: `placeUnder` from the hydrated `anchor` along the entry's
 * path, less the kinds of its first step a root leaf of the `where` (the `where` itself, or a leaf
 * of its top `all`) on the kind field fails, each given the root's exact `equals` values (the path
 * wins over a pinned foreign key). A self anchor is the anchor row itself. Null when the entry
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
  const pins = pinned(map, entry.resource as R, rootLeaves(entry.where));
  const placed = placeUnder(
    map,
    entry.resource as R,
    entry.anchor.path,
    entry.anchor.resource as R,
    anchor,
    entry.where,
  ).map((record) => ({ ...pins, ...record }));
  return placed.length ? placed : null;
};

/**
 * The hydrated rows above the records a granted entry reaches: its anchor row when the entry sits
 * under it by a path, and every row above the anchor. A self-anchored entry's anchor is the
 * granted record itself, so it is left out. The anchor is the object `placed` holds at the end of
 * the entry's path (each step a to-one relation that owns its foreign key), and it must be the
 * entry's anchor (resource and id); the rows above are the objects it holds under such relations,
 * followed up. Membership is object identity, so a row `placeUnder` built below the anchor, an
 * owner it placed beside one, and anything a `where` pins onto the placed record are never in it.
 * Empty when `placed` does not lead to the entry's anchor.
 */
export const rowsAbove = <R extends string>(
  map: SchemaMap<R>,
  entry: EntitlementEntry,
  placed: Row,
): ReadonlySet<Row> => {
  const rows = new Set<Row>();
  let resource = entry.resource as R;
  let anchor = placed;
  for (const segment of entry.anchor.path?.split('.') ?? []) {
    const relation = relationOf(map, resource, segment);
    const parent = anchor[segment] as Row | null | undefined;
    if (!relation || !parent || typeof parent !== 'object' || Array.isArray(parent)) return rows;
    resource = relation.resource;
    anchor = parent;
  }
  if (resource !== entry.anchor.resource || recordId(anchor) !== entry.anchor.id) return rows;
  const climb = (current: R, row: Row) => {
    if (rows.has(row)) return;
    rows.add(row);
    for (const name of relationNames(map, current)) {
      const relation = relationOf(map, current, name);
      const parent = row[name] as Row | null | undefined;
      if (relation && parent && typeof parent === 'object' && !Array.isArray(parent))
        climb(relation.resource, parent);
    }
  };
  climb(resource, anchor);
  if (entry.anchor.path === undefined) rows.delete(anchor);
  return rows;
};
