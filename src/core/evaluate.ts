import { type BridgeDictionary, check as checkRule, pathSegments } from '@inixiative/json-rules';
import { isNil, isPlainObject } from 'lodash-es';
import type { Algebra } from './algebra';
import { bridgeHop, lookupFar } from './bridgeHop';
import { entitled } from './entitled';
import { answerOnce } from './freezeThenJudgeOnce';
import { permixId, rowId } from './identity';
import type { PositionUnderListItem } from './lens';
import { recordId } from './recordId';
import { listOf, relationOf } from './relations';
import { identityKeyOfRow } from './rowKeys';
import type { ResolvedSchemaMap } from './schemaMap';
import { bridgesWalkedFromRecords, recordWithSuppliedData, suppliedModelAt } from './supplied';
import type { ActionRule, AdditionalRules, PermixLike, Row } from './types';
import { validateActionRule } from './validateActionRule';

// One walk: the app's schema map, the schema, the bridge dictionary built on first use, and how
// what it finds combines (a boolean for `check`, every admission for `paths`).
export type Walk<R extends string, T = boolean> = {
  schemaMap: ResolvedSchemaMap<R>;
  getDict: () => BridgeDictionary | undefined;
  /** The supplied maps' joined bridges' rows, indexed once per check. */
  suppliedDictionary: () => BridgeDictionary | undefined;
  /** The check's `bridgeData`: every bridge's rows, the supplied models' read by each `{ rule }`. */
  bridgeData?: Record<string, Row[]>;
  algebra: Algebra<T>;
  /** The app's extra rule sets for a record, ORed in beside its own `permissionRules`. */
  additionalRules?: AdditionalRules;
  /** The grant check's liveness walk: every entitlement `where` counts as holding. */
  ignoreWheres?: boolean;
  /**
   * The grant check's first pass: the hydrated rows above the granted record (`rowsAbove`). An
   * entitlement counts only at one of these rows, marked `grantsBelow`, without a `where`.
   */
  above?: ReadonlySet<Row>;
  /** The item's lens node once the walk has crossed a list: a missing column is unknown, a bridge denies, the first pass counts nothing. */
  under?: PositionUnderListItem;
  /** The engine's id field, read once per check. */
  idField: string;
  /** Relation hops crossed on this path: a node met again after one is a data loop, which denies. */
  hops?: number;
  /** What this one check remembers; fresh for each check, shared by every copy of its walk. */
  oneCheck: WhatOneCheckRemembers<T>;
};

/** `footprint`: the answers its walk walked or reused; it holds while none of their keys, at any depth, is on the path. */
type RememberedAnswer<T> = {
  key: string;
  answer: T;
  footprint: RememberedAnswer<T>[] | undefined;
  checkedAt: number;
};

/** `answers`: by row object, then walk mode and node key, each kept only when no test in its walk found a node on the path. */
type WhatOneCheckRemembers<T = unknown> = {
  rowIds: WeakMap<Row, Map<string, string>>;
  rowRulesThatHold: WeakMap<Row, Map<string, boolean>>;
  additionalRulesThatHold: WeakMap<Row, Map<string, ActionRule[]>>;
  answers: WeakMap<Row, Map<string, RememberedAnswer<T>>> | undefined;
  nodesFoundOnPath: number;
  /** null at no hops, where nothing is kept; undefined until a node past a hop meets its first child. */
  footprintOfThisNode: RememberedAnswer<T>[] | undefined | null;
  footprintChecks: number;
};

export const startOneCheck = <T>(): WhatOneCheckRemembers<T> => ({
  rowIds: new WeakMap(),
  rowRulesThatHold: new WeakMap(),
  additionalRulesThatHold: new WeakMap(),
  answers: undefined,
  nodesFoundOnPath: 0,
  footprintOfThisNode: null,
  footprintChecks: 0,
});

/** A row's id on the walk, computed once per row and resource in one check. */
export const identifyRowOncePerCheck = <R extends string, T>(
  walk: Walk<R, T>,
  resource: string,
  record: Row,
): string =>
  answerOnce(walk.oneCheck.rowIds, record, resource, () =>
    rowId(record, identityKeyOfRow(walk.schemaMap, resource, record, walk.idField)),
  );

/** The nodes on the current path, each with the relation hops crossed when it was reached; a node leaves when its walk returns. */
export type Visited = Map<string, number>;

/** Whether node `key` is on the current path, counted on the check when it is. */
export const isNodeOnPath = <R extends string, T>(
  { oneCheck }: Walk<R, T>,
  visited: Visited,
  key: string,
): boolean => {
  if (!visited.has(key)) return false;
  oneCheck.nodesFoundOnPath++;
  return true;
};

const addToFootprint = <T>(oneCheck: WhatOneCheckRemembers<T>, answer: RememberedAnswer<T>) => {
  if (oneCheck.footprintOfThisNode) oneCheck.footprintOfThisNode.push(answer);
  else if (oneCheck.footprintOfThisNode === undefined) oneCheck.footprintOfThisNode = [answer];
};

const isFootprintOnPath = <T>(
  footprint: RememberedAnswer<T>[],
  visited: Visited,
  check: number,
): boolean => {
  for (const answer of footprint) {
    if (answer.checkedAt === check) continue;
    answer.checkedAt = check;
    if (visited.has(answer.key)) return true;
    if (answer.footprint && isFootprintOnPath(answer.footprint, visited, check)) return true;
  }
  return false;
};

const noRows: ReadonlySet<Row> = new Set();

// why: under a list item an answer depends on the lens position; in the first pass, on which rows are above
const modeOfWalk = <R extends string, T>({ above, under }: Walk<R, T>): string =>
  above === undefined && under === undefined
    ? ''
    : `${above === undefined ? '' : above === noRows ? 'no rows above' : 'rows above'}|${under ? `${under.list}:${under.prefix.join('.')}` : ''}|`;

export const evaluate = <R extends string, T>(
  walk: Walk<R, T>,
  permix: PermixLike,
  resource: R,
  record: Row,
  actionOrRule: ActionRule,
  visited: Visited,
): T => {
  const { algebra } = walk;
  if (permix.isSuperadmin?.()) return algebra.unit;
  if (isNil(actionOrRule)) return algebra.none; // null = terminal deny
  if (typeof actionOrRule === 'boolean') return actionOrRule ? algebra.unit : algebra.none;

  if (typeof actionOrRule === 'string')
    return walkAction(walk, permix, resource, record, actionOrRule, visited);
  return walkRule(walk, permix, resource, record, actionOrRule, visited);
};

const walkAction = <R extends string, T>(
  walk: Walk<R, T>,
  permix: PermixLike,
  resource: R,
  record: Row,
  actionOrRule: string,
  visited: Visited,
): T => {
  // Key by resource too: the same record object reached as a different resource (a self-join) is
  // a distinct node, not a cycle. Key by table too: an owner walk legitimately revisits the node.
  const key = `${permixId(permix)}:${identifyRowOncePerCheck(walk, resource, record)}:${resource}:${actionOrRule}`;
  const hops = walk.hops ?? 0;
  const { algebra, oneCheck } = walk;
  // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
  const granted = () =>
    permix.check(resource, actionOrRule, recordId(record, walk.idField))
      ? algebra.unit
      : algebra.none;
  // why: a loop with no hop is a schema naming itself (a bug, it throws); one through a hop is data, and denies
  if (isNodeOnPath(walk, visited, key))
    return algebra.any([
      granted,
      () => (visited.get(key) === hops ? algebra.loop(resource, actionOrRule) : algebra.none),
    ]);
  const walkRules = () => {
    visited.set(key, hops);
    try {
      return walkActionRules(walk, permix, resource, record, actionOrRule, visited);
    } finally {
      visited.delete(key);
    }
  };
  // why: a node at no hops is on the starting row, where the walk is shallow; only a hop makes it repeat
  if (hops === 0) return algebra.any([granted, walkRules]);
  oneCheck.answers ??= new WeakMap();
  let byNode = oneCheck.answers.get(record);
  if (!byNode) {
    byNode = new Map();
    oneCheck.answers.set(record, byNode);
  }
  const node = modeOfWalk(walk) + key;
  const remembered = byNode.get(node);
  if (
    remembered &&
    !(
      remembered.footprint &&
      isFootprintOnPath(remembered.footprint, visited, ++oneCheck.footprintChecks)
    )
  ) {
    addToFootprint(oneCheck, remembered);
    return remembered.answer;
  }
  const footprintOfCaller = oneCheck.footprintOfThisNode;
  oneCheck.footprintOfThisNode = undefined;
  const foundBefore = oneCheck.nodesFoundOnPath;
  let answer: T;
  let footprint: RememberedAnswer<T>[] | undefined;
  try {
    answer = algebra.any([granted, walkRules]);
  } finally {
    footprint = oneCheck.footprintOfThisNode;
    oneCheck.footprintOfThisNode = footprintOfCaller;
  }
  if (oneCheck.nodesFoundOnPath === foundBefore) {
    const kept: RememberedAnswer<T> = { key, answer, footprint, checkedAt: 0 };
    byNode.set(node, kept);
    addToFootprint(oneCheck, kept);
  }
  return answer;
};

const walkActionRules = <R extends string, T>(
  walk: Walk<R, T>,
  permix: PermixLike,
  resource: R,
  record: Row,
  actionOrRule: string,
  visited: Visited,
): T => {
  const schemaRule = walk.schemaMap.permissions[resource]?.actions[actionOrRule] ?? null;
  const rowRules = record.permissionRules as Record<string, ActionRule> | null | undefined;
  const additionalRules = (walk.additionalRules?.(resource, record) ?? []).filter(
    (rules): rules is Record<string, ActionRule> => isPlainObject(rules),
  );
  // why: a stored or additional rule is judged as the map's own are: one that is not positive, loops or reads outside the lens throws
  const holds = (rule: ActionRule) => {
    const [problem] = validateActionRule(rule, {
      schemaMap: walk.schemaMap,
      resource,
      action: actionOrRule,
      rowRules,
      additionalRules,
    }).errors;
    if (problem)
      throw new Error(
        `a rule for \`${resource}.${actionOrRule}\` stored outside the map is refused: \`${problem.path}\`: ${problem.message}`,
      );
    return true;
  };
  const node = `${resource}\u0000${actionOrRule}`;
  const rowRule = rowRules?.[actionOrRule];
  const rowRuleHolds =
    rowRule !== undefined &&
    answerOnce(walk.oneCheck.rowRulesThatHold, record, node, () => holds(rowRule));
  const additionalRulesThatHold = additionalRules.length
    ? answerOnce(walk.oneCheck.additionalRulesThatHold, record, node, () =>
        additionalRules.flatMap((rules) => {
          const rule = rules[actionOrRule];
          return rule !== undefined && holds(rule) ? [rule] : [];
        }),
      )
    : [];
  // A record's own rule and the app's additional rules are additive (OR) with the schema rule: each can only widen.
  const added = [...(rowRuleHolds ? [rowRule as ActionRule] : []), ...additionalRulesThatHold];
  const merged: ActionRule = added.length ? { any: [schemaRule, ...added] } : schemaRule;
  return walk.algebra.any([
    () => evaluate(walk, permix, resource, record, merged, visited),
    () => entitled(walk, permix, resource, record, actionOrRule, visited),
  ]);
};

// An item of a supplied list has no actions: only its rules, in any and all, hold on it.
const holdsOnSuppliedRow = (rule: ActionRule, row: Row): boolean => {
  if (typeof rule === 'boolean') return rule;
  if (rule === null || typeof rule !== 'object') return false;
  if ('rule' in rule) return checkRule(rule.rule, row) === true;
  if ('any' in rule) return rule.any.some((child) => holdsOnSuppliedRow(child, row));
  if ('all' in rule) return rule.all.every((child) => holdsOnSuppliedRow(child, row));
  return false;
};

const walkRule = <R extends string, T>(
  walk: Walk<R, T>,
  permix: PermixLike,
  resource: R,
  record: Row,
  rule: Exclude<ActionRule, string | boolean | null>,
  visited: Visited,
): T => {
  const { algebra } = walk;
  if ('arrayOperator' in rule) {
    // why: under an item only the declared down tree exists; a second list is never crossed
    if (walk.under) return algebra.none;
    if (suppliedModelAt(walk.schemaMap, pathSegments(rule.rel)[0] ?? '')) {
      const filled = recordWithSuppliedData(
        walk.schemaMap,
        resource,
        record,
        walk.bridgeData,
        walk.suppliedDictionary(),
      );
      const items = pathSegments(rule.rel).reduce<unknown>(
        (row, segment) => (isPlainObject(row) ? (row as Row)[segment] : undefined),
        filled,
      );
      return Array.isArray(items) &&
        items.some((item) => isPlainObject(item) && holdsOnSuppliedRow(rule.condition, item as Row))
        ? algebra.unit
        : algebra.none;
    }
    const list = listOf(walk.schemaMap, resource, rule.rel);
    const items = record[rule.rel];
    if (!list || !Array.isArray(items)) return algebra.none;
    const under: Walk<R, T> = {
      ...walk,
      under: { list: `${resource}.${rule.rel}`, listRelation: list, prefix: [] },
      hops: (walk.hops ?? 0) + 1,
      ...(walk.above ? { above: noRows } : {}),
    };
    return algebra.any(
      items
        .filter((item): item is Row => isPlainObject(item))
        .map((item) => () => evaluate(under, permix, list.resource, item, rule.condition, visited)),
    );
  }
  if ('rel' in rule && 'action' in rule) {
    const segments = rule.rel.split('.');
    let currentResource = resource;
    let current: Row = record;
    const walked: string[] = [];
    for (const segment of segments) {
      const hop = bridgeHop(bridgesWalkedFromRecords(walk.schemaMap), currentResource, segment);
      if (hop) {
        if (walk.under) return algebra.none;
        const farId = current[hop.localOn];
        if (isNil(farId)) return algebra.none;
        const far = lookupFar(walk.getDict(), hop, String(farId));
        if (!far) return algebra.none;
        current = far;
        currentResource = hop.farResource as R;
      } else {
        const related = current[segment] as Row | null | undefined;
        if (!related || Array.isArray(related)) return algebra.none;
        const next = relationOf(walk.schemaMap, currentResource, segment);
        if (!next) return algebra.none;
        walked.push(segment);
        current = related;
        currentResource = next.resource;
      }
    }
    const under = walk.under && { ...walk.under, prefix: [...walk.under.prefix, ...walked] };
    const hopped = { ...walk, hops: (walk.hops ?? 0) + 1, ...(under ? { under } : {}) };
    return evaluate(hopped, permix, currentResource, current, rule.action, visited);
  }

  if ('rule' in rule) {
    const filled = recordWithSuppliedData(
      walk.schemaMap,
      resource,
      record,
      walk.bridgeData,
      walk.suppliedDictionary(),
    );
    return checkRule(rule.rule, filled) === true ? algebra.unit : algebra.none;
  }
  if ('any' in rule) {
    return algebra.any(
      rule.any.map((r) => () => evaluate(walk, permix, resource, record, r, visited)),
    );
  }
  if ('all' in rule) {
    return algebra.all(
      rule.all.map((r) => () => evaluate(walk, permix, resource, record, r, visited)),
    );
  }

  return algebra.none;
};
