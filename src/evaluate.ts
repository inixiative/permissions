import { type Absent, type BridgeDictionary, check as checkRule } from '@inixiative/json-rules';
import { isNil } from 'lodash-es';
import { bridgeHop, lookupFar } from './bridgeHop';
import { entitled } from './entitled';
import { nodeId, permixId } from './identity';
import { recordId } from './recordId';
import type { SchemaMap } from './schemaMap';
import type { ActionRule, PermixLike, RebacSchema, Row } from './types';

// One check's walk: the app's schema map and its relation resolver, the schema, and the bridge
// dictionary built on first use.
export type Walk<R extends string> = {
  map: SchemaMap<R>;
  resolveRelation: (resource: R, segment: string) => R | null;
  absent: Absent;
  schema: RebacSchema<R>;
  getDict: () => BridgeDictionary | undefined;
};

export const evaluate = <R extends string>(
  walk: Walk<R>,
  permix: PermixLike,
  resource: R,
  record: Row,
  actionOrRule: ActionRule,
  visited: Set<string>,
): boolean => {
  if (permix.isSuperadmin?.()) return true;
  if (isNil(actionOrRule)) return false; // null = terminal deny
  if (typeof actionOrRule === 'boolean') return actionOrRule; // true = allow, false = deny

  if (typeof actionOrRule === 'string') {
    // permix holds the actor's directly-granted (role-derived) actions — a grant short-circuits.
    if (permix.check(resource, actionOrRule, recordId(record))) return true;

    // Key by resource too: the same record object reached as a different resource (a self-join) is
    // a distinct node, not a cycle. Key by table too: an owner walk legitimately revisits the node.
    const key = `${permixId(permix)}:${nodeId(record)}:${resource}:${actionOrRule}`;
    if (visited.has(key)) {
      throw new Error(`Cycle detected in permission graph: ${resource}.${actionOrRule}`);
    }
    visited.add(key);

    const schemaRule = walk.schema.permissions[resource]?.actions[actionOrRule] ?? null;
    const rowRules = record.permissionRules as Record<string, ActionRule> | null | undefined;
    const rowRule = rowRules?.[actionOrRule];
    // Row-level override is additive (OR) with the schema rule — a per-record grant can only widen.
    const merged: ActionRule = rowRule !== undefined ? { any: [schemaRule, rowRule] } : schemaRule;
    if (evaluate(walk, permix, resource, record, merged, visited)) return true;
    return entitled(walk, permix, resource, record, actionOrRule, visited);
  }

  const rule = actionOrRule;
  if ('rel' in rule && 'action' in rule) {
    const segments = rule.rel.split('.');
    let currentResource = resource;
    let current: Row = record;
    for (const segment of segments) {
      const hop = bridgeHop(walk.schema.bridges, currentResource, segment);
      if (hop) {
        const farId = current[hop.localOn];
        if (isNil(farId)) return false;
        const far = lookupFar(walk.getDict(), hop, String(farId));
        if (!far) return false;
        current = far;
        currentResource = hop.farResource as R;
      } else {
        const related = current[segment] as Row | null | undefined;
        if (!related || Array.isArray(related)) return false;
        const next = walk.resolveRelation(currentResource, segment);
        if (!next) return false;
        current = related;
        currentResource = next;
      }
    }
    return evaluate(walk, permix, currentResource, current, rule.action, visited);
  }

  if ('rule' in rule) {
    return (
      checkRule(rule.rule, { ...record, __actor: permix.getActor() }, { absent: walk.absent }) ===
      true
    );
  }
  // Fork `visited` per branch — parallel paths through any/all aren't cycles.
  if ('any' in rule) {
    return rule.any.some((r) => evaluate(walk, permix, resource, record, r, new Set(visited)));
  }
  if ('all' in rule) {
    return rule.all.every((r) => evaluate(walk, permix, resource, record, r, new Set(visited)));
  }

  return false;
};
