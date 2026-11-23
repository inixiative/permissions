import { createHydrator, type HydrateDeps } from '../index';
import { idField } from '../src/core/recordId';
import { listsOf, relationOf, type SpelledRelationTree } from '../src/core/relations';
import { keysFrom } from '../src/core/rowKeys';
import type { Row } from '../src/core/types';

/** A hydrator whose `load` brings a declared list by one read of the items, then one read per row under each. */
export const createHydratorReadingEachRowThroughLoad = <R extends string>({
  map,
  load,
  loadItems,
}: {
  map: HydrateDeps<R>['map'];
  load: (resource: R, where: Row) => Promise<Row | null>;
  loadItems: (itemResource: R, where: Row) => Promise<Row[]>;
}) => {
  const rowWithDeclaredPaths = async (
    resource: R,
    row: Row,
    tree: SpelledRelationTree,
  ): Promise<Row> => {
    const result: Row = { ...row };
    await Promise.all(
      Object.entries(tree).map(async ([name, below]) => {
        delete result[name];
        const relation = relationOf(map, resource, name);
        if (!relation) return;
        const key = Object.fromEntries(
          relation.from.map((column, index) => [relation.to[index] ?? idField(), row[column]]),
        );
        if (Object.values(key).some((value) => value === null || value === undefined)) return;
        const stored = await load(relation.resource, key);
        if (stored)
          result[name] = await rowWithDeclaredPaths(
            relation.resource,
            stored,
            (below.relations ?? {}) as SpelledRelationTree,
          );
      }),
    );
    return result;
  };
  return createHydrator<R>({
    map,
    load: async (resource, where) => {
      const row = await load(resource, where);
      if (!row) return null;
      const result: Row = { ...row };
      for (const [name, list] of listsOf(map, resource)) {
        const itemsWhere = keysFrom(list, row);
        const items =
          Object.keys(itemsWhere).length === list.from.length
            ? await loadItems(list.resource, itemsWhere)
            : [];
        result[name] = await Promise.all(
          items.map((item) => rowWithDeclaredPaths(list.resource, item, list.down)),
        );
      }
      return result;
    },
  });
};
