import { idField } from '../../core/recordId';
import {
  indexMap,
  keysFrom,
  listsOf,
  type Relation,
  relationOf,
  type SchemaMap,
  skipsHydration,
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

type Tree = Map<string, Tree>;

const treeOf = (paths: readonly (readonly string[])[]): Tree => {
  const tree: Tree = new Map();
  for (const path of paths) {
    let at = tree;
    for (const segment of path) {
      const next: Tree = at.get(segment) ?? new Map();
      at.set(segment, next);
      at = next;
    }
  }
  return tree;
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
 * Build a recursive hydrator over a schema map: every to-one relation that owns its foreign key and
 * leads to a resource in the map is loaded and attached, recursively, so the rebac `check` never
 * sees an under-hydrated relation. A missing relation can then only mean the key is null (a real
 * deny), not a loading artifact. Composite keys and non-id targets load by every column the target
 * names. A polymorphic record gets every relation whose columns are set, whatever its kind.
 *
 * The hydrator owns every to-one relation of the model, followed or not: the result holds the row
 * it loaded there, or nothing. A value the record already carried under one (a request body's
 * `conversation: {...}`) is dropped. A relation tagged `/// @permissions(hydrate: false)` (a
 * prisma-map annotation) or one whose key is on the other side is not followed, so it ends empty.
 * A list that is not declared is never crossed by a `rel`, and is left as given.
 *
 * A list relation tagged `/// @permissions(down: [forumUser.fanUser, forumUser.brandUser])` is
 * loaded one jump down wherever its model is hydrated above an item: one `loadMany` by the items'
 * foreign key, replacing whatever the record held under that field (`[]` when the record has no
 * key), then under each item only the declared to-one paths, through `load`, each owned the same
 * way. Nothing else loads from an item or from the rows on those paths: no upward hydration, no
 * second list, and their other to-one relations end empty.
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
  const hydrate = async (
    resource: R,
    record: Row,
    pending: Map<string, Promise<Row | null>> = new Map(),
    ancestors: ReadonlySet<string> = new Set(),
    tree?: Tree,
  ): Promise<Row> => {
    const result: Row = { ...record };
    const fields = map.fieldMap.models[map.resources[resource]]?.fields ?? {};
    const lists = (tree ? [] : listsOf(map, resource)).map(async ([name, list]) => {
      const where = keysFrom(list, record);
      const complete = Object.keys(where).length === list.from.length;
      const items = complete
        ? await (loadMany as NonNullable<typeof loadMany>)(list.resource, where)
        : [];
      const below = treeOf(list.paths);
      result[name] = await Promise.all(
        items.map((item) => hydrate(list.resource, item, pending, ancestors, below)),
      );
    });
    await Promise.all([
      ...lists,
      ...Object.entries(fields).map(async ([name, field]) => {
        // why: a value under a to-one relation is the caller's claim until the hydrator loads it
        if (field.kind === 'object' && !field.isList) delete result[name];
        const below = tree?.get(name);
        if (tree ? !below : skipsHydration(field)) return;
        const relation = relationOf(map, resource, name);
        const where = relation && whereOf(relation, record);
        if (!relation || !where) return;
        const key = keyOf(relation.resource, where);
        // why: a declared path is finite; only upward hydration can loop
        if (!tree && ancestors.has(key)) return;
        const related = await once(relation.resource, where, pending);
        if (related)
          result[name] = await hydrate(
            relation.resource,
            related,
            pending,
            new Set(ancestors).add(key),
            below,
          );
      }),
    ]);
    return result;
  };
  return hydrate;
};
