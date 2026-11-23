import {
  type FieldEntry,
  type FieldMap,
  fieldOf,
  hasColumn,
  isScalarField,
  type ModelEntry,
  modelOf,
  own,
  type RelationField,
} from '@inixiative/field-map';
import {
  type Bridge,
  type Condition,
  check as checkRule,
  endpointKey,
  type LensNarrowing,
  type ModelNarrowing,
  parseEndpointKey,
  relationTargetOf,
} from '@inixiative/json-rules';
import { omit } from 'lodash-es';
import { entitlementProblem } from './entitlementProblem';
import { withExactStrings } from './exactStrings';
import type { EntitlementEntry } from './permix';
import { hasNoValue, idField, recordId } from './recordId';
import type { Anchor, ResourcePermission, Row } from './types';

/** A polymorphic model's discriminator: `field` names the kind, `fkMap` the columns each kind carries. */
export type PolymorphicAxis = { field: string; fkMap: Partial<Record<string, readonly string[]>> };

/** Polymorphic models by model name, in the shape of a false-polymorphism registry. */
export type Polymorphism = Partial<Record<string, { axes: readonly PolymorphicAxis[] }>>;

/**
 * The map before it has rules: what the rule builders and every reader of the data shape take.
 * `maps` are the field maps (`@inixiative/field-map`) of the records the app loads and walks,
 * `supplied` those whose rows each check is given in its `data` (who is acting, for one), both by
 * map name; `bridges` are json-rules bridges between their models; `polymorphism` says, by map name
 * then model, which kind a relation makes a polymorphic record. A model goes by `map:Model`
 * everywhere (`db:Inquiry`, `actor:User`): json-rules' endpoint key, the model spelled as its field
 * map spells it.
 */
export type SchemaMapWithoutPermissions = {
  maps: Record<string, FieldMap>;
  supplied?: Record<string, FieldMap>;
  bridges?: Bridge[];
  polymorphism?: Partial<Record<string, Polymorphism>>;
};

/** The schema the checks walk: the data shape and the rules, by resource (`map:Model`). Indexed once per map object. */
export type SchemaMap<R extends string = string> = SchemaMapWithoutPermissions & {
  permissions: Partial<Record<R, ResourcePermission>>;
};

const whyNameHasNoMap = (name: string): string | null =>
  name.includes(':') ? null : `\`${name}\` names no map: a resource is \`map:Model\``;

/** The map and model a name holds (`db:Inquiry`); a name with no map throws. */
export const mapAndModelNamed = (name: string): { mapName: string; modelName: string } => {
  const why = whyNameHasNoMap(name);
  if (why) throw new Error(why);
  return parseEndpointKey(name, '');
};

/** Whether `mapName` is one of the map's supplied maps, whose rows a check is given. */
export const isSuppliedMap = (map: SchemaMapWithoutPermissions, mapName: string): boolean =>
  Object.hasOwn(map.supplied ?? {}, mapName);

/** The field map a record's resource is in, or undefined when its map is not in `maps`. */
export const fieldMapOfResource = (
  map: SchemaMapWithoutPermissions,
  resource: string,
): FieldMap | undefined => own(map.maps, parseEndpointKey(resource, '').mapName);

/** A record's model entry, or undefined when the map has no field map or no such model for it. */
export const modelOfResource = (
  map: SchemaMapWithoutPermissions,
  resource: string,
): ModelEntry | undefined => {
  const fieldMap = fieldMapOfResource(map, resource);
  return fieldMap ? modelOf(fieldMap, parseEndpointKey(resource, '').modelName) : undefined;
};

/** A field of a record's model. */
export const fieldOfResource = (
  map: SchemaMapWithoutPermissions,
  resource: string,
  name: string,
): FieldEntry | undefined => {
  const fieldMap = fieldMapOfResource(map, resource);
  return fieldMap ? fieldOf(fieldMap, parseEndpointKey(resource, '').modelName, name) : undefined;
};

/** Why `name` is not a resource of the map, or null: it names no map, or a model its map (in `maps` or `supplied`) does not have. A map in neither is not judged here. */
export const whyNameIsNoModel = (map: SchemaMapWithoutPermissions, name: string): string | null => {
  const { mapName, modelName } = parseEndpointKey(name, '');
  const fieldMap = fieldMapOfResource(map, name) ?? own(map.supplied ?? {}, mapName);
  return (
    whyNameHasNoMap(name) ??
    (fieldMap && !modelOf(fieldMap, modelName)
      ? `\`${name}\` is not a model of the map \`${mapName}\``
      : null)
  );
};

/** The resource a relation field of `resource` leads to (json-rules' `relationTargetOf`, named `map:Model`). */
const resourceLedToBy = (resource: string, field: RelationField): string => {
  const led = relationTargetOf(field, parseEndpointKey(resource, '').mapName);
  return endpointKey({ fieldMap: led?.mapName ?? '', model: led?.modelName ?? field.type });
};

const axesOfResource = (
  map: SchemaMapWithoutPermissions,
  resource: string,
): readonly PolymorphicAxis[] => {
  const { mapName, modelName } = parseEndpointKey(resource, '');
  return map.polymorphism?.[mapName]?.[modelName]?.axes ?? [];
};

/** Every model of the given field maps, named `map:Model`. */
export const modelsNamedIn = (
  maps: Record<string, { readonly models: Readonly<Record<string, unknown>> }>,
): string[] =>
  Object.entries(maps).flatMap(([fieldMap, { models }]) =>
    Object.keys(models).map((model) => endpointKey({ fieldMap, model })),
  );

/** A to-one relation the hydrator follows: where it leads, its key, and on a polymorphic record the kinds it admits. */
export type Relation<R extends string = string> = {
  resource: R;
  from: readonly string[];
  to: readonly string[];
  kinds: { field: string; values: string[] } | null;
};

/** A tree of relations in json-rules' spelling (`{ org: { relations: { creator: { relations: {} } } } }`). */
export type SpelledRelationTree = Record<string, ModelNarrowing>;

/** A list declared `/// @permissions(down: [...])`: the items' resource, their key back to the parent, and the declared paths. */
export type ListRelation<R extends string = string> = {
  resource: R;
  from: readonly string[];
  to: readonly string[];
  down: SpelledRelationTree;
};

type MapIndex = {
  relations: Map<string, Relation | string>;
  lists: Map<string, ListRelation>;
  marks: Map<string, ReadonlySet<string>>;
  toOnes: Map<string, [string, Relation][]>;
  idColumns: Map<string, readonly string[]>;
  lenses: Map<string, LensNarrowing | null>;
  lensSizes: Map<string, number>;
};

/** A field's `/// @permissions(...)` annotation, as field-map carries it. */
const permissionsAnnotation = (field: FieldEntry | undefined) => field?.annotations?.permissions;

const skipsHydration = (field: FieldEntry | undefined): boolean =>
  permissionsAnnotation(field)?.hydrate === false;

const annotationKeys = ['hydrate', 'down', 'place'];
const placeableTypes = ['String', 'Int', 'Boolean'];
const dottedPath = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/;

const indexes = new WeakMap<SchemaMapWithoutPermissions, MapIndex>();

export const indexMap = (map: SchemaMapWithoutPermissions): MapIndex => {
  const known = indexes.get(map);
  if (known) return known;
  for (const mapName of [...Object.keys(map.maps), ...Object.keys(map.supplied ?? {})])
    if (!mapName || mapName.includes(':'))
      throw new Error(
        `a map is named \`${mapName}\`: a map's name is the part of \`map:Model\` before the colon`,
      );
  for (const [mapName, models] of Object.entries(map.polymorphism ?? {})) {
    const fieldMap = own(map.maps, mapName);
    if (!fieldMap)
      throw new Error(
        `\`polymorphism\` names the map \`${mapName}\`, which is not in \`maps\`: it is keyed by map name, then model`,
      );
    for (const model of Object.keys(models ?? {}))
      if (!modelOf(fieldMap, model))
        throw new Error(
          `\`polymorphism\` names \`${endpointKey({ fieldMap: mapName, model })}\`, which is not a model of the map \`${mapName}\``,
        );
  }
  for (const mapName of Object.keys(map.maps))
    if (isSuppliedMap(map, mapName))
      throw new Error(
        `\`${mapName}\` is in both \`maps\` and \`supplied\`: a map is one or the other`,
      );
  const index: MapIndex = {
    relations: new Map<string, Relation | string>(),
    lists: new Map(),
    marks: new Map(),
    toOnes: new Map(),
    idColumns: new Map(),
    lenses: new Map(),
    lensSizes: new Map(),
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

// why: field-map keeps a malformed annotation value without complaint, so every one is read strictly here
const indexAnnotations = (map: SchemaMapWithoutPermissions, index: MapIndex) => {
  for (const resource of modelsNamedIn(map.maps)) {
    const model = mapAndModelNamed(resource).modelName;
    const fields = modelOfResource(map, resource)?.fields ?? {};
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
        const problem = placeProblem(map, resource, fields, name, field, annotation.place);
        if (problem) throw new Error(`${at}: \`place\` ${problem}`);
        marks.add(name);
      }
    }
    if (marks.size) index.marks.set(resource, marks);
  }
};

const placeProblem = (
  map: SchemaMapWithoutPermissions,
  resource: string,
  fields: ModelEntry['fields'],
  name: string,
  field: FieldEntry,
  value: unknown,
) => {
  if (value !== true) return 'is true or absent';
  if (!hasColumn(field)) return 'marks a scalar or enum field';
  if (field.isList) return 'never marks a list';
  if ((isScalarField(field) && field.isId) || name === idField()) return 'never marks an id';
  if (
    Object.values(fields).some(
      (other) => other.kind === 'object' && other.fromFields?.includes(name),
    )
  )
    return 'never marks a relation key: the path sets it';
  if (axesOfResource(map, resource).some((axis) => axis.field === name))
    return 'never marks a discriminator: the path sets the kind';
  if (field.kind === 'scalar' && !placeableTypes.includes(field.type))
    return `marks String, Int, Boolean or an enum, not ${field.type}`;
  return null;
};

const listFor = (
  map: SchemaMapWithoutPermissions,
  resource: string,
  name: string,
  down: unknown,
): ListRelation => {
  const model = mapAndModelNamed(resource).modelName;
  const at = `${model}.${name} @permissions`;
  const field = fieldOfResource(map, resource, name);
  if (field?.kind !== 'object' || !field.isList)
    throw new Error(`${at}: \`down\` sits on a list relation`);
  const item = resourceLedToBy(resource, field);
  if (!modelOfResource(map, item))
    throw new Error(`${at}: ${field.type} is not a model of its map`);
  const back = Object.entries(modelOfResource(map, item)?.fields ?? {}).filter(
    (entry): entry is [string, RelationField] => {
      const other = entry[1];
      return (
        other.kind === 'object' &&
        !other.isList &&
        other.type === model &&
        Boolean(other.fromFields?.length) &&
        (!field.relationName || !other.relationName || other.relationName === field.relationName)
      );
    },
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
  const tree: SpelledRelationTree = {};
  for (const path of (down as string[]).map((dotted) => dotted.split('.'))) {
    let branch = tree;
    let current = item;
    for (const [depth, segment] of path.entries()) {
      const relation = followedToOneRelationOrWhyNot(map, current, segment);
      if (typeof relation === 'string')
        throw new Error(`${at}: \`${path.join('.')}\`: ${relation}`);
      if (depth === 0 && segment === inverse[0])
        throw new Error(`${at}: \`${path.join('.')}\` goes back up the list it came down`);
      const next: ModelNarrowing = branch[segment] ?? { relations: {} };
      branch[segment] = next;
      branch = next.relations as SpelledRelationTree;
      current = relation.resource;
    }
  }
  return {
    resource: item,
    from: inverse[1].fromFields ?? [],
    to: inverse[1].toFields ?? [],
    down: tree,
  };
};

/** The declared list `segment` of `resource`, or null: an undeclared list is never crossed. */
export const listOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  segment: string,
): ListRelation<R> | null =>
  (indexMap(map).lists.get(`${resource}\u0000${segment}`) as ListRelation<R> | undefined) ?? null;

/** The declared lists of `resource`, by field name. */
export const listsOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
): [string, ListRelation<R>][] =>
  [...indexMap(map).lists].flatMap(([key, list]) => {
    const [of, name] = key.split('\u0000') as [string, string];
    return of === resource ? [[name, list as ListRelation<R>] as [string, ListRelation<R>]] : [];
  });

const marksOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
): ReadonlySet<string> => indexMap(map).marks.get(resource) ?? new Set();

const kindsOf = (axes: readonly PolymorphicAxis[], columns: readonly string[]) => {
  for (const axis of axes) {
    const values = Object.entries(axis.fkMap)
      .filter(([, fks]) => fks?.length && columns.every((column) => fks.includes(column)))
      .map(([value]) => value);
    if (values.length) return { field: axis.field, values };
  }
  return null;
};

/** `segment` of `resource` as a relation the hydrator follows, or why it is not one. */
export const followedToOneRelationOrWhyNot = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  segment: string,
): Relation<R> | string => {
  const cache = indexMap(map).relations;
  const key = `${resource}\u0000${segment}`;
  if (!cache.has(key)) cache.set(key, toOneFor(map, resource, segment));
  return cache.get(key) as Relation<R> | string;
};

export const relationOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  segment: string,
): Relation<R> | null => {
  const relation = followedToOneRelationOrWhyNot(map, resource, segment);
  return typeof relation === 'string' ? null : relation;
};

const toOneFor = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  segment: string,
): Relation<R> | string => {
  const field = fieldOfResource(map, resource, segment);
  const at = `\`${resource}.${segment}\``;
  if (field?.kind !== 'object' || field.isList) return `${at} is not a to-one relation`;
  const led = resourceLedToBy(resource, field);
  if (skipsHydration(field))
    return `${at} is \`hydrate: false\`: nothing loads it; drop the annotation or read it from \`${led}\``;
  if (!field.fromFields?.length)
    return `${at} keeps its foreign key on \`${led}\`: nothing loads it; write the rule on \`${led}\`, or hold the key on this model`;
  if (!modelOfResource(map, led))
    return `${at} leads to \`${led}\`, which is not a model of its map: nothing loads it`;
  const axes = axesOfResource(map, resource);
  return {
    resource: led as R,
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

// why: a field stated twice with different values is unknown, so conjunct order never decides a grant
const statedAt = (leaves: Leaf[], prefix: string, accepts: (field: string) => boolean): Row => {
  const values = new Map<string, unknown>();
  const clashing = new Set<string>();
  for (const leaf of leaves) {
    if (leaf.operator !== 'equals' || !isScalar(leaf.value) || !leaf.field.startsWith(prefix))
      continue;
    const field = leaf.field.slice(prefix.length);
    if (!accepts(field)) continue;
    if (values.has(field) && values.get(field) !== leaf.value) clashing.add(field);
    values.set(field, leaf.value);
  }
  return Object.fromEntries([...values].filter(([field]) => !clashing.has(field)));
};

// why: an object or a list pinned onto a stand-in would be a relation or a list the walk then reads
const pinned = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  leaves: Leaf[],
): Row =>
  statedAt(leaves, '', (name) => {
    const field = fieldOfResource(map, resource, name);
    return !name.includes('.') && (!field || (hasColumn(field) && !field.isList));
  });

const admits = (leaves: Leaf[], field: string, value: string) =>
  leaves.every(
    (leaf) => leaf.field !== field || checkRule(leaf as Condition, { [field]: value }) === true,
  );

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
  map: SchemaMapWithoutPermissions,
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
  map: SchemaMapWithoutPermissions,
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

/** `resource`'s polymorphic axis on `field`, from `map.polymorphism`. */
export const axisOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  field: string,
): PolymorphicAxis | undefined =>
  axesOfResource(map, resource).find((axis) => axis.field === field);

/** Every to-one relation of `resource` the hydrator follows, by field name. */
export const followedToOneRelationsOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
): [string, Relation<R>][] => {
  const { toOnes } = indexMap(map);
  if (!toOnes.has(resource))
    toOnes.set(
      resource,
      Object.keys(modelOfResource(map, resource)?.fields ?? {}).flatMap((name) => {
        const relation = relationOf(map, resource, name);
        return relation ? [[name, relation] as [string, Relation]] : [];
      }),
    );
  return toOnes.get(resource) as [string, Relation<R>][];
};

export const ownerRelationOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  field: string,
  value: string,
): string | undefined => {
  const columns = [...(axisOf(map, resource, field)?.fkMap[value] ?? [])].sort().join(',');
  return followedToOneRelationsOf(map, resource).find(
    ([, relation]) => [...relation.from].sort().join(',') === columns,
  )?.[0];
};

/** The rows `segments` reaches from `row` by followed to-ones, start included; it stops at a missing one (with `kinds`, a kind its step does not admit). */
export const rowsAlongAnchorPath = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  row: Row,
  segments: readonly string[],
  kinds = false,
): { resource: R; row: Row }[] => {
  const steps = [{ resource, row }];
  for (const segment of segments) {
    const { resource: current, row: at } = steps[steps.length - 1] as { resource: R; row: Row };
    const relation = relationOf(map, current, segment);
    const next = at[segment];
    if (!relation || !next || typeof next !== 'object' || Array.isArray(next)) break;
    if (
      kinds &&
      relation.kinds &&
      !relation.kinds.values.includes(at[relation.kinds.field] as string)
    )
      break;
    steps.push({ resource: relation.resource, row: next as Row });
  }
  return steps;
};

/** The row `anchor` names, when `row`'s path along `anchor.path` reaches it (with `kinds`, each step one its relation admits); else undefined. */
export const anchorRowReachedFrom = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  row: Row,
  anchor: Anchor,
  kinds = false,
  field = idField(),
): Row | undefined => {
  const segments = anchor.path?.split('.') ?? [];
  const end = rowsAlongAnchorPath(map, resource, row, segments, kinds)[segments.length];
  return end?.resource === anchor.resource && recordId(end.row, field) === anchor.id
    ? end.row
    : undefined;
};

const chainOf = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  row: Row,
  segments: string[],
): Map<R, Row> =>
  new Map(
    rowsAlongAnchorPath(map, resource, row, segments).map((step) => [step.resource, step.row]),
  );

const placeTowards = <R extends string>(
  map: SchemaMapWithoutPermissions,
  resource: R,
  chain: ReadonlyMap<R, Row>,
  depth: number,
  seen: ReadonlySet<R>,
): Row | null => {
  const row: Row = {};
  let reached = false;
  for (const [name, relation] of followedToOneRelationsOf(map, resource)) {
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

/** The stand-in records of `resource` under the hydrated `anchor` along `path`, one per polymorphic kind the path admits (README, Granting one). */
export const placeUnder = <R extends string>(
  map: SchemaMapWithoutPermissions,
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
    const marked = marksOf(map, current);
    const marks = prefix === '' ? {} : statedAt(leaves, `${prefix}.`, (name) => marked.has(name));
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
 * wins over a pinned foreign key), and never its own key: a stand-in is not a row that is there, so
 * a rule that asks its key to exist fails on it. A self anchor is the anchor row itself. Null when the entry
 * is malformed (the rules `setup` applies), the anchor is not the entry's, or the path reaches
 * nothing; the writer must pass on every record.
 */
export const placeEntitlement = <R extends string>(
  map: SchemaMapWithoutPermissions,
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
  ).map((record) => omit({ ...pins, ...record }, idField()));
  return placed.length ? placed : null;
};

/** The hydrated rows above the records a granted entry reaches, by object; a self-anchored entry's own anchor left out. */
export const rowsAbove = <R extends string>(
  map: SchemaMapWithoutPermissions,
  entry: EntitlementEntry,
  placed: Row,
): ReadonlySet<Row> => {
  const rows = new Set<Row>();
  const anchorRow = anchorRowReachedFrom(map, entry.resource as R, placed, entry.anchor);
  if (!anchorRow) return rows;
  const climb = (current: R, row: Row) => {
    if (rows.has(row)) return;
    rows.add(row);
    for (const [name, relation] of followedToOneRelationsOf(map, current)) {
      const parent = row[name] as Row | null | undefined;
      if (parent && typeof parent === 'object' && !Array.isArray(parent))
        climb(relation.resource, parent);
    }
  };
  climb(entry.anchor.resource as R, anchorRow);
  if (entry.anchor.path === undefined) rows.delete(anchorRow);
  return rows;
};
