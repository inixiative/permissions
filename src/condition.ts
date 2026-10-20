import { type Condition, check as checkRule } from '@inixiative/json-rules';
import { defaultSelfId } from './actor';
import {
  bridgeHop,
  collectionRule,
  createRebacCheck,
  isCollectionCheck,
  isPermixLeaf,
} from './check';
import type {
  ActionRule,
  Actor,
  CollectionCheck,
  PermixExpression,
  PermixLike,
  RebacSchema,
  ResolveRelation,
  Row,
} from './types';

/** A permix the compiler can read entry by entry. */
export type ConditionPermix = PermixLike & Required<Pick<PermixLike, 'rules' | 'heldIds'>>;

/**
 * `over` answers a superset of the rows the holder reaches, `under` a subset: an arm the compiler
 * can't express (a bridge hop, a row's `permissionRules`, a walk deeper than `maxDepth`) is `true`
 * when over-approximating and `false` when under-approximating.
 */
export type Approximation = 'over' | 'under';

export type ConditionCompilerDeps<R extends string = string> = {
  resolveRelation: ResolveRelation<R>;
  /** Whether `segment` on `resource` is a to-many relation (the engine never walks those). */
  isToMany: (resource: R, segment: string) => boolean;
  /** Whether rows of `resource` may carry their own `permissionRules`. */
  hasRowRules?: (resource: R) => boolean;
  selfResource?: R;
  selfId?: (actor: Actor | null) => string | null;
  maxDepth?: number;
};

const any = (arms: Condition[]): Condition => {
  const flat = arms.flatMap((arm) =>
    typeof arm === 'object' && arm !== null && 'any' in arm ? arm.any : [arm],
  );
  if (flat.some((arm) => arm === true)) return true;
  const kept = flat.filter((arm) => arm !== false);
  if (kept.length === 0) return false;
  return kept.length === 1 ? (kept[0] as Condition) : { any: kept };
};

const all = (arms: Condition[]): Condition => {
  const flat = arms.flatMap((arm) =>
    typeof arm === 'object' && arm !== null && 'all' in arm ? arm.all : [arm],
  );
  if (flat.some((arm) => arm === false)) return false;
  const kept = flat.filter((arm) => arm !== true);
  if (kept.length === 0) return true;
  return kept.length === 1 ? (kept[0] as Condition) : { all: kept };
};

/**
 * Rebase a json-rules condition onto a related record: `field` and `path` gain `prefix`. Conditions
 * nested inside an array or aggregate rule are element-relative and stay as they are.
 */
export const prefixCondition = (condition: Condition, prefix: string): Condition => {
  if (!prefix || typeof condition === 'boolean') return condition;
  if ('all' in condition)
    return { ...condition, all: condition.all.map((c) => prefixCondition(c, prefix)) };
  if ('any' in condition)
    return { ...condition, any: condition.any.map((c) => prefixCondition(c, prefix)) };
  if ('if' in condition)
    return {
      ...condition,
      if: prefixCondition(condition.if, prefix),
      then: prefixCondition(condition.then, prefix),
      ...(condition.else === undefined ? {} : { else: prefixCondition(condition.else, prefix) }),
    };
  const rebased = { ...condition } as Record<string, unknown>;
  if (typeof rebased.field === 'string') rebased.field = `${prefix}${rebased.field}`;
  if (typeof rebased.path === 'string') rebased.path = `${prefix}${rebased.path}`;
  return rebased as Condition;
};

/**
 * Build `toCondition`: compile what a permix expression reaches for `(resource, action)` into one
 * json-rules condition over a row of `resource`, mirroring the engine. The caller owns what it does
 * with it (compare reaches, build a query). Superadmin, or an action held resource-wide, is `true`.
 */
export const createConditionCompiler = <R extends string = string>(
  deps: ConditionCompilerDeps<R>,
) => {
  const { resolveRelation, isToMany, hasRowRules, selfResource, maxDepth = 6 } = deps;
  const selfIdOf = deps.selfId ?? defaultSelfId;
  const engine = createRebacCheck(resolveRelation, { selfResource, selfId: selfIdOf });

  const compile = (
    permix: ConditionPermix,
    schema: RebacSchema<R>,
    resource: R,
    rule: ActionRule,
    prefix: string,
    approximation: Approximation,
    visited: Set<string>,
    depth: number,
  ): Condition => {
    const inexact: Condition = approximation === 'over';
    const recurse = (next: ActionRule, at: R = resource, path = prefix, nextDepth = depth) =>
      compile(permix, schema, at, next, path, approximation, new Set(visited), nextDepth);

    if (permix.isSuperadmin?.()) return true;
    if (rule === null) return false;
    if (typeof rule === 'boolean') return rule;

    if (typeof rule === 'string') {
      if (permix.check(resource, rule)) return true; // held on the whole resource
      const key = `${prefix}|${resource}|${rule}`;
      if (visited.has(key))
        throw new Error(`Cycle detected in permission graph: ${resource}.${rule}`);
      visited.add(key);
      const ids = permix.heldIds(resource, rule);
      const arms: Condition[] = [];
      if (ids.length) arms.push({ field: `${prefix}id`, operator: 'in', value: ids } as Condition);
      for (const entry of permix.rules(resource, rule)) {
        const compiled = recurse(entry.rule);
        arms.push(
          entry.id === undefined
            ? compiled
            : all([
                { field: `${prefix}id`, operator: 'equals', value: entry.id } as Condition,
                compiled,
              ]),
        );
      }
      arms.push(recurse(schema.permissions[resource]?.actions[rule] ?? null));
      if (hasRowRules?.(resource)) arms.push(inexact);
      return any(arms);
    }

    if ('rel' in rule) {
      let at = resource;
      let path = prefix;
      for (const segment of rule.rel.split('.')) {
        if (bridgeHop(schema.bridges, at, segment)) return inexact;
        if (isToMany(at, segment)) return false;
        const next = resolveRelation(at, segment);
        if (!next) return false;
        at = next;
        path = `${path}${segment}.`;
      }
      if (depth + 1 > maxDepth) return inexact;
      return recurse(rule.action, at, path, depth + 1);
    }

    if ('self' in rule) {
      const actor = permix.getActor();
      const selfId = selfIdOf(actor);
      if (selfId === null) return false;
      if (rule.action !== undefined) {
        if (!selfResource) throw new Error('A self arm with an action needs selfResource');
        const holds = engine(
          permix,
          schema,
          { resource: selfResource, record: { id: selfId } },
          rule.action,
        );
        if (!holds) return false;
      }
      return { field: `${prefix}${rule.self}`, operator: 'equals', value: selfId } as Condition;
    }

    if ('actor' in rule) {
      const actor = permix.getActor();
      return actor !== null && checkRule(rule.actor, actor as unknown as Row) === true;
    }

    if ('rule' in rule) return prefixCondition(rule.rule, prefix);
    if ('any' in rule) return any(rule.any.map((arm) => recurse(arm)));
    if ('all' in rule) return all(rule.all.map((arm) => recurse(arm)));
    return false;
  };

  /**
   * What `expression` reaches for `actionOrRule` on rows of `resource`, as one json-rules condition
   * (`true` = every row, `false` = none). Each permix leaf must expose `rules` and `heldIds`.
   */
  const toCondition = (
    expression: PermixExpression<ConditionPermix>,
    schema: RebacSchema<R>,
    resource: R,
    actionOrRule: ActionRule | CollectionCheck,
    approximation: Approximation,
  ): Condition => {
    const rule = isCollectionCheck(actionOrRule)
      ? collectionRule(schema, resource, actionOrRule.collection)
      : actionOrRule;
    const run = (node: PermixExpression<ConditionPermix>): Condition => {
      if (isPermixLeaf(node))
        return compile(node, schema, resource, rule, '', approximation, new Set(), 0);
      if ('any' in node) return any(node.any.map(run));
      return all(node.all.map(run));
    };
    return run(expression);
  };

  return { toCondition };
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

type Membership = { field: string; values: unknown[]; rest: string };

// `field equals x` / `field in [xs]` as a set, plus everything else about the leaf.
const asMembership = (condition: Condition): Membership | null => {
  if (typeof condition !== 'object' || condition === null || !('operator' in condition))
    return null;
  const { field, operator, value, ...rest } = condition as Record<string, unknown>;
  if (typeof field !== 'string' || 'path' in rest || 'bind' in rest) return null;
  if (operator === 'equals') return { field, values: [value], rest: canonical(rest) };
  if (operator === 'in' && Array.isArray(value))
    return { field, values: value, rest: canonical(rest) };
  return null;
};

const leafImplies = (h: Condition, i: Condition): boolean => {
  if (canonical(h) === canonical(i)) return true;
  const hm = asMembership(h);
  const im = asMembership(i);
  if (!hm || !im || hm.field !== im.field || hm.rest !== im.rest) return false;
  const allowed = new Set(im.values.map(canonical));
  return hm.values.every((value) => allowed.has(canonical(value)));
};

const isAny = (c: Condition): c is { any: Condition[] } =>
  typeof c === 'object' && c !== null && 'any' in c;
const isAll = (c: Condition): c is { all: Condition[] } =>
  typeof c === 'object' && c !== null && 'all' in c;

/**
 * Does every row matching `h` match `i`? Syntactic and sound but incomplete: `true` is a proof,
 * `false` means "not shown". Leaves match by canonical JSON; `field equals/in` compare as sets.
 */
export const implies = (h: Condition, i: Condition): boolean => {
  if (i === true || h === false) return true;
  if (i === false || h === true) return false;
  if (isAny(h)) return h.any.every((arm) => implies(arm, i));
  if (isAll(i)) return i.all.every((conjunct) => implies(h, conjunct));
  if (isAny(i) && i.any.some((arm) => implies(h, arm))) return true;
  if (isAll(h) && h.all.some((conjunct) => implies(conjunct, i))) return true;
  return leafImplies(h, i);
};
