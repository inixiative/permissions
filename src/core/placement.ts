import { hasColumn } from '@inixiative/field-map';
import { type Condition, check as checkRule } from '@inixiative/json-rules';
import { omit } from 'lodash-es';
import { entitlementProblem } from './entitlementProblem';
import { withExactStrings } from './exactStrings';
import type { EntitlementEntry } from './permix';
import { idField, recordId } from './recordId';
import {
  followedToOneRelationsOf,
  marksOf,
  ownerRelationOf,
  type Relation,
  relationOf,
} from './relations';
import { fieldOfResource } from './resourceNames';
import { keysFrom } from './rowKeys';
import type { SchemaMap } from './schemaMap';
import type { Anchor, Row } from './types';
import { type Leaf, rootLeaves } from './whereConjuncts';

const isScalar = (value: unknown) => value === null || typeof value !== 'object';

// why: a field stated twice with different values is unknown, so conjunct order never decides a grant
const statedAt = (leaves: Leaf[], prefix: string, accepts: (field: string) => boolean): Row => {
  const values = new Map<string, unknown>();
  const clashing = new Set<string>();
  for (const leaf of leaves) {
    if (leaf.operator !== 'equals' || !isScalar(leaf.value) || !leaf.field.startsWith(prefix))
      continue;
    const field = leaf.field.slice(prefix.length);
    if (!accepts(field)) continue;
    if (values.has(field) && values.get(field) !== leaf.value) clashing.add(field);
    values.set(field, leaf.value);
  }
  return Object.fromEntries([...values].filter(([field]) => !clashing.has(field)));
};

// why: an object or a list pinned onto a stand-in would be a relation or a list the walk then reads
const pinned = <R extends string>(map: SchemaMap, resource: R, leaves: Leaf[]): Row =>
  statedAt(leaves, '', (name) => {
    const field = fieldOfResource(map, resource, name);
    return !name.includes('.') && (!field || (hasColumn(field) && !field.isList));
  });

const admits = (leaves: Leaf[], field: string, value: string) =>
  leaves.every(
    (leaf) => leaf.field !== field || checkRule(leaf as Condition, { [field]: value }) === true,
  );

/** The rows `segments` reaches from `row` by followed to-ones, start included; it stops at a missing one (with `kinds`, a kind its step does not admit). */
export const rowsAlongAnchorPath = <R extends string>(
  map: SchemaMap,
  resource: R,
  row: Row,
  segments: readonly string[],
  kinds = false,
): { resource: R; row: Row }[] => {
  const steps = [{ resource, row }];
  for (const segment of segments) {
    const { resource: current, row: at } = steps[steps.length - 1] as { resource: R; row: Row };
    const relation = relationOf(map, current, segment);
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
  map: SchemaMap,
  resource: R,
  row: Row,
  anchor: Anchor,
  kinds = false,
  field = idField(),
): Row | undefined => {
  const segments = anchor.path?.split('.') ?? [];
  const end = rowsAlongAnchorPath(map, resource, row, segments, kinds)[segments.length];
  return end?.resource === anchor.resource && recordId(end.row, field) === anchor.id
    ? end.row
    : undefined;
};

const chainOf = <R extends string>(
  map: SchemaMap,
  resource: R,
  row: Row,
  segments: string[],
): Map<R, Row> =>
  new Map(
    rowsAlongAnchorPath(map, resource, row, segments).map((step) => [step.resource, step.row]),
  );

const placeTowards = <R extends string>(
  map: SchemaMap,
  resource: R,
  chain: ReadonlyMap<R, Row>,
  depth: number,
  seen: ReadonlySet<R>,
): Row | null => {
  const row: Row = {};
  let reached = false;
  for (const [name, relation] of followedToOneRelationsOf(map, resource)) {
    const parent =
      chain.get(relation.resource) ??
      (depth > 1 && !seen.has(relation.resource)
        ? placeTowards(map, relation.resource, chain, depth - 1, new Set([...seen, resource]))
        : null);
    if (!parent) continue;
    Object.assign(row, keysFrom(relation, parent), { [name]: parent });
    reached = true;
  }
  return reached ? row : null;
};

/** The stand-in records of `resource` under the hydrated `anchor` along `path`, one per polymorphic kind the path admits (README, Granting one). */
export const placeUnder = <R extends string>(
  map: SchemaMap,
  resource: R,
  path: string,
  anchorResource: R,
  anchor: Row,
  where?: Condition,
): Row[] => {
  const leaves = rootLeaves(where);
  const step = (
    current: R,
    segment: string,
    rest: string[],
    relation: Relation<R>,
    parent: Row,
    top: boolean,
  ): Row[] => {
    const base: Row = { ...keysFrom(relation, parent), [segment]: parent };
    if (!relation.kinds) return [base];
    const { field, values } = relation.kinds;
    return values
      .filter((value) => !top || admits(leaves, field, value))
      .flatMap((value) => {
        const row: Row = { ...base, [field]: value };
        const ownerName = ownerRelationOf(map, current, field, value);
        if (!ownerName || ownerName === segment) return [row];
        const ownerRelation = relationOf(map, current, ownerName) as Relation<R>;
        const owner = placeTowards(
          map,
          ownerRelation.resource,
          chainOf(map, relation.resource, parent, rest),
          3,
          new Set(),
        );
        return owner ? [{ ...row, ...keysFrom(ownerRelation, owner), [ownerName]: owner }] : [row];
      });
  };
  // why: marks fill a fresh stand-in before its keys, so the path wins and the anchor is never written
  const place = (current: R, segments: string[], prefix: string): Row[] => {
    const [segment, ...rest] = segments;
    if (segment === undefined) return current === anchorResource ? [anchor] : [];
    const relation = relationOf(map, current, segment);
    if (!relation) return [];
    const marked = marksOf(map, current);
    const marks = prefix === '' ? {} : statedAt(leaves, `${prefix}.`, (name) => marked.has(name));
    return place(relation.resource, rest, prefix === '' ? segment : `${prefix}.${segment}`)
      .flatMap((parent) => step(current, segment, rest, relation, parent, prefix === ''))
      .map((row) => (Object.keys(marks).length ? { ...marks, ...row } : row));
  };
  return withExactStrings(() => place(resource, path.split('.'), ''));
};

/**
 * The pseudo records a grant is checked on: `placeUnder` from the hydrated `anchor` along the entry's
 * path, less the kinds of its first step a root leaf of the `where` (the `where` itself, or a leaf
 * of its top `all`) on the kind field fails, each given the root's exact `equals` values (the path
 * wins over a pinned foreign key), and never its own key: a stand-in is not a row that is there, so
 * a rule that asks its key to exist fails on it. A self anchor is the anchor row itself. Null when the entry
 * is malformed (the rules `setup` applies), the anchor is not the entry's, or the path reaches
 * nothing; the writer must pass on every record.
 */
export const placeEntitlement = <R extends string>(
  map: SchemaMap,
  entry: EntitlementEntry,
  anchor: Row,
): Row[] | null => {
  if (entitlementProblem(entry) !== null || recordId(anchor) !== entry.anchor.id) return null;
  if (entry.anchor.path === undefined) return [anchor];
  const pins = pinned(map, entry.resource as R, rootLeaves(entry.where));
  const placed = placeUnder(
    map,
    entry.resource as R,
    entry.anchor.path,
    entry.anchor.resource as R,
    anchor,
    entry.where,
  ).map((record) => omit({ ...pins, ...record }, idField()));
  return placed.length ? placed : null;
};

/** The hydrated rows above the records a granted entry reaches, by object; a self-anchored entry's own anchor left out. */
export const rowsAbove = <R extends string>(
  map: SchemaMap,
  entry: EntitlementEntry,
  placed: Row,
): ReadonlySet<Row> => {
  const rows = new Set<Row>();
  const anchorRow = anchorRowReachedFrom(map, entry.resource as R, placed, entry.anchor);
  if (!anchorRow) return rows;
  const climb = (current: R, row: Row) => {
    if (rows.has(row)) return;
    rows.add(row);
    for (const [name, relation] of followedToOneRelationsOf(map, current)) {
      const parent = row[name] as Row | null | undefined;
      if (parent && typeof parent === 'object' && !Array.isArray(parent))
        climb(relation.resource, parent);
    }
  };
  climb(entry.anchor.resource as R, anchorRow);
  if (entry.anchor.path === undefined) rows.delete(anchorRow);
  return rows;
};
