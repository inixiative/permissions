import { type Relation, relationOf, type SchemaMap } from '../../core/schemaMap';
import type { Row } from '../../core/types';

/**
 * What the hydrator needs: the schema map the checks walk, and `load`, one read of a `resource`'s
 * record by its target columns (`{ id }`, or every column of a composite key). `load` is the cache
 * seam; the hydrator only de-duplicates loads within one hydration.
 */
export type HydrateDeps<R extends string = string> = {
  map: SchemaMap<R>;
  load: (resource: R, where: Row) => Promise<Row | null>;
};

type Annotated = { annotations?: { permissions?: { hydrate?: boolean } } };

const skipsHydration = (field: unknown): boolean =>
  (field as Annotated | undefined)?.annotations?.permissions?.hydrate === false;

const whereOf = (relation: Relation, record: Row): Row | null => {
  const where: Row = {};
  for (const [index, column] of relation.from.entries()) {
    const value = record[column];
    if (value == null || value === '') return null;
    where[relation.to[index] ?? 'id'] = value;
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
 * A relation tagged `/// @permissions(hydrate: false)` (a prisma-map annotation) is not followed.
 *
 * `ancestors`, the records on the path from the root, cuts an edge back to one of them, so
 * hydration terminates on a self-referential key or an A to B to A loop. It is forked per branch, so
 * a parent reached on two paths is hydrated on both; `pending` loads it once.
 */
export const createHydrator = <R extends string>({ map, load }: HydrateDeps<R>) => {
  const hydrate = async (
    resource: R,
    record: Row,
    pending: Map<string, Promise<Row | null>> = new Map(),
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<Row> => {
    const result: Row = { ...record };
    const fields = map.fieldMap.models[map.resources[resource]]?.fields ?? {};
    await Promise.all(
      Object.entries(fields).map(async ([name, field]) => {
        if (skipsHydration(field)) return;
        const relation = relationOf(map, resource, name);
        if (!relation) return;
        const where = whereOf(relation, record);
        if (!where) return;
        const key = keyOf(relation.resource, where);
        if (ancestors.has(key)) return;
        let loading = pending.get(key);
        if (!loading) {
          loading = load(relation.resource, where);
          pending.set(key, loading);
        }
        const related = await loading;
        if (related)
          result[name] = await hydrate(
            relation.resource,
            related,
            pending,
            new Set(ancestors).add(key),
          );
      }),
    );
    return result;
  };
  return hydrate;
};
