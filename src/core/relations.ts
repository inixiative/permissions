import type { RelationField } from '@inixiative/field-map';
import type { LensNarrowing, ModelNarrowing } from '@inixiative/json-rules';
import {
  annotationKeys,
  dottedPath,
  permissionsAnnotation,
  skipsHydration,
  whyFieldTakesNoPlaceMark,
} from './permissionsAnnotation';
import {
  axesOfResource,
  axisOf,
  fieldOfResource,
  mapAndModelNamed,
  modelOfResource,
  modelsNamedIn,
  resourceLedToBy,
} from './resourceNames';
import type { PolymorphicAxis, SchemaMap } from './schemaMap';
import { problemsOfMapNames } from './validateSchemaMap';

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

const indexes = new WeakMap<SchemaMap, MapIndex>();

export const indexMap = (map: SchemaMap): MapIndex => {
  const known = indexes.get(map);
  if (known) return known;
  const [problem] = problemsOfMapNames(map);
  if (problem) throw new Error(problem);
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
const indexAnnotations = (map: SchemaMap, index: MapIndex) => {
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
        const problem = whyFieldTakesNoPlaceMark(map, resource, name, annotation.place);
        if (problem) throw new Error(`${at}: \`place\` ${problem}`);
        marks.add(name);
      }
    }
    if (marks.size) index.marks.set(resource, marks);
  }
};

const listFor = (map: SchemaMap, resource: string, name: string, down: unknown): ListRelation => {
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
  map: SchemaMap,
  resource: R,
  segment: string,
): ListRelation<R> | null =>
  (indexMap(map).lists.get(`${resource}\u0000${segment}`) as ListRelation<R> | undefined) ?? null;

/** The declared lists of `resource`, by field name. */
export const listsOf = <R extends string>(
  map: SchemaMap,
  resource: R,
): [string, ListRelation<R>][] =>
  [...indexMap(map).lists].flatMap(([key, list]) => {
    const [of, name] = key.split('\u0000') as [string, string];
    return of === resource ? [[name, list as ListRelation<R>] as [string, ListRelation<R>]] : [];
  });

export const marksOf = <R extends string>(map: SchemaMap, resource: R): ReadonlySet<string> =>
  indexMap(map).marks.get(resource) ?? new Set();

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
  map: SchemaMap,
  resource: R,
  segment: string,
): Relation<R> | string => {
  const cache = indexMap(map).relations;
  const key = `${resource}\u0000${segment}`;
  if (!cache.has(key)) cache.set(key, toOneFor(map, resource, segment));
  return cache.get(key) as Relation<R> | string;
};

export const relationOf = <R extends string>(
  map: SchemaMap,
  resource: R,
  segment: string,
): Relation<R> | null => {
  const relation = followedToOneRelationOrWhyNot(map, resource, segment);
  return typeof relation === 'string' ? null : relation;
};

const toOneFor = <R extends string>(
  map: SchemaMap,
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

/** Every to-one relation of `resource` the hydrator follows, by field name. */
export const followedToOneRelationsOf = <R extends string>(
  map: SchemaMap,
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
  map: SchemaMap,
  resource: R,
  field: string,
  value: string,
): string | undefined => {
  const columns = [...(axisOf(map, resource, field)?.fkMap[value] ?? [])].sort().join(',');
  return followedToOneRelationsOf(map, resource).find(
    ([, relation]) => [...relation.from].sort().join(',') === columns,
  )?.[0];
};
