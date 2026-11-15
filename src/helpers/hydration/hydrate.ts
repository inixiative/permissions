import { idField } from '../../core/recordId';
import {
  indexMap,
  keysFrom,
  type LensNode,
  lensOf,
  type Relation,
  type SchemaMap,
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
    if (value == null || value === '') return null;
    where[relation.to[index] ?? idField()] = value;
  }
  return where;
};

const keyOf = (resource: string, where: Row): string =>
  `${resource}\u0000${JSON.stringify(Object.entries(where).sort(([a], [b]) => a.localeCompare(b)))}`;

/**
 * Build a recursive hydrator over a schema map: it loads exactly the relation lens
 * (`LensNode`), the relations a check reads. Every to-one relation that owns its foreign key,
 * leads to a resource in the map and is not tagged `/// @permissions(hydrate: false)` is loaded
 * and attached, recursively, so a check never sees an under-hydrated relation: a missing one can
 * only mean the key is null (a real deny), not a loading artifact. Composite keys and non-id
 * targets load by every column the target names. A polymorphic record gets every relation whose
 * columns are set, whatever its kind.
 *
 * The hydrator owns what it follows: a followed relation holds the row it loaded, or nothing, so a
 * value the record already carried there (a request body's `conversation: {...}`) is dropped.
 * Anything else is left as given (an undeclared list the app loaded, a relation keyed on the other
 * side); a check never reads it, since it reads the record through the same lens.
 *
 * A list relation tagged `/// @permissions(down: [forumUser.fanUser, forumUser.brandUser])` is
 * loaded one jump down wherever its model is hydrated above an item: one `loadMany` by the items'
 * foreign key, replacing whatever the record held under that field (`[]` when the record has no
 * key), then under each item only the declared to-one paths, through `load`, each owned the same
 * way. Nothing else loads from an item or from the rows on those paths: no upward hydration, no
 * second list.
 *
 * `ancestors`, the records on the path from the root, cuts an edge back to one of them, so
 * hydration terminates on a self-referential key or an A to B to A loop. It is forked per branch, so
 * a parent reached on two paths is hydrated on both; `pending` loads it once.
 */
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
    ancestors: ReadonlySet<string>,
  ): Promise<Row> => {
    const result: Row = { ...record };
    const lists = [...node.lists].map(async ([name, list]) => {
      const where = keysFrom(list, record);
      const complete = Object.keys(where).length === list.from.length;
      const items = complete
        ? await (loadMany as NonNullable<typeof loadMany>)(list.resource, where)
        : [];
      result[name] = await Promise.all(
        items.map((item) => hydrateAt(list.item, item, pending, ancestors)),
      );
    });
    await Promise.all([
      ...lists,
      ...[...node.toOne].map(async ([name, relation]) => {
        delete result[name];
        const where = whereOf(relation, record);
        if (!where) return;
        const key = keyOf(relation.resource, where);
        // why: a declared path is finite; only upward hydration can loop
        if (!node.down && ancestors.has(key)) return;
        const related = await once(relation.resource, where, pending);
        if (related)
          result[name] = await hydrateAt(
            node.below(name),
            related,
            pending,
            new Set(ancestors).add(key),
          );
      }),
    ]);
    return result;
  };
  return (resource: R, record: Row): Promise<Row> =>
    hydrateAt(lensOf(map, resource), record, new Map(), new Set());
};
