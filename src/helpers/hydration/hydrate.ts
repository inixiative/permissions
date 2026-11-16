import { hasNoValue, idField } from '../../core/recordId';
import {
  followedToOneRelationsOf,
  indexMap,
  keyFromResourceAndColumns,
  keysFrom,
  listsOf,
  type Relation,
  relationOf,
  type SchemaMap,
  type SpelledRelationTree,
} from '../../core/schemaMap';
import type { Row } from '../../core/types';
/**
 * What the hydrator needs: the schema map the checks walk, and `load`, one read of a `resource`'s
 * record by its target columns (`{ id }` — `permissions.idField` — or every column of a composite key). `load` is the cache
 * seam; the hydrator only de-duplicates loads within one hydration.
 */
export type HydrateDeps<R extends string = string> = {
  map: SchemaMap<R>;
  load: (resource: R, where: Row) => Promise<Row | null>;
  /**
   * One read of the rows of `resource` whose columns equal `where` (the items' foreign key back to
   * their parent): the items of a list declared `/// @permissions(down: [...])`. Required when the
   * map declares one. Return every row, or throw: a truncated list silently denies real members.
   */
  loadMany?: (resource: R, where: Row) => Promise<Row[]>;
};

const whereOf = (relation: Relation, record: Row): Row | null => {
  const where: Row = {};
  for (const [index, column] of relation.from.entries()) {
    const value = record[column];
    if (hasNoValue(value)) return null;
    where[relation.to[index] ?? idField()] = value;
  }
  return where;
};

/** The most `load`/`loadMany` calls one hydration makes before it throws. */
export const hydrationLimits = { loads: 10_000 };

type Run = {
  raw: Map<string, Promise<Row | null>>;
  rows: Map<string, Promise<Row | null>>;
  work: Promise<void>[];
  loads: number;
};

/** A hydrator that loads every to-one of every row, and each declared list (README, Helper: hydration). */
export const createHydrator = <R extends string>({ map, load, loadMany }: HydrateDeps<R>) => {
  if (indexMap(map as SchemaMap).lists.size && !loadMany)
    throw new Error('the map declares a list (`@permissions(down: ...)`): pass `loadMany`');
  const countLoadAgainstBudget = (run: Run, resource: R) => {
    if (++run.loads > hydrationLimits.loads)
      throw new Error(
        `hydrating \`${resource}\` passed ${hydrationLimits.loads} loads: a chain that long is not a permission walk`,
      );
  };
  const loadOnce = (run: Run, resource: R, where: Row): Promise<Row | null> => {
    const key = keyFromResourceAndColumns(resource, where);
    let loading = run.raw.get(key);
    if (!loading) {
      countLoadAgainstBudget(run, resource);
      loading = load(resource, where);
      run.raw.set(key, loading);
    }
    return loading;
  };
  // why: a row stored once is one object wherever it is reached, so a loop is the real cyclic graph
  const storedRowAsOneSharedObject = (
    run: Run,
    relation: Relation<R>,
    where: Row,
  ): Promise<Row | null> => {
    const key = keyFromResourceAndColumns(relation.resource, where);
    let row = run.rows.get(key);
    if (!row) {
      let resolve: (value: Row | null) => void = () => {};
      row = new Promise((done) => {
        resolve = done;
      });
      run.rows.set(key, row);
      run.work.push(
        (async () => {
          const stored = await loadOnce(run, relation.resource, where);
          const object = stored ? { ...stored } : null;
          resolve(object);
          if (object && stored)
            await loadFollowedRelationsOnto(run, relation.resource, object, stored);
        })(),
      );
    }
    return row;
  };
  const loadFollowedRelationsOnto = async (
    run: Run,
    resource: R,
    result: Row,
    record: Row,
  ): Promise<void> => {
    const lists = listsOf(map, resource).map(async ([name, list]) => {
      const where = keysFrom(list, record);
      const complete = Object.keys(where).length === list.from.length;
      if (complete) countLoadAgainstBudget(run, list.resource);
      const items = complete
        ? await (loadMany as NonNullable<typeof loadMany>)(list.resource, where)
        : [];
      result[name] = await Promise.all(
        items.map((item) =>
          loadOnlyDeclaredPathsUnderListItem(run, list.resource, item, list.down),
        ),
      );
    });
    await Promise.all([
      ...lists,
      ...followedToOneRelationsOf(map, resource).map(async ([name, relation]) => {
        delete result[name];
        const where = whereOf(relation, record);
        const row = where && (await storedRowAsOneSharedObject(run, relation, where));
        if (row) result[name] = row;
      }),
    ]);
  };
  // why: under an item only the declared paths exist, loaded as written and never linked
  const loadOnlyDeclaredPathsUnderListItem = async (
    run: Run,
    resource: R,
    record: Row,
    tree: SpelledRelationTree,
  ): Promise<Row> => {
    const result: Row = { ...record };
    for (const [name, field] of Object.entries(
      map.fieldMap.models[map.resources[resource]]?.fields ?? {},
    ))
      if (field.kind === 'object' || field.kind === 'bridge') delete result[name];
    await Promise.all(
      Object.entries(tree).map(async ([name, below]) => {
        delete result[name];
        const relation = relationOf(map, resource, name);
        const where = relation && whereOf(relation, record);
        const stored = where && relation && (await loadOnce(run, relation.resource, where));
        if (stored && relation)
          result[name] = await loadOnlyDeclaredPathsUnderListItem(
            run,
            relation.resource,
            stored,
            (below.relations ?? {}) as SpelledRelationTree,
          );
      }),
    );
    return result;
  };
  return async (resource: R, record: Row): Promise<Row> => {
    const run: Run = { raw: new Map(), rows: new Map(), work: [], loads: 0 };
    const result: Row = { ...record };
    await loadFollowedRelationsOnto(run, resource, result, record);
    while (run.work.length) await Promise.all(run.work.splice(0));
    return result;
  };
};
