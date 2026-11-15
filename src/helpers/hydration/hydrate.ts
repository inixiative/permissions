import { type LensNode, lensOf } from '../../core/lens';
import { idField } from '../../core/recordId';
import { indexMap, keysFrom, type Relation, type SchemaMap } from '../../core/schemaMap';
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
    if (value == null || value === '') return null;
    where[relation.to[index] ?? idField()] = value;
  }
  return where;
};

const keyOf = (resource: string, where: Row): string =>
  `${resource}\u0000${JSON.stringify(Object.entries(where).sort(([a], [b]) => a.localeCompare(b)))}`;

/** A hydrator that loads the relation lens of a record, owning what it follows (README, Helper: hydration). */
export const createHydrator = <R extends string>({ map, load, loadMany }: HydrateDeps<R>) => {
  if (indexMap(map as SchemaMap).lists.size && !loadMany)
    throw new Error('the map declares a list (`@permissions(down: ...)`): pass `loadMany`');
  const once = (
    resource: R,
    where: Row,
    pending: Map<string, Promise<Row | null>>,
  ): Promise<Row | null> => {
    const key = keyOf(resource, where);
    let loading = pending.get(key);
    if (!loading) {
      loading = load(resource, where);
      pending.set(key, loading);
    }
    return loading;
  };
  const hydrateAt = async (
    node: LensNode<R>,
    record: Row,
    pending: Map<string, Promise<Row | null>>,
    ancestors: ReadonlyMap<string, Row>,
    key?: string,
  ): Promise<Row> => {
    const result: Row = { ...record };
    const above = key ? new Map(ancestors).set(key, result) : ancestors;
    const lists = [...node.lists].map(async ([name, list]) => {
      const where = keysFrom(list, record);
      const complete = Object.keys(where).length === list.from.length;
      const items = complete
        ? await (loadMany as NonNullable<typeof loadMany>)(list.resource, where)
        : [];
      result[name] = await Promise.all(
        items.map((item) => hydrateAt(list.item, item, pending, above)),
      );
    });
    await Promise.all([
      ...lists,
      ...[...node.toOne].map(async ([name, relation]) => {
        delete result[name];
        const where = whereOf(relation, record);
        if (!where) return;
        const at = keyOf(relation.resource, where);
        // why: a row already above on this path is that same object here, so the record is the real cyclic graph
        const ancestor = above.get(at);
        if (ancestor) {
          result[name] = ancestor;
          return;
        }
        const related = await once(relation.resource, where, pending);
        if (related) result[name] = await hydrateAt(node.below(name), related, pending, above, at);
      }),
    ]);
    return result;
  };
  return (resource: R, record: Row): Promise<Row> => {
    const id = record[idField()];
    const key = id == null || id === '' ? undefined : keyOf(resource, { [idField()]: id });
    return hydrateAt(lensOf(map, resource), record, new Map(), new Map(), key);
  };
};
