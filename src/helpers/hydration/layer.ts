import { hasNoValue, idField } from '../../core/recordId';
import { followedToOneRelationsOf, listsOf, type Relation } from '../../core/relations';
import { identityColumnsOfRow, keyFromResourceAndColumns } from '../../core/rowKeys';
import type { FieldMapsWithPolymorphism } from '../../core/schemaMap';
import type { Row } from '../../core/types';
import { putDeclaredListsOnto } from './declaredLists';
import {
  countRowAgainstBudget,
  type HydrationLayer,
  type HydrationRun,
  isRow,
  type LoadBatch,
} from './hydrationRun';

const whereOf = (relation: Relation, row: Row): Row | null => {
  const where: Row = {};
  for (const [index, column] of relation.from.entries()) {
    const value = row[column];
    if (hasNoValue(value)) return null;
    where[relation.to[index] ?? idField()] = value;
  }
  return where;
};

const batchKeyOf = (resource: string, where: Row): string =>
  `${resource}\u0000${JSON.stringify(Object.keys(where).sort((a, b) => a.localeCompare(b)))}`;

const addToLayer = <R extends string>(
  run: HydrationRun<R>,
  layer: HydrationLayer<R>,
  resource: R,
  where: Row,
  isFollowedToOne: boolean,
): string => {
  const key = keyFromResourceAndColumns(resource, where);
  if (isFollowedToOne && run.hydratedRows.has(key)) return key;
  const existing = layer.get(key);
  if (existing) {
    if (isFollowedToOne) existing.isFollowedToOne = true;
  } else {
    layer.set(key, { resource, where, isFollowedToOne });
  }
  return key;
};

const collectFollowedToOnesIntoLayer = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  layer: HydrationLayer<R>,
  resource: R,
  row: Row,
): void => {
  for (const [, relation] of followedToOneRelationsOf(fieldMaps, resource)) {
    const where = whereOf(relation, row);
    if (where) addToLayer(run, layer, relation.resource as R, where, true);
  }
};

export const collectRootLayer = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  resource: R,
  roots: readonly Row[],
): { rootListKeys: (string | null)[]; layer: HydrationLayer<R> } => {
  const rootHasLists = listsOf(fieldMaps, resource).length > 0;
  const rootListKeys: (string | null)[] = roots.map(() => null);
  const layer: HydrationLayer<R> = new Map();

  for (const [index, root] of roots.entries()) {
    if (rootHasLists) {
      const where = identityColumnsOfRow(fieldMaps, resource, root);
      if (where) rootListKeys[index] = addToLayer(run, layer, resource, where, false);
    }
    collectFollowedToOnesIntoLayer(fieldMaps, run, layer, resource, root);
  }

  return { rootListKeys, layer };
};

export const groupUnloadedLayerEntries = <R extends string>(
  run: HydrationRun<R>,
  layer: HydrationLayer<R>,
): LoadBatch<R>[] => {
  const batches = new Map<string, LoadBatch<R>>();
  for (const [key, entry] of layer) {
    if (run.loadedRows.has(key)) continue;
    countRowAgainstBudget(run, entry.resource);
    const batchKey = batchKeyOf(entry.resource, entry.where);
    let batch = batches.get(batchKey);
    if (!batch) {
      batch = { resource: entry.resource, entries: [] };
      batches.set(batchKey, batch);
    }
    batch.entries.push({ key, where: entry.where });
  }
  return [...batches.values()];
};

export const assertLoadedBatch = (
  resource: string,
  loadedRows: readonly (Row | null)[],
  expectedLength: number,
): void => {
  if (!Array.isArray(loadedRows) || loadedRows.length !== expectedLength)
    throw new Error(
      `\`loadMany\` for \`${resource}\` must return an array matching \`wheres\` (got ${Array.isArray(loadedRows) ? loadedRows.length : typeof loadedRows}, expected ${expectedLength})`,
    );
  for (const entry of loadedRows) {
    if (entry !== null && !isRow(entry))
      throw new Error(
        `\`loadMany\` returned an entry for \`${resource}\` that is not a row or null`,
      );
  }
};

// why: a loaded row becomes one shared object wherever reached, so a loop is the real cyclic graph
export const hydrateLayerAndCollectNext = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  layer: HydrationLayer<R>,
): HydrationLayer<R> => {
  const nextLayer: HydrationLayer<R> = new Map();
  for (const [key, entry] of layer) {
    if (!entry.isFollowedToOne || run.hydratedRows.has(key)) continue;
    const loadedRow = run.loadedRows.get(key) ?? null;
    if (!loadedRow) {
      run.hydratedRows.set(key, null);
      continue;
    }
    const hydratedRow: Row = { ...loadedRow };
    putDeclaredListsOnto(fieldMaps, run, entry.resource, hydratedRow, loadedRow);
    run.hydratedRows.set(key, { resource: entry.resource, row: hydratedRow });
    collectFollowedToOnesIntoLayer(fieldMaps, run, nextLayer, entry.resource, hydratedRow);
  }
  return nextLayer;
};

const linkFollowedToOnes = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  resource: R,
  row: Row,
): void => {
  const followedToOnes = followedToOneRelationsOf(fieldMaps, resource).map(
    ([name, relation]) => [name, relation.resource, whereOf(relation, row)] as const,
  );
  for (const [name, relationResource, where] of followedToOnes) {
    delete row[name];
    if (!where) continue;
    const hydratedRow = run.hydratedRows.get(keyFromResourceAndColumns(relationResource, where));
    if (hydratedRow) row[name] = hydratedRow.row;
  }
};

export const linkAllFollowedToOnes = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: HydrationRun<R>,
  resource: R,
  roots: readonly Row[],
): void => {
  for (const root of roots) linkFollowedToOnes(fieldMaps, run, resource, root);
  for (const hydratedRow of run.hydratedRows.values()) {
    if (hydratedRow) linkFollowedToOnes(fieldMaps, run, hydratedRow.resource, hydratedRow.row);
  }
};
