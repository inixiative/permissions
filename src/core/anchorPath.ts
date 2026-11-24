import type { EntitlementEntry } from './permix';
import { idField, recordId } from './recordId';
import { followedToOneRelationsOf, relationOf } from './relations';
import type { ResolvedSchemaMap } from './schemaMap';
import type { Anchor, Row } from './types';

/** The rows `segments` reaches from `row` by followed to-ones, start included; it stops at a missing one (with `kinds`, a kind its step does not admit). */
export const rowsAlongAnchorPath = <R extends string>(
  schemaMap: ResolvedSchemaMap,
  resource: R,
  row: Row,
  segments: readonly string[],
  kinds = false,
): { resource: R; row: Row }[] => {
  const steps = [{ resource, row }];
  for (const segment of segments) {
    const { resource: current, row: at } = steps[steps.length - 1] as { resource: R; row: Row };
    const relation = relationOf(schemaMap, current, segment);
    const next = at[segment];
    if (!relation || !next || typeof next !== 'object' || Array.isArray(next)) break;
    if (
      kinds &&
      relation.kinds &&
      !relation.kinds.values.includes(at[relation.kinds.field] as string)
    )
      break;
    steps.push({ resource: relation.resource, row: next as Row });
  }
  return steps;
};

/** The row `anchor` names, when `row`'s path along `anchor.path` reaches it (with `kinds`, each step one its relation admits); else undefined. */
export const anchorRowReachedFrom = <R extends string>(
  schemaMap: ResolvedSchemaMap,
  resource: R,
  row: Row,
  anchor: Anchor,
  kinds = false,
  field = idField(),
): Row | undefined => {
  const segments = anchor.path?.split('.') ?? [];
  const end = rowsAlongAnchorPath(schemaMap, resource, row, segments, kinds)[segments.length];
  return end?.resource === anchor.resource && recordId(end.row, field) === anchor.id
    ? end.row
    : undefined;
};

/** The hydrated rows above the records a granted entry reaches, by object; a self-anchored entry's own anchor left out. */
export const rowsAbove = <R extends string>(
  schemaMap: ResolvedSchemaMap,
  entry: EntitlementEntry,
  pseudoRecord: Row,
): ReadonlySet<Row> => {
  const rows = new Set<Row>();
  const anchorRow = anchorRowReachedFrom(
    schemaMap,
    entry.resource as R,
    pseudoRecord,
    entry.anchor,
  );
  if (!anchorRow) return rows;
  const climb = (current: R, row: Row) => {
    if (rows.has(row)) return;
    rows.add(row);
    for (const [name, relation] of followedToOneRelationsOf(schemaMap, current)) {
      const parent = row[name] as Row | null | undefined;
      if (parent && typeof parent === 'object' && !Array.isArray(parent))
        climb(relation.resource, parent);
    }
  };
  climb(entry.anchor.resource as R, anchorRow);
  if (entry.anchor.path === undefined) rows.delete(anchorRow);
  return rows;
};
