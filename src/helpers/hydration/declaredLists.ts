import { listsOf, relationOf, type SpelledRelationTree } from '../../core/relations';
import { modelOfResource } from '../../core/resourceNames';
import type { FieldMapsWithPolymorphism } from '../../core/schemaMap';
import type { Row } from '../../core/types';
import {
  countRowAgainstBudget,
  type Down,
  type DownPaths,
  type HydrationRun,
  isRow,
} from './hydrationRun';

const downPathsOf = (tree: SpelledRelationTree): DownPaths => {
  const paths: DownPaths = {};
  for (const [name, below] of Object.entries(tree))
    paths[name] = downPathsOf((below.relations ?? {}) as SpelledRelationTree);
  return paths;
};

export const downOf = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  resource: R,
): Down => {
  const down: Down = {};
  for (const [name, list] of listsOf(fieldMaps, resource)) down[name] = downPathsOf(list.down);
  return down;
};

// why: under an item only the declared paths exist, taken as `loadMany` returned them and never linked
const copyRowKeepingOnlyDownPaths = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  resource: R,
  row: Row,
  tree: SpelledRelationTree,
): Row => {
  countRowAgainstBudget(run, resource);
  const copy: Row = { ...row };
  for (const [name, field] of Object.entries(modelOfResource(fieldMaps, resource)?.fields ?? {}))
    if (field.kind === 'object') delete copy[name];
  for (const [name, below] of Object.entries(tree)) {
    const relation = relationOf(fieldMaps, resource, name);
    const held = row[name];
    if (relation && isRow(held))
      copy[name] = copyRowKeepingOnlyDownPaths(
        fieldMaps,
        run,
        relation.resource as R,
        held,
        (below.relations ?? {}) as SpelledRelationTree,
      );
  }
  return copy;
};

// why: a list is taken only from a row `loadMany` returned, never from the record a caller passed
export const putDeclaredListsOnto = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  resource: R,
  row: Row,
  loadedRow: Row | null,
): void => {
  for (const [name, list] of listsOf(fieldMaps, resource)) {
    const items = loadedRow ? loadedRow[name] : [];
    if (!Array.isArray(items))
      throw new Error(
        `\`loadMany\` returned a \`${resource}\` without its declared list \`${name}\`: bring every list in \`down\` (a row cached before the list was declared has none)`,
      );
    row[name] = items.map((item) => {
      if (!isRow(item))
        throw new Error(
          `\`loadMany\` returned an item of \`${resource}.${name}\` that is not a row`,
        );
      return copyRowKeepingOnlyDownPaths(fieldMaps, run, list.resource as R, item, list.down);
    });
  }
};

export const putDeclaredListsOntoRoots = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  resource: R,
  roots: readonly Row[],
  rootListKeys: readonly (string | null)[],
): void => {
  if (!listsOf(fieldMaps, resource).length) return;
  for (const [index, root] of roots.entries()) {
    const key = rootListKeys[index];
    const loadedRow = key ? (run.loadedRows.get(key) ?? null) : null;
    putDeclaredListsOnto(fieldMaps, run, resource, root, loadedRow);
  }
};
