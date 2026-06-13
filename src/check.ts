import { check as checkRule } from '@inixiative/json-rules';
import { isNil } from 'lodash-es';
import type { ActionRule, PermixLike, RebacSchema, ResolveModel, Row } from './types';

// Stable identity for cycle detection that does NOT depend on `record.id` — an id may be absent
// (record loaded without selecting it) or collide across models, both of which would make an
// id-based key falsely report a cycle. A WeakMap assigns each visited record object a
// process-unique number; entries are GC'd with the records.
let nodeCounter = 0;
const nodeIds = new WeakMap<object, number>();
const nodeId = (record: object): number => {
  let id = nodeIds.get(record);
  if (id === undefined) {
    id = ++nodeCounter;
    nodeIds.set(record, id);
  }
  return id;
};

export type RebacCheck<M extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<M>,
  model: M,
  record: Row,
  actionOrRule: ActionRule,
  visited?: Set<string>,
) => boolean;

/**
 * Build the rebac check, bound to a relation resolver.
 *
 * `resolveModel(model, segment)` maps a relation field to the model it points at — the ORM-specific
 * bit the app injects (e.g. from a Prisma model map). The returned `check` is the
 * relationship-walking evaluator: `string` delegates to another action (rbac, via permix or schema),
 * `{ rel, action }` walks a relation (rebac), `{ self }` matches the actor, `{ rule }` is an ABAC
 * predicate, and `any`/`all` compose. Cycles throw rather than loop.
 */
export const createRebacCheck = <M extends string = string>(
  resolveModel: ResolveModel<M>,
): RebacCheck<M> => {
  const check: RebacCheck<M> = (
    permix,
    schema,
    model,
    record,
    actionOrRule,
    visited = new Set(),
  ) => {
    if (permix.isSuperadmin?.()) return true;
    if (isNil(actionOrRule)) return false;

    if (typeof actionOrRule === 'string') {
      // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
      if (permix.check(model, actionOrRule, record.id as string | undefined)) return true;

      // Cycle guard for string delegation, keyed by object identity + action (NOT record.id), so
      // self/mutual delegation (`read: 'read'`, `read: 'manage'`/`manage: 'read'`) throws instead of
      // looping, and id-less records never collide. Also catches rel-walks that return to a node.
      const key = `${nodeId(record)}:${actionOrRule}`;
      if (visited.has(key))
        throw new Error(`Cycle detected in permission graph: ${model}.${actionOrRule}`);
      visited.add(key);

      const schemaRule = schema[model]?.actions[actionOrRule] ?? null;
      const rowRules = record.permissionRules as Record<string, ActionRule> | null | undefined;
      const rowRule = rowRules?.[actionOrRule];
      // Row-level override is additive (OR) with the schema rule — a per-record grant can only widen.
      const merged: ActionRule =
        rowRule !== undefined ? { any: [schemaRule, rowRule] } : schemaRule;
      return check(permix, schema, model, record, merged, visited);
    }

    const rule = actionOrRule;
    if ('rel' in rule && 'action' in rule) {
      const segments = rule.rel.split('.');
      let current: Row = record;
      let currentModel = model;
      for (const segment of segments) {
        const related = current[segment] as Row | null | undefined;
        if (!related) return false;
        const targetModel = resolveModel(currentModel, segment);
        if (!targetModel) return false;
        current = related;
        currentModel = targetModel;
      }
      return check(permix, schema, currentModel, current, rule.action, visited);
    }

    if ('self' in rule) {
      const userId = permix.getUserId();
      return userId !== null && record[rule.self] === userId;
    }

    if ('rule' in rule) return checkRule(rule.rule, record) === true;
    // Fork `visited` per branch — parallel paths through any/all aren't cycles.
    if ('any' in rule)
      return rule.any.some((r) => check(permix, schema, model, record, r, new Set(visited)));
    if ('all' in rule)
      return rule.all.every((r) => check(permix, schema, model, record, r, new Set(visited)));

    return false;
  };
  return check;
};
