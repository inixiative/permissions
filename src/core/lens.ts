import { resolvedSchemaMap } from '.\/resolvedSchemaMap';
import { type FieldMap, hasColumn } from '@inixiative/field-map';
import {
  type Condition,
  endpointKey,
  type LensNarrowing,
  type LensPathResolution,
  parseEndpointKey,
  pathSegments,
  relationTargetOf,
  stitchFieldMaps,
  type ValidationIssue,
  validateRuleInLens,
  walkLensPath,
} from '@inixiative/json-rules';
import { answerOnce, freezeThenJudgeOnce } from './freezeThenJudgeOnce';
import {
  followedToOneRelationOrWhyNot,
  followedToOneRelationsOf,
  indexMap,
  type ListRelation,
  listOf,
  type Relation,
  relationOf,
  type SpelledRelationTree,
} from './relations';
import {
  fieldMapOfResource,
  fieldOfResource,
  isSuppliedMap,
  mapAndModelNamed,
  modelOfResource,
} from './resourceNames';
import type { ResolvedSchemaMap, SchemaMap } from './schemaMap';
import {
  followedToOnesOfSupplied,
  stitchedSuppliedSet,
  suppliedListAt,
  suppliedModelAt,
  suppliedModelsAtRoot,
  suppliedModelsGivenAt,
  suppliedSetAt,
} from './supplied';
import type { ActionRule } from './types';

/** Chains of at most `depth` relations; a row's lens (one kind per polymorphic model) is reported over `report`, refused over `refuse`. */
export const relationLensLimits = { depth: 20, report: 1_000, refuse: 10_000 };

/** Where a walk stands under a list item: the list (`resource.field`), and the declared path walked so far. */
export type PositionUnderListItem = {
  list: string;
  listRelation: ListRelation;
  prefix: readonly string[];
};

/** The lenses a read is judged in at one row: `rule` holds the supplied maps (a `{ rule }`), `lens` does not (a `where`, a path). */
export type LensesAtRow = {
  resource: string;
  lens: LensNarrowing | null;
  rule: LensNarrowing | null;
  under?: PositionUnderListItem;
};

// why: supplied rows are filled at the row a rule is read on, so only that model bridges to them, at its root
const lensAnchoredAtResource = (
  schemaMap: ResolvedSchemaMap,
  resource: string,
  relations: SpelledRelationTree,
  supplied: boolean,
): LensNarrowing => {
  const { mapName, modelName: model } = mapAndModelNamed(resource);
  const fieldMap = fieldMapOfResource(schemaMap, resource) as FieldMap;
  if (!supplied)
    return { parent: { maps: { [mapName]: fieldMap }, mapName, model }, root: { relations } };
  const far = Object.fromEntries(
    suppliedModelsGivenAt(schemaMap, resource).map((key) => [
      key,
      { relations: suppliedChainsFrom(schemaMap, key) },
    ]),
  );
  return {
    parent: { ...stitchFieldMaps(suppliedSetAt(schemaMap, resource)), mapName, model },
    root: { relations: { ...relations, ...far } },
  };
};

const suppliedTrees = new WeakMap<ResolvedSchemaMap, Map<string, SpelledRelationTree>>();

// The chains a supplied row leads on through, spelled once per map and key as a resource's are.
const suppliedChainsFrom = (schemaMap: ResolvedSchemaMap, key: string): SpelledRelationTree =>
  answerOnce(
    suppliedTrees,
    schemaMap,
    key,
    () =>
      spellEveryFollowedRelationChain(key, (at) => followedToOnesOfSupplied(schemaMap, at)).tree,
  );

/** The rule lens on an item of a supplied list (`actor:Device`): its own columns and the chains it leads on through. */
export const ruleLensAtSuppliedModel = (
  schemaMap: ResolvedSchemaMap,
  key: string,
): LensNarrowing => {
  const { mapName, modelName } = parseEndpointKey(key, '');
  return {
    parent: { ...stitchedSuppliedSet(schemaMap), mapName, model: modelName },
    root: { relations: suppliedChainsFrom(schemaMap, key) },
  };
};

// why: model defaults enter each model once (json-rules); spelling every chain in the root reaches siblings too
const spellEveryFollowedRelationChain = (
  resource: string,
  followed: (at: string) => [string, { resource: string; kinds?: Relation['kinds'] }][],
): { tree: SpelledRelationTree; size: number } => {
  const spellBelow = (
    at: string,
    passed: readonly string[],
    path: readonly string[],
  ): { tree: SpelledRelationTree; size: number } => {
    const tree: SpelledRelationTree = {};
    const always: number[] = [];
    const byKind = new Map<string, number>();
    for (const [name, relation] of followed(at)) {
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
  schemaMap: ResolvedSchemaMap,
  key: string,
  resource: string,
  tree: () => SpelledRelationTree,
) => {
  const { lenses } = indexMap(schemaMap);
  if (!fieldMapOfResource(schemaMap, resource)) return { lens: null, rule: null };
  if (!lenses.has(key)) {
    const spelled = tree();
    lenses.set(key, lensAnchoredAtResource(schemaMap, resource, spelled, false));
    lenses.set(`rule\u0000${key}`, lensAnchoredAtResource(schemaMap, resource, spelled, true));
  }
  return { lens: lenses.get(key) ?? null, rule: lenses.get(`rule\u0000${key}`) ?? null };
};

const lensesAndSizeOfResource = (schemaMap: ResolvedSchemaMap, resource: string) => {
  const { lensSizes } = indexMap(schemaMap);
  if (!modelOfResource(schemaMap, resource)) return null;
  const lenses = lensesBuiltOnceAt(schemaMap, resource, resource, () => {
    const { tree, size } = spellEveryFollowedRelationChain(resource, (at) =>
      followedToOneRelationsOf(schemaMap, at),
    );
    lensSizes.set(resource, size);
    return tree;
  });
  return { ...lenses, size: lensSizes.get(resource) ?? 0 };
};

/** The relations one row of `resource` hydrates, one kind of each polymorphic model counted. */
export const countRelationsOneRowHydrates = (
  schemaMap: ResolvedSchemaMap,
  resource: string,
): number => lensesAndSizeOfResource(schemaMap, resource)?.size ?? 0;

/** The lenses at a landing under a list item: the rest of the list's declared paths below `prefix`. */
const lensesAtLandingUnderListItem = (
  schemaMap: ResolvedSchemaMap,
  under: PositionUnderListItem,
): LensesAtRow => {
  const key = `${under.list}\u0000${under.prefix.join('.')}`;
  let resource = under.listRelation.resource;
  let tree = under.listRelation.down;
  for (const segment of under.prefix) {
    resource = relationOf(schemaMap, resource, segment)?.resource ?? resource;
    tree = (tree[segment]?.relations ?? {}) as SpelledRelationTree;
  }
  const spelled = tree;
  return {
    resource,
    ...lensesBuiltOnceAt(schemaMap, key, resource, () => spelled),
    under,
  };
};

export const lensesAtRow = (
  schemaMap: SchemaMap,
  resource: string,
  under?: PositionUnderListItem,
): LensesAtRow => {
  if (under) return lensesAtLandingUnderListItem(resolvedSchemaMap(schemaMap), under);
  const lenses = lensesAndSizeOfResource(resolvedSchemaMap(schemaMap), resource);
  return { resource, lens: lenses?.lens ?? null, rule: lenses?.rule ?? null };
};

/** The lenses at an item of `resource.field`, or null when `field` is not a declared list (`/// @permissions(down: [...])`). */
export const lensesAtListItem = (
  schemaMap: SchemaMap,
  resource: string,
  field: string,
): LensesAtRow | null => {
  const listRelation = listOf(resolvedSchemaMap(schemaMap), resource, field);
  return listRelation
    ? lensesAtRow(resolvedSchemaMap(schemaMap), listRelation.resource, {
        list: `${resource}.${field}`,
        listRelation,
        prefix: [],
      })
    : null;
};

const messageForPathIntoRelationList = (
  schemaMap: ResolvedSchemaMap,
  resource: string,
  segment: string,
): string =>
  `\`${resource}.${segment}\` is a list: no path reads into one; ${
    listOf(schemaMap, resource, segment) ? '' : 'declare it (`/// @permissions(down: [...])`) and '
  }cross it with { rel: '${segment}', arrayOperator: 'any', condition }`;

const messageForPathOutsideDeclaredPaths = (
  under: PositionUnderListItem,
  prefix: readonly string[],
) =>
  `\`${under.list}\` loads no \`${prefix.join('.')}\` under an item: name it in \`/// @permissions(down: [...])\``;

/** Why `path` leaves the lens at `at`, as `walkLensPath` resolves it, in the map's own words. */
const whyPathLeavesLens = (
  schemaMap: ResolvedSchemaMap,
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
  const target = last ? relationTargetOf(last.entry, last.mapName) : null;
  const resource = target
    ? endpointKey({ fieldMap: target.mapName, model: target.modelName })
    : at.resource;
  const field = fieldOfResource(schemaMap, resource, segment);
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
    return { code: 'lens', message: messageForPathIntoRelationList(schemaMap, resource, segment) };
  const relation = followedToOneRelationOrWhyNot(schemaMap, resource, segment);
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
  schemaMap: ResolvedSchemaMap,
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
    const field = fieldOfResource(schemaMap, at.resource, path);
    if (!field || hasColumn(field)) return noRelation(path);
    if (field.kind === 'object' && field.isList)
      return {
        code: 'lens',
        message: messageForPathIntoRelationList(schemaMap, at.resource, path),
      };
    const relation = followedToOneRelationOrWhyNot(schemaMap, at.resource, path);
    return typeof relation === 'string' ? { code: 'lens', message: relation } : null;
  }
  if (!at.lens) return noRelation(segments[0] as string);
  const resolution = walkLensPath(at.lens, path);
  if (
    resolution.outcome === 'missing' &&
    !fieldOfResource(schemaMap, at.resource, segments[0] as string)
  )
    return noRelation(segments[0] as string);
  if (resolution.outcome !== 'resolved') return whyPathLeavesLens(schemaMap, at, path, resolution);
  return resolution.terminal.entry.kind === 'object' ? null : noRelation(path);
};

const codesForPathOutsideLens = new Set(['not_in_lens', 'scope_out_of_bounds']);
// why: json-rules' fit checks (an operator, an enum value) are reported by validateSchemaMap; they never refuse a check
const codesForRuleNotFittingField = new Set(['operator_kind_mismatch', 'value_not_allowed']);

/** A miss that refuses a read: out of the lens, a relation hop, or past a declaration; not an operator fit. */
export const issueRefusesTheRead = (issue: ValidationIssue): boolean =>
  !codesForRuleNotFittingField.has(issue.code);

/** Every path a condition reads at `at` outside the lens, and every operator or enum value that does not fit its field. */
export const issuesForReadsOutsideLens = (
  schemaMap: ResolvedSchemaMap,
  at: LensesAtRow,
  condition: Condition,
  path: string,
  { supplied }: { supplied: boolean },
): ValidationIssue[] => {
  const lens = supplied ? at.rule : at.lens;
  if (!lens) return [];
  return validateRuleInLens(condition, lens).errors.flatMap((issue) => {
    if (codesForRuleNotFittingField.has(issue.code))
      return [{ path, code: issue.code, message: issue.message }];
    if (!codesForPathOutsideLens.has(issue.code)) return [];
    const resolution = walkLensPath(lens, issue.path);
    const head = pathSegments(issue.path)[0] ?? '';
    const { mapName: prefix } = parseEndpointKey(head, '');
    if (isSuppliedMap(schemaMap, prefix))
      return [
        {
          path,
          code: 'lens',
          message: !supplied
            ? `\`${issue.path}\`: a \`where\` reads the record alone; supplied rows are not on it`
            : whyPathLeavesSuppliedRows(schemaMap, issue.path),
        },
      ];
    return [{ path, ...whyPathLeavesLens(schemaMap, at, issue.path, resolution) }];
  });
};

// Why a rule's read of a supplied row (`actor:User.devices.risk`) leaves the rule lens.
const whyPathLeavesSuppliedRows = (schemaMap: ResolvedSchemaMap, read: string): string => {
  const [head = '', ...rest] = pathSegments(read);
  if (!suppliedModelAt(schemaMap, head))
    return `\`${head}\` is not a model of the supplied map \`${parseEndpointKey(head, '').mapName}\``;
  if (!suppliedModelsAtRoot(schemaMap).includes(head))
    return `\`${head}\` is found by key through a joined bridge: read it through the row it joins from`;
  let key = head;
  const passed = [head];
  for (const [index, segment] of rest.entries()) {
    const list = suppliedListAt(schemaMap, key, segment);
    const walked = [head, ...rest.slice(0, index + 1)].join('.');
    if (list)
      return `\`${walked}\` is a list: cross it with { rel: '${walked}', arrayOperator: 'any', condition }`;
    const next = followedToOnesOfSupplied(schemaMap, key).find(([name]) => name === segment)?.[1];
    if (!next) break;
    if (passed.includes(next.resource))
      return `\`${walked}\` reaches \`${next.resource}\` a second time: a chain passes a model once`;
    passed.push(next.resource);
    key = next.resource;
  }
  return `\`${read}\` is not a column, relation or to-one bridge of the supplied rows`;
};

// The model of the items a supplied list holds (`actor:User.devices` → `actor:Device`), or why the path names none.
const suppliedListItemAt = (
  schemaMap: ResolvedSchemaMap,
  rel: string,
): { item: string } | { why: string } => {
  const [head = '', ...rest] = pathSegments(rel);
  const last = rest.at(-1);
  if (!suppliedModelAt(schemaMap, head) || !suppliedModelsAtRoot(schemaMap).includes(head) || !last)
    return { why: whyPathLeavesSuppliedRows(schemaMap, rel) };
  let key = head;
  for (const segment of rest.slice(0, -1)) {
    const next = followedToOnesOfSupplied(schemaMap, key).find(([name]) => name === segment)?.[1];
    if (!next) return { why: whyPathLeavesSuppliedRows(schemaMap, rel) };
    key = next.resource;
  }
  const item = suppliedListAt(schemaMap, key, last);
  return item ? { item } : { why: `\`${rel}\` is not a list of the supplied rows` };
};

/** What is wrong with a list arm over a supplied list: its path, and a condition that is not rules (an item has no actions) or reads outside the item's lens. */
export const issuesOfSuppliedListArm = (
  schemaMap: ResolvedSchemaMap,
  rel: string,
  condition: ActionRule,
  path: string,
): ValidationIssue[] => {
  const found = suppliedListItemAt(schemaMap, rel);
  if ('why' in found) return [{ path, code: 'lens', message: found.why }];
  const lens = ruleLensAtSuppliedModel(schemaMap, found.item);
  const issuesOf = (rule: ActionRule, at: string): ValidationIssue[] => {
    if (typeof rule === 'boolean') return [];
    if (rule !== null && typeof rule === 'object') {
      if ('rule' in rule)
        return validateRuleInLens(rule.rule, lens).errors.map((issue) => ({
          path: at,
          code: issue.code,
          message: issue.message,
        }));
      if ('any' in rule) return rule.any.flatMap((child, i) => issuesOf(child, `${at}.any[${i}]`));
      if ('all' in rule) return rule.all.flatMap((child, i) => issuesOf(child, `${at}.all[${i}]`));
    }
    return [
      {
        path: at,
        code: 'actionRule',
        message: `an item of \`${rel}\` is a supplied row with no actions: its condition holds rules, any and all`,
      },
    ];
  };
  return issuesOf(condition, `${path}.condition`);
};

/** Why an entitlement `where` read at `at` leaves the lens, or null. */
export const whyWhereLeavesLensAtRow = (
  schemaMap: ResolvedSchemaMap,
  at: LensesAtRow,
  where: Condition | undefined,
): string | null => {
  if (typeof where !== 'object' || where === null || !at.lens) return null;
  return freezeThenJudgeOnce(where, at.lens, () => {
    const misses = issuesForReadsOutsideLens(schemaMap, at, where, '$', { supplied: false }).filter(
      issueRefusesTheRead,
    );
    return misses.length
      ? `entitlement \`where\` reads outside the lens: ${misses.map((miss) => miss.message).join('; ')}`
      : null;
  });
};

/** Why an entitlement `where` at `resource` reads outside the lens, or null. Frozen on first use. */
export const whyEntitlementWhereLeavesLens = (
  schemaMap: SchemaMap,
  resource: string,
  where: Condition | undefined,
): string | null =>
  whyWhereLeavesLensAtRow(
    resolvedSchemaMap(schemaMap),
    lensesAtRow(resolvedSchemaMap(schemaMap), resource),
    where,
  );
