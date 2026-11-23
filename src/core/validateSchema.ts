import { endpointKey, type ValidationIssue, type ValidationResult } from '@inixiative/json-rules';
import { bridgeHop } from './bridgeHop';
import { resourceHasNoFieldMap } from './errors';
import {
  countRelationsOneRowHydrates,
  type LensesAtRow,
  lensesAtRow,
  relationLensLimits,
} from './lens';
import { listsOf, relationOf } from './relations';
import { modelOfResource, whyNameIsNoModel } from './resourceNames';
import { isRefusedByACheck, relIssues, walkRelationPath } from './ruleReads';
import type { SchemaMap } from './schemaMap';
import { bridgesWalkedFromRecords } from './supplied';
import { issuesOfShapeAndCycle, validateActionRule } from './validateActionRule';
import { problemsOfBridges, problemsOfMapNames } from './validateSchemaMap';

/** A segment a `{ rel }` may take next, and the resource it lands on. */
export type RelationHop = { segment: string; resource: string; bridge: boolean };

/**
 * The segments a `{ rel }` may take next from `at` after `walked` (dotted, '' for none), each with
 * the resource it lands on: every to-one relation and bridge whose walk `validateSchema` accepts.
 * For an editor that offers only the hops a check takes.
 */
export const relationHopsFrom = (map: SchemaMap, at: LensesAtRow, walked = ''): RelationHop[] => {
  const prefix = walked ? walked.split('.') : [];
  const reached = prefix.length ? walkRelationPath(map, at, walked, '$') : { landed: at };
  if ('issues' in reached && reached.issues.length) return [];
  const current = 'landed' in reached ? reached.landed.resource : at.resource;
  const fields = Object.keys(modelOfResource(map, current)?.fields ?? {});
  const crossed = bridgesWalkedFromRecords(map);
  const bridgeEnds = crossed.flatMap((bridge) => bridge.endpoints.map(endpointKey));
  const candidates = [
    ...fields
      .filter((field) => relationOf(map, current, field))
      .map((segment) => ({ segment, bridge: false })),
    ...[...new Set(bridgeEnds)]
      .filter((end) => bridgeHop(crossed, current, end))
      .map((segment) => ({ segment, bridge: true })),
  ];
  return candidates.flatMap(({ segment, bridge }) => {
    const next = walkRelationPath(map, at, [...prefix, segment].join('.'), '$');
    return 'landed' in next ? [{ segment, resource: next.landed.resource, bridge }] : [];
  });
};

/** The fields of `resource` that are declared lists (`/// @permissions(down: [...])`), which a list arm may cross. */
export const declaredListsOf = (map: SchemaMap, resource: string): string[] =>
  listsOf(map, resource).map(([field]) => field);

const issuesOfEveryActionRule = (map: SchemaMap, judgedInItsMap: boolean): ValidationIssue[] =>
  Object.entries(map.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      (judgedInItsMap
        ? issuesOfShapeAndCycle(rule, { map, resource, action })
        : validateActionRule(rule).errors
      ).map((issue) => ({ ...issue, path: `${resource}.${action}${issue.path.slice(1)}` })),
    ),
  );

/** Every action rule of a map that is not well formed and positive, by `resource.action`. */
export const schemaRuleIssues = (map: SchemaMap): ValidationIssue[] =>
  issuesOfEveryActionRule(map, false);

const lensIssue = (path: string, message: string): ValidationIssue => ({
  path,
  code: 'lens',
  message,
});

const issuesOfBridges = (map: SchemaMap): ValidationIssue[] =>
  problemsOfBridges(map).map((message) => lensIssue('bridges', message));

// why: a name that is no model has no lens, so nothing its rules read could be refused
const issuesOfResourceNames = (map: SchemaMap): ValidationIssue[] => {
  const far = new Set(
    bridgesWalkedFromRecords(map).flatMap(({ endpoints }) => endpoints.map(endpointKey)),
  );
  return Object.keys(map.permissions).flatMap((resource) => {
    const why = whyNameIsNoModel(map, resource);
    if (why) return [lensIssue(resource, why)];
    if (modelOfResource(map, resource) || far.has(resource)) return [];
    return [lensIssue(resource, resourceHasNoFieldMap(resource))];
  });
};

// Every read, action and operator issue of a map's well-formed rules, by `resource.action`.
const readIssues = (map: SchemaMap): ValidationIssue[] => [
  ...issuesOfResourceNames(map),
  ...Object.entries(map.permissions).flatMap(([resource, permission]) =>
    Object.entries(permission?.actions ?? {}).flatMap(([action, rule]) =>
      validateActionRule(rule).ok
        ? relIssues(map, lensesAtRow(map, resource), rule, `${resource}.${action}`)
        : [],
    ),
  ),
];

/** Every issue of a map's rules and resource names that a check refuses on first use, by `resource.action`; the check throws a bridge problem itself. */
export const schemaIssuesRefusedOnFirstUse = (map: SchemaMap): ValidationIssue[] =>
  readIssues(map).filter(isRefusedByACheck);

// why: a row that hydrates this much is doing too much; it is reported, not refused
const lensWarnings = (map: SchemaMap): ValidationIssue[] =>
  Object.keys(map.permissions).flatMap((resource) => {
    const size = countRelationsOneRowHydrates(map, resource);
    return size > relationLensLimits.report
      ? [
          {
            path: resource,
            code: 'countRelationsOneRowHydrates',
            message: `a \`${resource}\` row hydrates ${size} relations (over ${relationLensLimits.report}): split the walk, or mark an edge \`hydrate: false\``,
          },
        ]
      : [];
  });

/**
 * A whole map, for a test or boot. A map whose names are wrong cannot be indexed, so its name and
 * bridge problems are all that is reported. Otherwise: its bridges, every rule well formed,
 * positive and inside the lens, every action defined (`errors`), and every resource whose row
 * hydrates too much (`warnings`). A malformed `@permissions` annotation still throws, from the index.
 */
export const validateSchema = (
  map: SchemaMap,
): ValidationResult & { warnings: ValidationIssue[] } => {
  const nameProblems = problemsOfMapNames(map);
  if (nameProblems.length)
    return {
      ok: false,
      errors: [...nameProblems.map((message) => lensIssue('$', message)), ...issuesOfBridges(map)],
      warnings: [],
    };
  const errors = [
    ...issuesOfEveryActionRule(map, true),
    ...issuesOfBridges(map),
    ...readIssues(map),
  ];
  return { ok: errors.length === 0, errors, warnings: lensWarnings(map) };
};
