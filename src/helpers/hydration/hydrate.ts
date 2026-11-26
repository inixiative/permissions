import type { FieldMap } from '@inixiative/field-map';
import { mapNameIsNoName } from '../../core/errors';
import { hasNoValue, idField } from '../../core/recordId';
import {
  followedToOneRelationsOf,
  listsOf,
  type Relation,
  relationOf,
  type SpelledRelationTree,
} from '../../core/relations';
import { modelOfResource } from '../../core/resourceNames';
import { identityColumnsOfRow, keyFromResourceAndColumns } from '../../core/rowKeys';
import type { FieldMapsWithPolymorphism } from '../../core/schemaMap';
import type { Row } from '../../core/types';

/** The declared paths under a list item, as nested relation names; a leaf is `{}`. */
export type DownPaths = { [relation: string]: DownPaths };

/** What a resource declares `/// @permissions(down: [...])`: its declared lists by list field name, each with the paths under an item; `{}` when it declares none. */
export type Down = { [listField: string]: DownPaths };

/**
 * What the hydrator needs: one field map with its name (`db`), and `loadMany`, one batched read
 * of a `resource`'s (`db:Model`) records by their target columns (`[{ id }, …]` — `permissions.idField` —
 * or every column of a composite key), with the lists that resource declares. Every `where` in one
 * `loadMany` call shares the same column names and is deduplicated within a wave. Return an array
 * of the same length and order as `wheres`, with `null` where no record exists. `loadMany` is the
 * cache seam; the hydrator walks the relation graph layer by layer and deduplicates loads across
 * the whole hydration (and across every record of `hydrateMany`).
 *
 * `down` says what each row must come back holding: under each declared list's field name every
 * item, and on each item the row on every declared path under it. How it is read is the app's
 * (`prismaIncludeOfDown` turns it into a Prisma `include`). A truncated list silently denies real
 * members. The hydrator reads nothing more under an item, and keeps of each item only its columns
 * and the declared paths.
 */
export type HydrateDeps<R extends string = string> = {
  mapName: string;
  fieldMap: FieldMap;
  loadMany: (resource: R, wheres: readonly Row[], down: Down) => Promise<readonly (Row | null)[]>;
};

export type Hydrator<R extends string = string> = {
  hydrate: (resource: R, record: Row) => Promise<Row>;
  hydrateMany: (resource: R, records: readonly Row[]) => Promise<Row[]>;
};

/** The most rows one record's hydration takes in (each fetched row, each item of a list and each row under it, counted wherever it appears) before it throws; `hydrateMany` scales by `records.length`. */
export const hydrationLimits = { loads: 10_000 };

type WaveEntry<R extends string> = {
  resource: R;
  where: Row;
  /** True when a followed to-one points here (needs a shared object in `run.rows`); false when fetched only for a root record's declared lists. */
  isRelationTarget: boolean;
};

type Wave<R extends string> = Map<string, WaveEntry<R>>;

type FetchGroup<R extends string> = {
  resource: R;
  entries: { key: string; where: Row }[];
};

type MaterializedRow<R extends string> = {
  resource: R;
  result: Row;
};

type Run<R extends string> = {
  raw: Map<string, Row | null>;
  rows: Map<string, MaterializedRow<R> | null>;
  loads: number;
  limit: number;
};

const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const whereOf = (relation: Relation, record: Row): Row | null => {
  const where: Row = {};
  for (const [index, column] of relation.from.entries()) {
    const value = record[column];
    if (hasNoValue(value)) return null;
    where[relation.to[index] ?? idField()] = value;
  }
  return where;
};

const columnsSignatureOf = (resource: string, where: Row): string =>
  `${resource}\u0000${JSON.stringify(Object.keys(where).sort((a, b) => a.localeCompare(b)))}`;

const countLoadAgainstBudget = <R extends string>(run: Run<R>, resource: R): void => {
  if (++run.loads > run.limit)
    throw new Error(
      `hydrating reached \`${resource}\` past ${run.limit} rows: a walk that large is not a permission walk`,
    );
};

const downPathsOf = (tree: SpelledRelationTree): DownPaths => {
  const paths: DownPaths = {};
  for (const [name, below] of Object.entries(tree))
    paths[name] = downPathsOf((below.relations ?? {}) as SpelledRelationTree);
  return paths;
};

const downOf = <R extends string>(fieldMaps: FieldMapsWithPolymorphism, resource: R): Down => {
  const down: Down = {};
  for (const [name, list] of listsOf(fieldMaps, resource)) down[name] = downPathsOf(list.down);
  return down;
};

// why: under an item only the declared paths exist, taken as `loadMany` returned them and never linked
const copyRowKeepingOnlyDownPaths = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  resource: R,
  row: Row,
  tree: SpelledRelationTree,
): Row => {
  countLoadAgainstBudget(run, resource);
  const result: Row = { ...row };
  for (const [name, field] of Object.entries(modelOfResource(fieldMaps, resource)?.fields ?? {}))
    if (field.kind === 'object') delete result[name];
  for (const [name, below] of Object.entries(tree)) {
    const relation = relationOf(fieldMaps, resource, name);
    const held = row[name];
    if (relation && isRow(held))
      result[name] = copyRowKeepingOnlyDownPaths(
        fieldMaps,
        run,
        relation.resource as R,
        held,
        (below.relations ?? {}) as SpelledRelationTree,
      );
  }
  return result;
};

// why: a list is taken only from a row `loadMany` returned, never from the record a caller passed
const putDeclaredListsOnto = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  resource: R,
  result: Row,
  stored: Row | null,
): void => {
  for (const [name, list] of listsOf(fieldMaps, resource)) {
    const items = stored ? stored[name] : [];
    if (!Array.isArray(items))
      throw new Error(
        `\`loadMany\` returned a \`${resource}\` without its declared list \`${name}\`: bring every list in \`down\` (a row cached before the list was declared has none)`,
      );
    result[name] = items.map((item) => {
      if (!isRow(item))
        throw new Error(
          `\`loadMany\` returned an item of \`${resource}.${name}\` that is not a row`,
        );
      return copyRowKeepingOnlyDownPaths(fieldMaps, run, list.resource as R, item, list.down);
    });
  }
};

const addToWave = <R extends string>(
  run: Run<R>,
  wave: Wave<R>,
  resource: R,
  where: Row,
  isRelationTarget: boolean,
): string => {
  const key = keyFromResourceAndColumns(resource, where);
  if (isRelationTarget && run.rows.has(key)) return key;
  const existing = wave.get(key);
  if (existing) {
    if (isRelationTarget) existing.isRelationTarget = true;
  } else {
    wave.set(key, { resource, where, isRelationTarget });
  }
  return key;
};

const collectFollowedToOnesIntoWave = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  wave: Wave<R>,
  resource: R,
  row: Row,
): void => {
  for (const [, relation] of followedToOneRelationsOf(fieldMaps, resource)) {
    const where = whereOf(relation, row);
    if (where) addToWave(run, wave, relation.resource as R, where, true);
  }
};

const collectRootWave = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  resource: R,
  roots: readonly Row[],
): { rootListKeys: (string | null)[]; wave: Wave<R> } => {
  const rootHasLists = listsOf(fieldMaps, resource).length > 0;
  const rootListKeys: (string | null)[] = roots.map(() => null);
  const wave: Wave<R> = new Map();

  for (const [index, root] of roots.entries()) {
    if (rootHasLists) {
      const where = identityColumnsOfRow(fieldMaps, resource, root);
      if (where) rootListKeys[index] = addToWave(run, wave, resource, where, false);
    }
    collectFollowedToOnesIntoWave(fieldMaps, run, wave, resource, root);
  }

  return { rootListKeys, wave };
};

const groupUnfetchedWaveEntries = <R extends string>(
  run: Run<R>,
  wave: Wave<R>,
): FetchGroup<R>[] => {
  const groups = new Map<string, FetchGroup<R>>();
  for (const [key, entry] of wave) {
    if (run.raw.has(key)) continue;
    countLoadAgainstBudget(run, entry.resource);
    const signature = columnsSignatureOf(entry.resource, entry.where);
    let group = groups.get(signature);
    if (!group) {
      group = { resource: entry.resource, entries: [] };
      groups.set(signature, group);
    }
    group.entries.push({ key, where: entry.where });
  }
  return [...groups.values()];
};

const assertLoadedBatch = (
  resource: string,
  loaded: readonly (Row | null)[],
  expectedLength: number,
): void => {
  if (!Array.isArray(loaded) || loaded.length !== expectedLength)
    throw new Error(
      `\`loadMany\` for \`${resource}\` must return an array matching \`wheres\` (got ${Array.isArray(loaded) ? loaded.length : typeof loaded}, expected ${expectedLength})`,
    );
  for (const row of loaded) {
    if (row !== null && !isRow(row))
      throw new Error(
        `\`loadMany\` returned an item for \`${resource}\` that is not a row or null`,
      );
  }
};

const linkFollowedToOnes = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  resource: R,
  result: Row,
): void => {
  const targets = followedToOneRelationsOf(fieldMaps, resource).map(
    ([name, relation]) => [name, relation.resource, whereOf(relation, result)] as const,
  );
  for (const [name, targetResource, where] of targets) {
    delete result[name];
    if (!where) continue;
    const linked = run.rows.get(keyFromResourceAndColumns(targetResource, where));
    if (linked) result[name] = linked.result;
  }
};

const linkAllFollowedToOnes = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  resource: R,
  roots: readonly Row[],
): void => {
  for (const root of roots) linkFollowedToOnes(fieldMaps, run, resource, root);
  for (const materialized of run.rows.values()) {
    if (materialized)
      linkFollowedToOnes(fieldMaps, run, materialized.resource, materialized.result);
  }
};

const attachRootDeclaredLists = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  resource: R,
  roots: readonly Row[],
  rootListKeys: readonly (string | null)[],
): void => {
  if (!listsOf(fieldMaps, resource).length) return;
  for (const [index, root] of roots.entries()) {
    const key = rootListKeys[index];
    const stored = key ? (run.raw.get(key) ?? null) : null;
    putDeclaredListsOnto(fieldMaps, run, resource, root, stored);
  }
};

// why: a stored row is one shared object wherever reached, so a loop is the real cyclic graph
const materializeWaveAndCollectNext = <R extends string>(
  fieldMaps: FieldMapsWithPolymorphism,
  run: Run<R>,
  wave: Wave<R>,
): Wave<R> => {
  const nextWave: Wave<R> = new Map();
  for (const [key, entry] of wave) {
    if (!entry.isRelationTarget || run.rows.has(key)) continue;
    const stored = run.raw.get(key) ?? null;
    if (!stored) {
      run.rows.set(key, null);
      continue;
    }
    const result: Row = { ...stored };
    putDeclaredListsOnto(fieldMaps, run, entry.resource, result, stored);
    run.rows.set(key, { resource: entry.resource, result });
    collectFollowedToOnesIntoWave(fieldMaps, run, nextWave, entry.resource, result);
  }
  return nextWave;
};

/** A hydrator that loads every to-one of every row and each declared list, layer by layer (README, Helper: hydration). */
export const makeHydrator = <R extends string>({
  mapName,
  fieldMap,
  loadMany,
}: HydrateDeps<R>): Hydrator<R> => {
  if (!mapName || mapName.includes(':')) throw new Error(mapNameIsNoName(mapName));
  const fieldMaps: FieldMapsWithPolymorphism = { fieldMaps: { [mapName]: fieldMap } };

  const fetchWave = async (run: Run<R>, wave: Wave<R>): Promise<void> => {
    const groups = groupUnfetchedWaveEntries(run, wave);
    if (!groups.length) return;

    await Promise.all(
      groups.map(async ({ resource, entries }) => {
        const wheres = entries.map((entry) => entry.where);
        const loaded = await loadMany(resource, wheres, downOf(fieldMaps, resource));
        assertLoadedBatch(resource, loaded, entries.length);
        for (const [index, entry] of entries.entries()) {
          run.raw.set(entry.key, loaded[index] as Row | null);
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

    const run: Run<R> = {
      raw: new Map(),
      rows: new Map(),
      loads: 0,
      limit: hydrationLimits.loads * records.length,
    };
    const roots = records.map((record) => ({ ...record }));
    const { rootListKeys, wave: firstWave } = collectRootWave(fieldMaps, run, resource, roots);

    await fetchWave(run, firstWave);
    attachRootDeclaredLists(fieldMaps, run, resource, roots, rootListKeys);

    let wave = materializeWaveAndCollectNext(fieldMaps, run, firstWave);
    while (wave.size > 0) {
      await fetchWave(run, wave);
      wave = materializeWaveAndCollectNext(fieldMaps, run, wave);
    }

    linkAllFollowedToOnes(fieldMaps, run, resource, roots);
    return roots;
  };

  const hydrate = async (resource: R, record: Row): Promise<Row> =>
    (await hydrateMany(resource, [record]))[0] as Row;

  return { hydrate, hydrateMany };
};
