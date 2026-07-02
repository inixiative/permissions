import type { Row } from './types';

/**
 * A to-one, FK-owning parent relation to follow when hydrating a record's ownership closure:
 * `field` is the property to attach the loaded parent under, `model` is the parent's model, and
 * `fk` is the scalar field on the source row holding the parent's id. Derive the set once from your
 * schema (e.g. the to-one, FK-owning relations in an `@inixiative/prisma-map` model map).
 */
export type ParentRelation = { field: string; model: string; fk: string };

export type HydrateDeps = {
  /** The to-one ownership-closure relations to follow for a model (FK-owning, non-list). */
  parents: (model: string) => readonly ParentRelation[];
  /**
   * Load one record by model + id. This is the cache seam — wrap it with your own store (e.g.
   * Redis); the hydrator only de-duplicates concurrent loads *within a single hydration*, it does
   * not cache across calls.
   */
  load: (model: string, id: string) => Promise<Row | null>;
};

/**
 * Build a recursive hydrator bound to a schema (`parents`) and a loader (`load`) — the same
 * injected-seam shape as {@link import('./check').createRebacCheck}.
 *
 * Walks a record's to-one ownership closure and attaches each loaded parent, recursively, so the
 * rebac `check` never sees an under-hydrated relation: a missing relation can then only mean the FK
 * is null (a real deny), not a loading artifact. Concurrent loads of the same `model:id` within one
 * hydration are de-duplicated via the shared `pending` map; cross-call caching is `load`'s job.
 *
 * FK-to-one parent graphs are *usually* acyclic, but real data can lie (a self-referential
 * `managerId = id`, or an A→B→A loop). `ancestors` — the `model:id` keys on the path from the root
 * to the current node — cuts any edge that points back at an ancestor, so hydration always
 * terminates. The set is forked per branch (like the `check` engine's `visited`) so a legitimate
 * diamond — the same parent reached via two non-ancestor paths — is still fully hydrated on both.
 */
export const createHydrator = ({ parents, load }: HydrateDeps) => {
  const hydrate = async (
    model: string,
    record: Row,
    pending: Map<string, Promise<Row | null>> = new Map(),
    ancestors: ReadonlySet<string> = new Set(),
  ): Promise<Row> => {
    const result: Row = { ...record };
    await Promise.all(
      parents(model).map(async ({ field, model: parentModel, fk }) => {
        const id = record[fk] as string | undefined;
        if (!id) return;
        const key = `${parentModel}:${id}`;
        if (ancestors.has(key)) return; // cycle: this parent is already on the path from the root
        let load$ = pending.get(key);
        if (!load$) {
          load$ = load(parentModel, id);
          pending.set(key, load$);
        }
        const related = await load$;
        if (related) {
          result[field] = await hydrate(parentModel, related, pending, new Set(ancestors).add(key));
        }
      }),
    );
    return result;
  };
  return hydrate;
};
