import { type Absent, type BridgeDictionary, check as checkRule } from '@inixiative/json-rules';
import { isNil, isPlainObject } from 'lodash-es';
import type { Algebra } from './algebra';
import { bridgeHop, lookupFar } from './bridgeHop';
import { entitled } from './entitled';
import { nodeId, permixId } from './identity';
import { type LensNode, lensOf } from './lens';
import { recordId } from './recordId';
import type { SchemaMap } from './schemaMap';
import type { ActionRule, PermixLike, RebacSchema, Row } from './types';
import { validateActionRule } from './validateActionRule';
import { actionRuleLensIssues } from './validateSchema';

// One walk: the app's schema map, the schema, the bridge dictionary built on first use, and how
// what it finds combines (a boolean for `check`, every admission for `paths`).
export type Walk<R extends string, T = boolean> = {
  map: SchemaMap<R>;
  absent: Absent;
  schema: RebacSchema<R>;
  getDict: () => BridgeDictionary | undefined;
  algebra: Algebra<T>;
  /** The grant check's liveness walk: every entitlement `where` counts as holding. */
  ignoreWheres?: boolean;
  /**
   * The grant check's first pass: the hydrated rows above the granted record (`rowsAbove`). An
   * entitlement counts only at one of these rows, marked `grantsBelow`, without a `where`.
   */
  above?: ReadonlySet<Row>;
  /** The item's lens node once the walk has crossed a list: a missing column is unknown, a bridge denies, the first pass counts nothing. */
  under?: LensNode<R>;
  /** Relation hops crossed on this path: a node met again after one is a data loop, which denies. */
  hops?: number;
};

/** The nodes a path has stood on, each with the relation hops crossed when it was reached. */
export type Visited = Map<string, number>;

const noRows: ReadonlySet<Row> = new Set();

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

  if (typeof actionOrRule === 'string') {
    const action = actionOrRule;
    // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
    const granted = permix.check(resource, action, recordId(record));
    return algebra.any([
      () => (granted ? algebra.unit : algebra.none),
      () => walkAction(walk, permix, resource, record, action, visited),
    ]);
  }
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
  const key = `${permixId(permix)}:${nodeId(record)}:${resource}:${actionOrRule}`;
  const hops = walk.hops ?? 0;
  // why: a loop with no hop is a schema naming itself (a bug, it throws); one through a hop is data, and denies
  if (visited.has(key))
    return visited.get(key) === hops
      ? walk.algebra.loop(resource, actionOrRule)
      : walk.algebra.none;
  visited.set(key, hops);

  const schemaRule = walk.schema.permissions[resource]?.actions[actionOrRule] ?? null;
  const rowRules = record.permissionRules as Record<string, ActionRule> | null | undefined;
  const rowRule = rowRules?.[actionOrRule];
  const rowRuleHolds =
    rowRule !== undefined &&
    validateActionRule(rowRule, {
      schema: walk.schema,
      resource,
      action: actionOrRule,
      rowRules,
    }).ok &&
    actionRuleLensIssues(walk.map, walk.schema, resource, rowRule).length === 0;
  // Row-level override is additive (OR) with the schema rule — a per-record grant can only widen.
  const merged: ActionRule = rowRuleHolds ? { any: [schemaRule, rowRule] } : schemaRule;
  return walk.algebra.any([
    () => evaluate(walk, permix, resource, record, merged, visited),
    () => entitled(walk, permix, resource, record, actionOrRule, visited),
  ]);
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
  // why: `visited` is forked per item, since two items reaching one row are parallel paths, not a cycle
  if ('arrayOperator' in rule) {
    const list = lensOf(walk.map, resource).lists.get(rule.rel);
    const items = record[rule.rel];
    if (!list || !Array.isArray(items)) return algebra.none;
    const under: Walk<R, T> = {
      ...walk,
      absent: 'unknown',
      under: list.item,
      hops: (walk.hops ?? 0) + 1,
      ...(walk.above ? { above: noRows } : {}),
    };
    return algebra.any(
      items
        .filter((item): item is Row => isPlainObject(item))
        .map(
          (item) => () =>
            evaluate(under, permix, list.resource, item, rule.condition, new Map(visited)),
        ),
    );
  }
  if ('rel' in rule && 'action' in rule) {
    const segments = rule.rel.split('.');
    let currentResource = resource;
    let current: Row = record;
    let node = walk.under;
    for (const segment of segments) {
      const hop = bridgeHop(walk.schema.bridges, currentResource, segment);
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
        const at = node ?? lensOf(walk.map, currentResource);
        const next = at.toOne.get(segment);
        if (!next) return algebra.none;
        if (node) node = at.below(segment);
        current = related;
        currentResource = next.resource;
      }
    }
    const hopped = { ...walk, hops: (walk.hops ?? 0) + 1, ...(node ? { under: node } : {}) };
    return evaluate(hopped, permix, currentResource, current, rule.action, visited);
  }

  if ('rule' in rule) {
    return checkRule(
      rule.rule,
      { ...record, __actor: permix.getActor() },
      { absent: walk.absent },
    ) === true
      ? algebra.unit
      : algebra.none;
  }
  // Fork `visited` per branch — parallel paths through any/all aren't cycles.
  if ('any' in rule) {
    return algebra.any(
      rule.any.map((r) => () => evaluate(walk, permix, resource, record, r, new Map(visited))),
    );
  }
  if ('all' in rule) {
    return algebra.all(
      rule.all.map((r) => () => evaluate(walk, permix, resource, record, r, new Map(visited))),
    );
  }

  return algebra.none;
};
