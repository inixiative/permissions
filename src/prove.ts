import { type Condition, check as checkRule, prefixConditionFields } from '@inixiative/json-rules';
import { isNil } from 'lodash-es';
import { bridgeHop } from './bridgeHop';
import type { Walk } from './evaluate';
import { asOwner, nodeId, permixId } from './identity';
import { onPath } from './onPath';
import { recordId } from './recordId';
import type { ActionRule, PermixLike, Row } from './types';

// What the writer's authority on a record rests on: `true` (the table or schema, nothing to carry),
// a condition (the `where`s of the entitlements it needed, read from this record), or `false`.
export type Proof = true | false | Condition;

const anyProof = (proofs: Proof[]): Proof => {
  if (proofs.includes(true)) return true;
  const held = proofs.filter((p): p is Condition => p !== false);
  if (!held.length) return false;
  return held.length === 1 ? held[0] : { any: held };
};

const allProof = (proofs: Proof[]): Proof => {
  if (proofs.includes(false)) return false;
  const held = proofs.filter((p): p is Condition => p !== true);
  if (!held.length) return true;
  return held.length === 1 ? held[0] : { all: held };
};

const reroot = (proof: Proof, prefix: string): Proof => {
  if (proof === true || proof === false) return proof;
  try {
    return prefixConditionFields(proof, prefix, { paths: true });
  } catch {
    return false;
  }
};

const entitledProof = <R extends string>(
  walk: Walk<R>,
  permix: PermixLike,
  resource: R,
  record: Row,
  action: string,
  visited: Set<string>,
): Proof => {
  const actor = permix.getActor();
  return anyProof(
    (permix.entitlements?.(resource, action) ?? [])
      .filter(
        ({ anchor, owner }) =>
          !visited.has(`${permixId(owner)}:${nodeId(record)}:${resource}:${action}`) &&
          onPath(walk.directOwner, resource, record, anchor),
      )
      .map(({ where, owner }) =>
        allProof([
          where === undefined ? true : where,
          prove(walk, asOwner(owner, actor), resource, record, action, new Set(visited)),
        ]),
      ),
  );
};

export const prove = <R extends string>(
  walk: Walk<R>,
  permix: PermixLike,
  resource: R,
  record: Row,
  actionOrRule: ActionRule,
  visited: Set<string>,
): Proof => {
  if (permix.isSuperadmin?.()) return true;
  if (isNil(actionOrRule)) return false;
  if (typeof actionOrRule === 'boolean') return actionOrRule;

  if (typeof actionOrRule === 'string') {
    if (permix.check(resource, actionOrRule, recordId(record))) return true;
    const key = `${permixId(permix)}:${nodeId(record)}:${resource}:${actionOrRule}`;
    if (visited.has(key)) return false;
    visited.add(key);
    const schemaRule = walk.schema.permissions[resource]?.actions[actionOrRule] ?? null;
    const rowRule = (record.permissionRules as Record<string, ActionRule> | null | undefined)?.[
      actionOrRule
    ];
    const merged: ActionRule = rowRule !== undefined ? { any: [schemaRule, rowRule] } : schemaRule;
    return anyProof([
      prove(walk, permix, resource, record, merged, visited),
      entitledProof(walk, permix, resource, record, actionOrRule, visited),
    ]);
  }

  const rule = actionOrRule;
  if ('rel' in rule && 'action' in rule) {
    let currentResource = resource;
    let current: Row = record;
    for (const segment of rule.rel.split('.')) {
      if (bridgeHop(walk.schema.bridges, currentResource, segment)) return false;
      const related = current[segment] as Row | null | undefined;
      if (!related || Array.isArray(related)) return false;
      const next = walk.resolveRelation(currentResource, segment);
      if (!next) return false;
      current = related;
      currentResource = next;
    }
    return reroot(prove(walk, permix, currentResource, current, rule.action, visited), rule.rel);
  }

  if ('rule' in rule)
    return checkRule(rule.rule, { ...record, __actor: permix.getActor() }) === true;
  if ('any' in rule)
    return anyProof(
      rule.any.map((r) => prove(walk, permix, resource, record, r, new Set(visited))),
    );
  if ('all' in rule)
    return allProof(
      rule.all.map((r) => prove(walk, permix, resource, record, r, new Set(visited))),
    );
  return false;
};
