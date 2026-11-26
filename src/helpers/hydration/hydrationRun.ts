import type { FieldMap } from '@inixiative/field-map';
import type { Row } from '../../core/types';

/** The declared paths under a list item, as nested relation names; a leaf is `{}`. */
export type DownPaths = { [relation: string]: DownPaths };

/** What a resource declares `/// @permissions(down: [...])`: its declared lists by list field name, each with the paths under an item; `{}` when it declares none. */
export type Down = { [listField: string]: DownPaths };

/**
 * What the hydrator needs: one field map with its name (`db`), and `loadMany`, one batched read
 * of a `resource`'s (`db:Model`) records by their target columns (`[{ id }, …]` — `permissions.idField` —
 * or every column of a composite key), with the lists that resource declares. Every `where` in one
 * `loadMany` call shares the same column names and is deduplicated within a layer. Return an array
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

/** The most rows one record's hydration takes in (each loaded row, each item of a list and each row under it, counted wherever it appears) before it throws; `hydrateMany` scales by `records.length`. */
export const hydrationLimits = { loads: 10_000 };

export type LayerEntry<R extends string> = {
  resource: R;
  where: Row;
  /** True when a followed to-one points here (needs a shared object in `hydratedRows`); false when loaded only for a root record's declared lists. */
  isFollowedToOne: boolean;
};

export type HydrationLayer<R extends string> = Map<string, LayerEntry<R>>;

export type LoadBatch<R extends string> = {
  resource: R;
  entries: { key: string; where: Row }[];
};

export type HydratedRow<R extends string> = {
  resource: R;
  row: Row;
};

export type HydrationRun<R extends string> = {
  loadedRows: Map<string, Row | null>;
  hydratedRows: Map<string, HydratedRow<R> | null>;
  rowsLoaded: number;
  rowLimit: number;
};

export const isRow = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const countRowAgainstBudget = <R extends string>(
  run: HydrationRun<R>,
  resource: R,
): void => {
  if (++run.rowsLoaded > run.rowLimit)
    throw new Error(
      `hydrating reached \`${resource}\` past ${run.rowLimit} rows: a walk that large is not a permission walk`,
    );
};
