import {
  type Condition,
  type LensNarrowing,
  type LensPathResolution,
  pathSegments,
  type ValidationIssue,
  validateRuleInLens,
  walkLensPath,
} from '@inixiative/json-rules';
import {
  fieldOf,
  indexMap,
  type ListRelation,
  listOf,
  relationOf,
  resourceOf,
  type SchemaMap,
  type Spelled,
  toOneOf,
  toOnesOf,
} from './schemaMap';

/** Chains of at most `depth` relations; a row's lens (one kind per polymorphic model) is reported over `report`, refused over `refuse`. */
export const lensLimits = { depth: 20, report: 1_000, refuse: 10_000 };

/** Where a walk stands under a list item: the list (`resource.field`), and the declared path walked so far. */
export type Under = { list: string; listRelation: ListRelation; prefix: readonly string[] };

/** The lenses a read is judged in at one row: `rule` holds the actor (a `{ rule }`), `lens` does not (a `where`, a path). */
export type LensAt = {
  resource: string;
  lens: LensNarrowing | null;
  rule: LensNarrowing | null;
  under?: Under;
};

const actorField = { kind: 'scalar', type: 'Json', isList: false } as const;

// why: the actor is injected at the row a rule is read on, so only that model carries it
const anchored = (
  map: SchemaMap,
  model: string,
  relations: Spelled,
  actor: boolean,
): LensNarrowing => {
  const models = map.fieldMap.models;
  const fieldMap = actor
    ? {
        ...map.fieldMap,
        models: {
          ...models,
          [model]: { ...models[model], fields: { ...models[model]?.fields, __actor: actorField } },
        },
      }
    : map.fieldMap;
  return { parent: { maps: { app: fieldMap }, mapName: 'app', model }, root: { relations } };
};

// why: model defaults enter each model once (json-rules); spelling every chain in the root reaches siblings too
const spellFrom = (map: SchemaMap, resource: string): { tree: Spelled; size: number } => {
  const spell = (
    at: string,
    passed: readonly string[],
    path: readonly string[],
  ): { tree: Spelled; size: number } => {
    const tree: Spelled = {};
    const always: number[] = [];
    const byKind = new Map<string, number>();
    for (const [name, relation] of toOnesOf(map, at)) {
      if (passed.includes(relation.resource)) continue;
      const where = [...path, name].join('.');
      if (path.length >= lensLimits.depth)
        throw new Error(
          `the lens of \`${resource}\` goes past ${lensLimits.depth} relations at \`${where}\``,
        );
      const below = spell(relation.resource, [...passed, relation.resource], [...path, name]);
      tree[name] = { relations: below.tree };
      if (!relation.kinds) always.push(1 + below.size);
      else
        for (const value of relation.kinds.values) {
          const kind = `${relation.kinds.field}\u0000${value}`;
          byKind.set(kind, (byKind.get(kind) ?? 0) + 1 + below.size);
        }
    }
    const largest = new Map<string, number>();
    for (const [kind, size] of byKind) {
      const axis = kind.split('\u0000')[0] as string;
      largest.set(axis, Math.max(largest.get(axis) ?? 0, size));
    }
    const size = [...always, ...largest.values()].reduce((sum, n) => sum + n, 0);
    if (size > lensLimits.refuse)
      throw new Error(
        `the lens of \`${resource}\` hydrates more than ${lensLimits.refuse} relations a row (at \`${path.join('.') || resource}\`)`,
      );
    return { tree, size };
  };
  return spell(resource, [resource], []);
};

const built = (map: SchemaMap, resource: string) => {
  const { lenses, lensSizes } = indexMap(map);
  const model = map.resources[resource];
  if (!model) return null;
  if (!lenses.has(resource)) {
    const { tree, size } = spellFrom(map, resource);
    lenses.set(resource, anchored(map, model, tree, false));
    lenses.set(`rule\u0000${resource}`, anchored(map, model, tree, true));
    lensSizes.set(resource, size);
  }
  return {
    lens: lenses.get(resource) ?? null,
    rule: lenses.get(`rule\u0000${resource}`) ?? null,
    size: lensSizes.get(resource) ?? 0,
  };
};

/** The relations one row of `resource` hydrates, one kind of each polymorphic model counted. */
export const lensSize = (map: SchemaMap, resource: string): number =>
  built(map, resource)?.size ?? 0;

/** The lenses at a landing under a list item: the rest of the list's declared paths below `prefix`. */
const itemLensAt = (map: SchemaMap, under: Under): LensAt => {
  const { lenses } = indexMap(map);
  const key = `${under.list}\u0000${under.prefix.join('.')}`;
  let resource = under.listRelation.resource;
  let tree = under.listRelation.down;
  for (const segment of under.prefix) {
    resource = relationOf(map, resource, segment)?.resource ?? resource;
    tree = (tree[segment]?.relations ?? {}) as Spelled;
  }
  const model = map.resources[resource] as string;
  if (!lenses.has(key)) {
    lenses.set(key, anchored(map, model, tree, false));
    lenses.set(`rule\u0000${key}`, anchored(map, model, tree, true));
  }
  return {
    resource,
    lens: lenses.get(key) ?? null,
    rule: lenses.get(`rule\u0000${key}`) ?? null,
    under,
  };
};

export const lensAt = (map: SchemaMap, resource: string, under?: Under): LensAt => {
  if (under) return itemLensAt(map, under);
  const lenses = built(map, resource);
  return { resource, lens: lenses?.lens ?? null, rule: lenses?.rule ?? null };
};

const listMessage = (map: SchemaMap, resource: string, segment: string): string =>
  `\`${resource}.${segment}\` is a list: no path reads into one; ${
    listOf(map, resource, segment) ? '' : 'declare it (`/// @permissions(down: [...])`) and '
  }cross it with { rel: '${segment}', arrayOperator: 'any', condition }`;

const notLoaded = (under: Under, prefix: readonly string[]) =>
  `\`${under.list}\` loads no \`${prefix.join('.')}\` under an item: name it in \`/// @permissions(down: [...])\``;

/** Why `path` leaves the lens at `at`, as `walkLensPath` resolves it, in the map's own words. */
const explain = (
  map: SchemaMap,
  at: LensAt,
  path: string,
  resolution: LensPathResolution = walkLensPath(at.lens as LensNarrowing, path),
): { code: 'lens' | 'down'; message: string } => {
  if (resolution.outcome === 'resolved')
    return { code: 'lens', message: `\`${path}\` does not resolve through the lens` };
  const segments = pathSegments(path);
  const walked = segments.slice(0, resolution.index);
  const segment = segments[resolution.index] as string;
  const last = resolution.hops.at(-1);
  const resource = last ? (resourceOf(map, last.entry.type) ?? last.entry.type) : at.resource;
  const field = fieldOf(map, resource, segment);
  if (resolution.outcome === 'pastScalar')
    return {
      code: 'lens',
      message: `\`${path}\`: \`${[...walked, segment].join('.')}\` is a column; a path never reads past one`,
    };
  if (!field)
    return {
      code: 'lens',
      message:
        /^\d+$/.test(segment) && walked.length
          ? `\`${path}\`: \`${walked.join('.')}\` is one row and is never indexed; read its fields`
          : `\`${resource}\` has no field \`${segment}\` (\`${path}\`)`,
    };
  if (field.kind === 'object' && field.isList)
    return { code: 'lens', message: listMessage(map, resource, segment) };
  const relation = toOneOf(map, resource, segment);
  if (typeof relation === 'string') return { code: 'lens', message: relation };
  if (at.under)
    return { code: 'down', message: notLoaded(at.under, [...at.under.prefix, ...walked, segment]) };
  return {
    code: 'lens',
    message: `\`${path}\` comes back to \`${relation.resource}\`: a path back to a model is not in the lens; read it from \`${relation.resource}\` itself`,
  };
};

/** Why a `{ rel }` path from `at` is not one it may walk, or null; one hop off an item lands on any row the hydrator loads. */
export const relationPathProblem = (
  map: SchemaMap,
  at: LensAt,
  path: string,
): { code: 'lens' | 'down'; message: string } | null => {
  if (path === '') return null;
  const segments = pathSegments(path);
  const noRelation = (segment: string) => ({
    code: 'lens' as const,
    message: `\`${at.resource}\` has no relation \`${segment}\``,
  });
  if (!at.under && segments.length === 1) {
    const field = fieldOf(map, at.resource, path);
    if (!field || field.kind === 'scalar' || field.kind === 'enum') return noRelation(path);
    if (field.kind === 'object' && field.isList)
      return { code: 'lens', message: listMessage(map, at.resource, path) };
    const relation = toOneOf(map, at.resource, path);
    return typeof relation === 'string' ? { code: 'lens', message: relation } : null;
  }
  if (!at.lens) return noRelation(segments[0] as string);
  const resolution = walkLensPath(at.lens, path);
  if (resolution.outcome === 'missing' && !fieldOf(map, at.resource, segments[0] as string))
    return noRelation(segments[0] as string);
  if (resolution.outcome !== 'resolved') return explain(map, at, path, resolution);
  return resolution.terminal.entry.kind === 'object' ? null : noRelation(path);
};

const pathCodes = new Set(['not_in_lens', 'scope_out_of_bounds']);
// why: json-rules' fit check is reported by validateSchema; it never refuses a check (invalid_value waits on typed fixtures)
const fitCodes = new Set(['operator_kind_mismatch']);

/** A miss that refuses a read: out of the lens, a relation hop, or past a declaration; not an operator fit. */
export const refuses = (issue: ValidationIssue): boolean => !fitCodes.has(issue.code);

/** Every path a condition reads at `at` outside the lens, and every operator that does not fit its field. */
export const conditionMisses = (
  map: SchemaMap,
  at: LensAt,
  condition: Condition,
  path: string,
  { actor }: { actor: boolean },
): ValidationIssue[] => {
  const lens = actor ? at.rule : at.lens;
  if (!lens) return [];
  return validateRuleInLens(condition, lens).errors.flatMap((issue) => {
    if (fitCodes.has(issue.code)) return [{ path, code: issue.code, message: issue.message }];
    if (!pathCodes.has(issue.code)) return [];
    const resolution = walkLensPath(lens, issue.path);
    if (pathSegments(issue.path)[0] === '__actor')
      return [
        {
          path,
          code: 'lens',
          message: `\`${issue.path}\`: a \`where\` reads the record alone; \`__actor\` is not on it`,
        },
      ];
    return [{ path, ...explain(map, at, issue.path, resolution) }];
  });
};

/** Freezes `value` and everything in it. */
const freeze = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) freeze(child, seen);
};

const judged = new WeakMap<object, Map<object, unknown>>();

/** `judge`'s answer for `value` at `key`, once: `value` is frozen first, so the answer cannot go stale. */
export const judgeOnce = <T>(value: object, key: object, judge: () => T): T => {
  const byKey = judged.get(value) ?? new Map<object, unknown>();
  judged.set(value, byKey);
  if (byKey.has(key)) return byKey.get(key) as T;
  freeze(value);
  const answer = judge();
  byKey.set(key, answer);
  return answer;
};

/** Why an entitlement `where` read at `at` leaves the lens, or null. */
export const whereProblemAt = (
  map: SchemaMap,
  at: LensAt,
  where: Condition | undefined,
): string | null => {
  if (typeof where !== 'object' || where === null || !at.lens) return null;
  return judgeOnce(where, at.lens, () => {
    const misses = conditionMisses(map, at, where, '$', { actor: false }).filter(refuses);
    return misses.length
      ? `entitlement \`where\` reads outside the lens: ${misses.map((miss) => miss.message).join('; ')}`
      : null;
  });
};

/** Why an entitlement `where` at `resource` reads outside the lens, or null. Frozen on first use. */
export const whereLensProblem = (
  map: SchemaMap,
  resource: string,
  where: Condition | undefined,
): string | null => whereProblemAt(map, lensAt(map, resource), where);
