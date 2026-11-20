import { modelOf } from '@inixiative/field-map';
import { hasNoValue, idField } from '../../core/recordId';
import {
  followedToOneRelationsOf,
  identityColumnsOfRow,
  keyFromResourceAndColumns,
  listsOf,
  type Relation,
  relationOf,
  type SchemaMap,
  type SpelledRelationTree,
} from '../../core/schemaMap';
import type { Row } from '../../core/types';

/** One list a resource declares `/// @permissions(down: [...])`, as `load` is asked to bring it. */
export type DeclaredListToLoad<R extends string = string> = {
  /** The resource of the list's items. */
  itemResource: R;
  /** The declared paths under an item (`down`), as a tree of relation names. */
  down: SpelledRelationTree;
};

/** The lists the resource being loaded declares, by list field name; empty when it declares none. */
export type DeclaredListsByFieldName<R extends string = string> = Record<
  string,
  DeclaredListToLoad<R>
>;

/**
 * What the hydrator needs: the schema map the checks walk, and `load`, one read of a `resource`'s
 * record by its target columns (`{ id }` — `permissions.idField` — or every column of a composite key),
 * with the lists that resource declares. `load` is the cache seam; the hydrator only de-duplicates
 * loads within one hydration.
 *
 * `declaredLists` is what an include is built from: for each list the resource declares, the row
 * comes back holding every live item under the list's field name, each item holding the row on
 * every declared path under it. A truncated list silently denies real members, and a removed row
 * left in admits one. The hydrator reads nothing more under an item, and keeps of each item only
 * its columns and the declared paths.
 */
export type HydrateDeps<R extends string = string> = {
  map: SchemaMap<R>;
  load: (
    resource: R,
    where: Row,
    declaredLists: DeclaredListsByFieldName<R>,
  ) => Promise<Row | null>;
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

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The most rows one hydration takes in (each `load`, each item of a list and each row under it, counted wherever it appears) before it throws. */
export const hydrationLimits = { loads: 10_000 };

type Run = {
  raw: Map<string, Promise<Row | null>>;
  rows: Map<string, Promise<Row | null>>;
  work: Promise<void>[];
  loads: number;
};

/** A hydrator that loads every to-one of every row, and each declared list (README, Helper: hydration). */
export const createHydrator = <R extends string>({ map, load }: HydrateDeps<R>) => {
  const countLoadAgainstBudget = (run: Run, resource: R) => {
    if (++run.loads > hydrationLimits.loads)
      throw new Error(
        `hydrating reached \`${resource}\` past ${hydrationLimits.loads} rows: a walk that large is not a permission walk`,
      );
  };
  const listsLoadMustBringFor = (resource: R): DeclaredListsByFieldName<R> =>
    Object.fromEntries(
      listsOf(map, resource).map(([name, list]) => [
        name,
        { itemResource: list.resource, down: list.down },
      ]),
    );
  const loadOnce = (run: Run, resource: R, where: Row): Promise<Row | null> => {
    const key = keyFromResourceAndColumns(resource, where);
    let loading = run.raw.get(key);
    if (!loading) {
      countLoadAgainstBudget(run, resource);
      loading = load(resource, where, listsLoadMustBringFor(resource));
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
          if (object && stored) {
            putDeclaredListsOnto(run, relation.resource, object, stored);
            await loadFollowedToOnesOnto(run, relation.resource, object, stored);
          }
        })(),
      );
    }
    return row;
  };
  // why: a list is taken only from a row `load` returned, never from the record a caller passed
  const putDeclaredListsOnto = (run: Run, resource: R, result: Row, stored: Row | null): void => {
    for (const [name, list] of listsOf(map, resource)) {
      const items = stored ? stored[name] : [];
      if (!Array.isArray(items))
        throw new Error(
          `\`load\` returned a \`${resource}\` without its declared list \`${name}\`: bring every list in \`declaredLists\` (a row cached before the list was declared has none)`,
        );
      result[name] = items.map((item) => {
        if (!isRow(item))
          throw new Error(`\`load\` returned an item of \`${resource}.${name}\` that is not a row`);
        return countThenCopyRowKeepingOnlyDeclaredPaths(run, list.resource, item, list.down);
      });
    }
  };
  // why: read by the row's own key, the one a to-one reaching it uses, so one row is one read
  const loadOwnStoredRowForItsDeclaredLists = async (
    run: Run,
    resource: R,
    record: Row,
  ): Promise<Row | null> => {
    if (!listsOf(map, resource).length) return null;
    const where = identityColumnsOfRow(map as SchemaMap, resource, record);
    return where ? loadOnce(run, resource, where) : null;
  };
  const loadFollowedToOnesOnto = async (
    run: Run,
    resource: R,
    result: Row,
    record: Row,
  ): Promise<void> => {
    await Promise.all(
      followedToOneRelationsOf(map, resource).map(async ([name, relation]) => {
        delete result[name];
        const where = whereOf(relation, record);
        const row = where && (await storedRowAsOneSharedObject(run, relation, where));
        if (row) result[name] = row;
      }),
    );
  };
  // why: under an item only the declared paths exist, taken as `load` returned them and never linked
  const countThenCopyRowKeepingOnlyDeclaredPaths = (
    run: Run,
    resource: R,
    row: Row,
    tree: SpelledRelationTree,
  ): Row => {
    countLoadAgainstBudget(run, resource);
    const result: Row = { ...row };
    for (const [name, field] of Object.entries(
      modelOf(map.fieldMap, map.resources[resource])?.fields ?? {},
    ))
      if (field.kind === 'object') delete result[name];
    for (const [name, below] of Object.entries(tree)) {
      const relation = relationOf(map, resource, name);
      const held = row[name];
      if (relation && isRow(held))
        result[name] = countThenCopyRowKeepingOnlyDeclaredPaths(
          run,
          relation.resource,
          held,
          (below.relations ?? {}) as SpelledRelationTree,
        );
    }
    return result;
  };
  return async (resource: R, record: Row): Promise<Row> => {
    const run: Run = { raw: new Map(), rows: new Map(), work: [], loads: 0 };
    const result: Row = { ...record };
    const [ownStoredRow] = await Promise.all([
      loadOwnStoredRowForItsDeclaredLists(run, resource, record),
      loadFollowedToOnesOnto(run, resource, result, record),
    ]);
    putDeclaredListsOnto(run, resource, result, ownStoredRow);
    while (run.work.length) await Promise.all(run.work.splice(0));
    return result;
  };
};
