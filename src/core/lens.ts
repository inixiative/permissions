import { fieldOf, hasColumn, modelOf } from '@inixiative/field-map';
import {
  type Condition,
  type LensNarrowing,
  type LensPathResolution,
  pathSegments,
  type ValidationIssue,
  validateRuleInLens,
  walkLensPath,
} from '@inixiative/json-rules';
import { freezeThenJudgeOnce } from './freezeThenJudgeOnce';
import {
  followedToOneRelationOrWhyNot,
  followedToOneRelationsOf,
  indexMap,
  type ListRelation,
  listOf,
  relationOf,
  resourceOf,
  type SchemaMap,
  type SpelledRelationTree,
} from './schemaMap';

/** Chains of at most `depth` relations; a row's lens (one kind per polymorphic model) is reported over `report`, refused over `refuse`. */
export const relationLensLimits = { depth: 20, report: 1_000, refuse: 10_000 };

/** Where a walk stands under a list item: the list (`resource.field`), and the declared path walked so far. */
export type PositionUnderListItem = {
  list: string;
  listRelation: ListRelation;
  prefix: readonly string[];
};

/** The lenses a read is judged in at one row: `rule` holds the actor (a `{ rule }`), `lens` does not (a `where`, a path). */
export type LensesAtRow = {
  resource: string;
  lens: LensNarrowing | null;
  rule: LensNarrowing | null;
  under?: PositionUnderListItem;
};

const actorAsJsonField = { kind: 'scalar', type: 'Json', isList: false } as const;

// why: the actor is injected at the row a rule is read on, so only that model carries it
const lensAnchoredAtModel = (
  map: SchemaMap,
  model: string,
  relations: SpelledRelationTree,
  actor: boolean,
): LensNarrowing => {
  const entry = modelOf(map.fieldMap, model);
  const fieldMap = actor
    ? {
        ...map.fieldMap,
        models: {
          ...map.fieldMap.models,
          [model]: { ...entry, fields: { ...entry?.fields, __actor: actorAsJsonField } },
        },
      }
    : map.fieldMap;
  return { parent: { maps: { app: fieldMap }, mapName: 'app', model }, root: { relations } };
};

// why: model defaults enter each model once (json-rules); spelling every chain in the root reaches siblings too
const spellEveryFollowedRelationChain = (
  map: SchemaMap,
  resource: string,
): { tree: SpelledRelationTree; size: number } => {
  const spellBelow = (
    at: string,
    passed: readonly string[],
    path: readonly string[],
  ): { tree: SpelledRelationTree; size: number } => {
    const tree: SpelledRelationTree = {};
    const always: number[] = [];
    const byKind = new Map<string, number>();
    for (const [name, relation] of followedToOneRelationsOf(map, at)) {
      if (passed.includes(relation.resource)) continue;
      const where = [...path, name].join('.');
      if (path.length >= relationLensLimits.depth)
        throw new Error(
          `the lens of \`${resource}\` goes past ${relationLensLimits.depth} relations at \`${where}\``,
        );
      const below = spellBelow(relation.resource, [...passed, relation.resource], [...path, name]);
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
    if (size > relationLensLimits.refuse)
      throw new Error(
        `the lens of \`${resource}\` hydrates more than ${relationLensLimits.refuse} relations a row (at \`${path.join('.') || resource}\`)`,
      );
    return { tree, size };
  };
  return spellBelow(resource, [resource], []);
};

/** The lens and the rule lens at `key`, built once from `tree` (read only when they are built). */
const lensesBuiltOnceAt = (
  map: SchemaMap,
  key: string,
  model: string,
  tree: () => SpelledRelationTree,
) => {
  const { lenses } = indexMap(map);
  if (!lenses.has(key)) {
    const spelled = tree();
    lenses.set(key, lensAnchoredAtModel(map, model, spelled, false));
    lenses.set(`rule\u0000${key}`, lensAnchoredAtModel(map, model, spelled, true));
  }
  return { lens: lenses.get(key) ?? null, rule: lenses.get(`rule\u0000${key}`) ?? null };
};

const lensesAndSizeOfResource = (map: SchemaMap, resource: string) => {
  const { lensSizes } = indexMap(map);
  const model = map.resources[resource];
  if (!model) return null;
  const lenses = lensesBuiltOnceAt(map, resource, model, () => {
    const { tree, size } = spellEveryFollowedRelationChain(map, resource);
    lensSizes.set(resource, size);
    return tree;
  });
  return { ...lenses, size: lensSizes.get(resource) ?? 0 };
};

/** The relations one row of `resource` hydrates, one kind of each polymorphic model counted. */
export const countRelationsOneRowHydrates = (map: SchemaMap, resource: string): number =>
  lensesAndSizeOfResource(map, resource)?.size ?? 0;

/** The lenses at a landing under a list item: the rest of the list's declared paths below `prefix`. */
const lensesAtLandingUnderListItem = (
  map: SchemaMap,
  under: PositionUnderListItem,
): LensesAtRow => {
  const key = `${under.list}\u0000${under.prefix.join('.')}`;
  let resource = under.listRelation.resource;
  let tree = under.listRelation.down;
  for (const segment of under.prefix) {
    resource = relationOf(map, resource, segment)?.resource ?? resource;
    tree = (tree[segment]?.relations ?? {}) as SpelledRelationTree;
  }
  const spelled = tree;
  return {
    resource,
    ...lensesBuiltOnceAt(map, key, map.resources[resource] as string, () => spelled),
    under,
  };
};

export const lensesAtRow = (
  map: SchemaMap,
  resource: string,
  under?: PositionUnderListItem,
): LensesAtRow => {
  if (under) return lensesAtLandingUnderListItem(map, under);
  const lenses = lensesAndSizeOfResource(map, resource);
  return { resource, lens: lenses?.lens ?? null, rule: lenses?.rule ?? null };
};

const messageForPathIntoRelationList = (
  map: SchemaMap,
  resource: string,
  segment: string,
): string =>
  `\`${resource}.${segment}\` is a list: no path reads into one; ${
    listOf(map, resource, segment) ? '' : 'declare it (`/// @permissions(down: [...])`) and '
  }cross it with { rel: '${segment}', arrayOperator: 'any', condition }`;

const messageForPathOutsideDeclaredPaths = (
  under: PositionUnderListItem,
  prefix: readonly string[],
) =>
  `\`${under.list}\` loads no \`${prefix.join('.')}\` under an item: name it in \`/// @permissions(down: [...])\``;

/** Why `path` leaves the lens at `at`, as `walkLensPath` resolves it, in the map's own words. */
const whyPathLeavesLens = (
  map: SchemaMap,
  at: LensesAtRow,
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
  const field = fieldOf(map.fieldMap, map.resources[resource], segment);
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
    return { code: 'lens', message: messageForPathIntoRelationList(map, resource, segment) };
  const relation = followedToOneRelationOrWhyNot(map, resource, segment);
  if (typeof relation === 'string') return { code: 'lens', message: relation };
  if (at.under)
    return {
      code: 'down',
      message: messageForPathOutsideDeclaredPaths(at.under, [
        ...at.under.prefix,
        ...walked,
        segment,
      ]),
    };
  return {
    code: 'lens',
    message: `\`${path}\` comes back to \`${relation.resource}\`: a path back to a model is not in the lens; read it from \`${relation.resource}\` itself`,
  };
};

/** Why a `{ rel }` path from `at` is not one it may walk, or null; one hop off an item lands on any row the hydrator loads. */
export const whyRelationPathCannotBeWalked = (
  map: SchemaMap,
  at: LensesAtRow,
  path: string,
): { code: 'lens' | 'down'; message: string } | null => {
  if (path === '') return null;
  const segments = pathSegments(path);
  const noRelation = (segment: string) => ({
    code: 'lens' as const,
    message: `\`${at.resource}\` has no relation \`${segment}\``,
  });
  if (!at.under && segments.length === 1) {
    const field = fieldOf(map.fieldMap, map.resources[at.resource], path);
    if (!field || hasColumn(field)) return noRelation(path);
    if (field.kind === 'object' && field.isList)
      return { code: 'lens', message: messageForPathIntoRelationList(map, at.resource, path) };
    const relation = followedToOneRelationOrWhyNot(map, at.resource, path);
    return typeof relation === 'string' ? { code: 'lens', message: relation } : null;
  }
  if (!at.lens) return noRelation(segments[0] as string);
  const resolution = walkLensPath(at.lens, path);
  if (
    resolution.outcome === 'missing' &&
    !fieldOf(map.fieldMap, map.resources[at.resource], segments[0] as string)
  )
    return noRelation(segments[0] as string);
  if (resolution.outcome !== 'resolved') return whyPathLeavesLens(map, at, path, resolution);
  return resolution.terminal.entry.kind === 'object' ? null : noRelation(path);
};

const codesForPathOutsideLens = new Set(['not_in_lens', 'scope_out_of_bounds']);
// why: json-rules' fit check is reported by validateSchema; it never refuses a check
const codesForOperatorNotFittingField = new Set(['operator_kind_mismatch']);

/** A miss that refuses a read: out of the lens, a relation hop, or past a declaration; not an operator fit. */
export const issueRefusesTheRead = (issue: ValidationIssue): boolean =>
  !codesForOperatorNotFittingField.has(issue.code);

/** Every path a condition reads at `at` outside the lens, and every operator that does not fit its field. */
export const issuesForReadsOutsideLens = (
  map: SchemaMap,
  at: LensesAtRow,
  condition: Condition,
  path: string,
  { actor }: { actor: boolean },
): ValidationIssue[] => {
  const lens = actor ? at.rule : at.lens;
  if (!lens) return [];
  return validateRuleInLens(condition, lens).errors.flatMap((issue) => {
    if (codesForOperatorNotFittingField.has(issue.code))
      return [{ path, code: issue.code, message: issue.message }];
    if (!codesForPathOutsideLens.has(issue.code)) return [];
    const resolution = walkLensPath(lens, issue.path);
    if (pathSegments(issue.path)[0] === '__actor')
      return [
        {
          path,
          code: 'lens',
          message: `\`${issue.path}\`: a \`where\` reads the record alone; \`__actor\` is not on it`,
        },
      ];
    return [{ path, ...whyPathLeavesLens(map, at, issue.path, resolution) }];
  });
};

/** Why an entitlement `where` read at `at` leaves the lens, or null. */
export const whyWhereLeavesLensAtRow = (
  map: SchemaMap,
  at: LensesAtRow,
  where: Condition | undefined,
): string | null => {
  if (typeof where !== 'object' || where === null || !at.lens) return null;
  return freezeThenJudgeOnce(where, at.lens, () => {
    const misses = issuesForReadsOutsideLens(map, at, where, '$', { actor: false }).filter(
      issueRefusesTheRead,
    );
    return misses.length
      ? `entitlement \`where\` reads outside the lens: ${misses.map((miss) => miss.message).join('; ')}`
      : null;
  });
};

/** Why an entitlement `where` at `resource` reads outside the lens, or null. Frozen on first use. */
export const whyEntitlementWhereLeavesLens = (
  map: SchemaMap,
  resource: string,
  where: Condition | undefined,
): string | null => whyWhereLeavesLensAtRow(map, lensesAtRow(map, resource), where);
