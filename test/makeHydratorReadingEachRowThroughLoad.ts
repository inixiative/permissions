import { makeHydrator, type SchemaMap } from '../index';
import { idField } from '../src/core/recordId';
import { listsOf, relationOf, type SpelledRelationTree } from '../src/core/relations';
import { keysFrom } from '../src/core/rowKeys';
import type { Row } from '../src/core/types';
import { dbFieldMapOf } from './schemaMaps';

/** A hydrator whose `load` brings a declared list by one read of the items, then one read per row under each. */
export const makeHydratorReadingEachRowThroughLoad = <R extends string>({
  schemaMap,
  load,
  loadItems,
}: {
  schemaMap: Pick<SchemaMap, 'fieldMaps'>;
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
        const relation = relationOf(schemaMap, resource, name);
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
  return makeHydrator<R>({
    ...dbFieldMapOf(schemaMap),
    loadMany: async (resource, wheres) =>
      Promise.all(
        wheres.map(async (where) => {
          const row = await load(resource, where);
          if (!row) return null;
          const result: Row = { ...row };
          for (const [name, list] of listsOf(schemaMap, resource)) {
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
        }),
      ),
  }).hydrate;
};
