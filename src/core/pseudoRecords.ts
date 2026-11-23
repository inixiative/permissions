import { hasColumn } from '@inixiative/field-map';
import { type Condition, check as checkRule } from '@inixiative/json-rules';
import { omit } from 'lodash-es';
import { rowsAlongAnchorPath } from './anchorPath';
import { entitlementProblem } from './entitlementProblem';
import { withExactStrings } from './exactStrings';
import type { EntitlementEntry } from './permix';
import { idField, recordId } from './recordId';
import {
  followedToOneRelationsOf,
  ownerRelationOf,
  pseudoFieldsOf,
  type Relation,
  relationOf,
} from './relations';
import { fieldOfResource } from './resourceNames';
import { keysFrom } from './rowKeys';
import type { SchemaMap } from './schemaMap';
import type { Row } from './types';
import { type Leaf, rootLeaves } from './whereConjuncts';

const isScalar = (value: unknown) => value === null || typeof value !== 'object';

// why: a field the where requires twice with different values is unknown, so conjunct order never decides a grant
const valuesWhereRequiresByEquals = (
  leaves: Leaf[],
  prefix: string,
  accepts: (field: string) => boolean,
): Row => {
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

// why: an object or a list copied onto a pseudo record would be a relation or a list the walk then reads
const ownColumnValuesWhereRequires = <R extends string>(
  map: SchemaMap,
  resource: R,
  leaves: Leaf[],
): Row =>
  valuesWhereRequiresByEquals(leaves, '', (name) => {
    const field = fieldOfResource(map, resource, name);
    return !name.includes('.') && (!field || (hasColumn(field) && !field.isList));
  });

const whereAllowsKind = (leaves: Leaf[], field: string, value: string) =>
  leaves.every(
    (leaf) => leaf.field !== field || checkRule(leaf as Condition, { [field]: value }) === true,
  );

const rowsFromAnchorUpByResource = <R extends string>(
  map: SchemaMap,
  resource: R,
  row: Row,
  segments: string[],
): Map<R, Row> =>
  new Map(
    rowsAlongAnchorPath(map, resource, row, segments).map((step) => [step.resource, step.row]),
  );

const standInBuiltFromRowsAboveAnchor = <R extends string>(
  map: SchemaMap,
  resource: R,
  rowsAboveAnchor: ReadonlyMap<R, Row>,
  depth: number,
  seen: ReadonlySet<R>,
): Row | null => {
  const row: Row = {};
  let reached = false;
  for (const [name, relation] of followedToOneRelationsOf(map, resource)) {
    const parent =
      rowsAboveAnchor.get(relation.resource) ??
      (depth > 1 && !seen.has(relation.resource)
        ? standInBuiltFromRowsAboveAnchor(
            map,
            relation.resource,
            rowsAboveAnchor,
            depth - 1,
            new Set([...seen, resource]),
          )
        : null);
    if (!parent) continue;
    Object.assign(row, keysFrom(relation, parent), { [name]: parent });
    reached = true;
  }
  return reached ? row : null;
};

/** The pseudo records of `resource` below the hydrated `anchor` along `path`, one per polymorphic kind the path admits (README, Granting one). */
export const pseudoRecordsBelowAnchor = <R extends string>(
  map: SchemaMap,
  resource: R,
  path: string,
  anchorResource: R,
  anchor: Row,
  where?: Condition,
): Row[] => {
  const leaves = rootLeaves(where);
  const recordsOnePerKind = (
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
      .filter((value) => !top || whereAllowsKind(leaves, field, value))
      .flatMap((value) => {
        const row: Row = { ...base, [field]: value };
        const ownerName = ownerRelationOf(map, current, field, value);
        if (!ownerName || ownerName === segment) return [row];
        const ownerRelation = relationOf(map, current, ownerName) as Relation<R>;
        const owner = standInBuiltFromRowsAboveAnchor(
          map,
          ownerRelation.resource,
          rowsFromAnchorUpByResource(map, relation.resource, parent, rest),
          3,
          new Set(),
        );
        return owner ? [{ ...row, ...keysFrom(ownerRelation, owner), [ownerName]: owner }] : [row];
      });
  };
  // why: marks fill a fresh stand-in before its keys, so the path wins and the anchor is never written
  const recordsDownPath = (current: R, segments: string[], prefix: string): Row[] => {
    const [segment, ...rest] = segments;
    if (segment === undefined) return current === anchorResource ? [anchor] : [];
    const relation = relationOf(map, current, segment);
    if (!relation) return [];
    const marked = pseudoFieldsOf(map, current);
    const marks =
      prefix === ''
        ? {}
        : valuesWhereRequiresByEquals(leaves, `${prefix}.`, (name) => marked.has(name));
    return recordsDownPath(
      relation.resource,
      rest,
      prefix === '' ? segment : `${prefix}.${segment}`,
    )
      .flatMap((parent) =>
        recordsOnePerKind(current, segment, rest, relation, parent, prefix === ''),
      )
      .map((row) => (Object.keys(marks).length ? { ...marks, ...row } : row));
  };
  return withExactStrings(() => recordsDownPath(resource, path.split('.'), ''));
};

/**
 * The pseudo records a grant is checked on: `pseudoRecordsBelowAnchor` from the hydrated `anchor`
 * along the entry's path, less the kinds of its first step a root leaf of the `where` (the `where`
 * itself, or a leaf of its top `all`) on the kind field fails, each given the root's exact `equals`
 * values (the path wins over a foreign key the `where` requires), and never its own key: a pseudo
 * record is not a row that is there, so a rule that asks its key to exist fails on it. A self
 * anchor is the anchor row itself. Null when the entry is malformed (the rules `setup` applies),
 * the anchor is not the entry's, or the path reaches nothing; the writer must pass on every record.
 */
export const pseudoRecordsOfEntitlement = <R extends string>(
  map: SchemaMap,
  entry: EntitlementEntry,
  anchor: Row,
): Row[] | null => {
  if (entitlementProblem(entry) !== null || recordId(anchor) !== entry.anchor.id) return null;
  if (entry.anchor.path === undefined) return [anchor];
  const required = ownColumnValuesWhereRequires(map, entry.resource as R, rootLeaves(entry.where));
  const records = pseudoRecordsBelowAnchor(
    map,
    entry.resource as R,
    entry.anchor.path,
    entry.anchor.resource as R,
    anchor,
    entry.where,
  ).map((record) => omit({ ...required, ...record }, idField()));
  return records.length ? records : null;
};
