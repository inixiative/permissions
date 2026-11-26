import { mapNameIsNoName } from '../../core/errors';
import { modelOfResource } from '../../core/resourceNames';
import type { FieldMapsWithPolymorphism } from '../../core/schemaMap';
import type { Row } from '../../core/types';
import { downOf, putDeclaredListsOntoRoots } from './declaredLists';
import {
  type Down,
  type DownPaths,
  type HydrateDeps,
  type HydrationLayer,
  type HydrationRun,
  type Hydrator,
  hydrationLimits,
} from './hydrationRun';
import {
  assertLoadedBatch,
  collectRootLayer,
  groupUnloadedLayerEntries,
  hydrateLayerAndCollectNext,
  linkAllFollowedToOnes,
} from './layer';

export { type Down, type DownPaths, type HydrateDeps, type Hydrator, hydrationLimits };

/** A hydrator that loads every followed to-one of every row and each declared list, layer by layer (README, Helper: hydration). */
export const makeHydrator = <R extends string>({
  mapName,
  fieldMap,
  loadMany,
}: HydrateDeps<R>): Hydrator<R> => {
  if (!mapName || mapName.includes(':')) throw new Error(mapNameIsNoName(mapName));
  const fieldMaps: FieldMapsWithPolymorphism = { fieldMaps: { [mapName]: fieldMap } };

  const loadLayer = async (run: HydrationRun<R>, layer: HydrationLayer<R>): Promise<void> => {
    const batches = groupUnloadedLayerEntries(run, layer);
    if (!batches.length) return;

    await Promise.all(
      batches.map(async ({ resource, entries }) => {
        const wheres = entries.map((entry) => entry.where);
        const loadedRows = await loadMany(resource, wheres, downOf(fieldMaps, resource));
        assertLoadedBatch(resource, loadedRows, entries.length);
        for (const [index, entry] of entries.entries()) {
          run.loadedRows.set(entry.key, loadedRows[index] as Row | null);
        }
      }),
    );
  };

  const hydrateMany = async (resource: R, records: readonly Row[]): Promise<Row[]> => {
    // why: a resource of another map would come back holding whatever rows the caller put on it
    if (!modelOfResource(fieldMaps, resource))
      throw new Error(
        `\`${resource}\` is not a model of the map \`${mapName}\` this hydrator was made for`,
      );
    if (!records.length) return [];

    const run: HydrationRun<R> = {
      loadedRows: new Map(),
      hydratedRows: new Map(),
      rowsLoaded: 0,
      rowLimit: hydrationLimits.loads * records.length,
    };
    const roots = records.map((record) => ({ ...record }));
    const { rootListKeys, layer: firstLayer } = collectRootLayer(fieldMaps, run, resource, roots);

    await loadLayer(run, firstLayer);
    putDeclaredListsOntoRoots(fieldMaps, run, resource, roots, rootListKeys);

    let layer = hydrateLayerAndCollectNext(fieldMaps, run, firstLayer);
    while (layer.size > 0) {
      await loadLayer(run, layer);
      layer = hydrateLayerAndCollectNext(fieldMaps, run, layer);
    }

    linkAllFollowedToOnes(fieldMaps, run, resource, roots);
    return roots;
  };

  const hydrate = async (resource: R, record: Row): Promise<Row> =>
    (await hydrateMany(resource, [record]))[0] as Row;

  return { hydrate, hydrateMany };
};
