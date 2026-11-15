import {
  type Condition,
  listFields,
  pathSegments,
  type ValidationIssue,
} from '@inixiative/json-rules';
import {
  fieldOf,
  indexMap,
  isColumn,
  type ListRelation,
  listOf,
  listsOf,
  type Relation,
  type SchemaMap,
  toOneOf,
} from './schemaMap';
import type { Row } from './types';

/** What hydration loads at one row, so all a check reads there: a model's node, or a list item's (`down`). */
export type LensNode<R extends string = string> = {
  resource: R;
  down: boolean;
  toOne: ReadonlyMap<string, Relation<R>>;
  lists: ReadonlyMap<string, ListRelation<R>>;
  below: (name: string) => LensNode<R>;
};

/** The lens at a row of `resource`, its model's own node. */
export const lensOf = <R extends string>(map: SchemaMap<R>, resource: R): LensNode<R> => {
  const index = indexMap(map as SchemaMap);
  const known = index.lenses.get(resource);
  if (known) return known as LensNode<R>;
  const toOne = new Map<string, Relation<R>>();
  for (const name of Object.keys(map.fieldMap.models[map.resources[resource]]?.fields ?? {})) {
    const relation = toOneOf(map, resource, name);
    if (typeof relation !== 'string') toOne.set(name, relation);
  }
  const lists = new Map(listsOf(map, resource));
  const below = (name: string): LensNode<R> =>
    lists.get(name)?.item ?? lensOf(map, (toOne.get(name) as Relation<R>).resource);
  const node: LensNode<R> = { resource, down: false, toOne, lists, below };
  index.lenses.set(resource, node as LensNode);
  return node;
};

const isObject = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The view of `record` a check reads: columns, the lens's relations, and computed keys at the root. */
export const projectRecord = <R extends string>(
  map: SchemaMap<R>,
  resource: R,
  record: Row,
): Row => {
  const made = new Map<LensNode<R>, WeakMap<Row, Row>>();
  const view = (node: LensNode<R>, row: Row, root: boolean): Row => {
    const seen = made.get(node) ?? new WeakMap<Row, Row>();
    made.set(node, seen);
    const known = root ? undefined : seen.get(row);
    if (known) return known;
    const out: Row = {};
    if (!root) seen.set(row, out);
    const fields = map.fieldMap.models[map.resources[node.resource]]?.fields ?? {};
    for (const [key, value] of Object.entries(row)) {
      const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (!field) {
        if (root) out[key] = value;
      } else if (isColumn(field)) out[key] = value;
      else if (node.toOne.has(key)) {
        if (value === null) out[key] = null;
        else if (isObject(value)) out[key] = view(node.below(key), value, false);
      } else if (node.lists.has(key) && Array.isArray(value)) {
        const item = node.below(key);
        out[key] = value.filter(isObject).map((entry) => view(item, entry, false));
      }
    }
    return out;
  };
  return view(lensOf(map, resource), record, true);
};

/** Freezes `value` and everything in it. */
export const freeze = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child, seen);
};

export type Under = { list: string; prefix: readonly string[] };

export type LensMiss = { code: 'lens' | 'down'; message: string };

const lens = (message: string): LensMiss => ({ code: 'lens', message });

export const notLoaded = (under: Under, prefix: readonly string[]): LensMiss => ({
  code: 'down',
  message: `\`${under.list}\` loads no \`${prefix.join('.')}\` under an item: name it in \`/// @permissions(down: [...])\``,
});

const listMessage = (map: SchemaMap, resource: string, segment: string): string =>
  `\`${resource}.${segment}\` is a list: no path reads into one; ${
    listOf(map, resource, segment) ? '' : 'declare it (`/// @permissions(down: [...])`) and '
  }cross it with { rel: '${segment}', arrayOperator: 'any', condition }`;

/** One key read at `node`: the node below a lens relation, a column, a key the model lacks, or why it leaves the lens. */
export type LensStep<R extends string = string> =
  | { next: LensNode<R> }
  | { column: true }
  | { absent: true }
  | { miss: LensMiss };

export const stepLens = <R extends string>(
  map: SchemaMap<R>,
  node: LensNode<R>,
  segment: string,
  under?: Under,
): LensStep<R> => {
  const field = fieldOf(map, node.resource, segment);
  if (!field) return { absent: true };
  if (isColumn(field)) return { column: true };
  if (field.kind === 'object' && field.isList)
    return { miss: lens(listMessage(map as SchemaMap, node.resource, segment)) };
  if (node.toOne.has(segment)) return { next: node.below(segment) };
  const relation = toOneOf(map, node.resource, segment);
  if (typeof relation === 'string') return { miss: lens(relation) };
  const at = under ?? { list: node.resource, prefix: [] };
  return { miss: notLoaded(at, [...at.prefix, segment]) };
};

/** How a condition is read: `actor` when `__actor` is injected (a `{ rule }`), `computed` when the caller built the root (an inline rule at the subject). */
export type Reading = { actor: boolean; computed?: boolean; under?: Under };

const pathMiss = (
  map: SchemaMap,
  start: LensNode,
  path: string,
  { actor, computed = false, under }: Reading,
): LensMiss | null => {
  const segments = pathSegments(path);
  if (segments[0] === '__actor')
    return actor
      ? null
      : lens(`\`${path}\`: a \`where\` reads the record alone; \`__actor\` is not on it`);
  let node = start;
  const walked: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const at = under && { ...under, prefix: [...under.prefix, ...walked] };
    const step = stepLens(map, node, segment, at);
    if ('column' in step) return null;
    if ('miss' in step) return step.miss;
    if ('absent' in step) {
      // why: a resource without a model in the map has no fields to hold a path to
      if ((index === 0 && computed) || !map.resources[node.resource]) return null;
      return lens(
        /^\d+$/.test(segment)
          ? `\`${path}\`: \`${walked.join('.')}\` is one row and is never indexed; read its fields`
          : `\`${node.resource}\` has no field \`${segment}\` (\`${path}\`)`,
      );
    }
    walked.push(segment);
    node = step.next;
  }
  return null;
};

/** Every path a condition reads at `node` that leaves the lens. */
export const conditionMisses = (
  map: SchemaMap,
  node: LensNode,
  condition: Condition,
  at: string,
  reading: Reading,
): ValidationIssue[] =>
  listFields(condition).flatMap((field) => {
    const miss = pathMiss(map, node, field, reading);
    return miss ? [{ path: at, ...miss }] : [];
  });

const judgedWheres = new WeakMap<SchemaMap, WeakMap<object, Map<string, string | null>>>();

/** Why an entitlement `where` at `resource` reads outside the lens, or null. Frozen on first use. */
export const whereLensProblem = (
  map: SchemaMap,
  resource: string,
  where: Condition | undefined,
): string | null => {
  if (typeof where !== 'object' || where === null) return null;
  const byWhere = judgedWheres.get(map) ?? new WeakMap<object, Map<string, string | null>>();
  judgedWheres.set(map, byWhere);
  const byResource = byWhere.get(where) ?? new Map<string, string | null>();
  byWhere.set(where, byResource);
  const known = byResource.get(resource);
  if (known !== undefined) return known;
  freeze(where);
  const misses = conditionMisses(map, lensOf(map, resource), where, '$', { actor: false });
  const problem = misses.length
    ? `entitlement \`where\` reads outside the lens: ${misses.map((miss) => miss.message).join('; ')}`
    : null;
  byResource.set(resource, problem);
  return problem;
};
