import { fieldOf, own } from '@inixiative/field-map';
import {
  type Condition,
  declaredEnumValues,
  Operator,
  parseEndpointKey,
} from '@inixiative/json-rules';
import { axisOf, ownerRelationOf, type SchemaMap } from './schemaMap';
import type { ActionRule } from './types';

/**
 * The standard shape of a polymorphic check (Aron 2026-11-19, R-2026-11-19-15): fan out over the
 * kinds, each branch checking its own kind before anything else, every rule positive, and every
 * match against another read checked with `exists` beside it (R-2026-11-21-07).
 */

/** A branch of a fan-out: the rule a kind must also meet, or `true` when its kind check is all. */
export type KindBranch = ActionRule;

const exists = (field: string): Condition => ({ field, operator: Operator.exists });

// A literal kind fails on a missing value on its own, so it needs no exists.
const kindCheck = (field: string, kinds: readonly string[]): ActionRule => {
  if (kinds.length === 0) throw new Error(`a kind check on \`${field}\` names no kind`);
  return {
    rule:
      kinds.length === 1
        ? { field, operator: Operator.equals, value: kinds[0] }
        : { field, operator: Operator.in, value: [...kinds] },
  };
};

const branchOf = (check: ActionRule, rule: KindBranch): ActionRule =>
  rule === true ? check : { all: [check, rule] };

/** `field` equals what `path` reads, with `field` checked to exist first, since two missing values match (`ownerId` is `actor:User.id`). */
export const ruleFieldEqualsPath = (field: string, path: string): ActionRule => ({
  rule: { all: [exists(field), { field, operator: Operator.equals, path }] },
});

/**
 * The rule builders for one map, each reading its kinds from the map so no app restates them. A
 * side is a resource and its polymorphic axis (`map.polymorphism`), or a supplied model and one of
 * its enum fields (`'actor:Acting'`, `'model'`), whose values are its kinds.
 */
export const makeKindRules = <R extends string>(map: SchemaMap<R>) => {
  const suppliedMapOf = (side: string) =>
    side.includes(':') ? own(map.supplied ?? {}, parseEndpointKey(side, '').mapName) : undefined;
  const kindsOf = (side: string, field: string): string[] => {
    const suppliedMap = suppliedMapOf(side);
    if (suppliedMap) {
      const entry = fieldOf(suppliedMap, parseEndpointKey(side, '').modelName, field);
      const values =
        entry?.kind === 'enum' ? declaredEnumValues(entry, suppliedMap.enums) : undefined;
      if (!values) throw new Error(`\`${side}.${field}\` is not an enum field of a supplied model`);
      return [...values];
    }
    const axis = axisOf(map, side as R, field);
    if (!axis)
      throw new Error(`\`${side}\` has no polymorphic axis \`${field}\` in map.polymorphism`);
    return Object.keys(axis.fkMap);
  };
  const declared = (side: string, field: string, kinds: readonly string[]) => {
    const known = kindsOf(side, field);
    for (const kind of kinds)
      if (!known.includes(kind)) throw new Error(`\`${side}.${field}\` has no kind \`${kind}\``);
  };
  // A supplied side is read at its key; a resource's at `at`, the path from the row the rule is on.
  const read = (side: string, field: string, at: string) =>
    suppliedMapOf(side) ? `${side}.${field}` : `${at}${field}`;

  return {
    /** The side's kind is one of `kinds`. */
    ruleKindIsOneOf: (
      side: string,
      field: string,
      kinds: readonly string[],
      at = '',
    ): ActionRule => {
      declared(side, field, kinds);
      return kindCheck(read(side, field, at), kinds);
    },

    /** A fan-out over a side's kinds: one branch per kind given, each checking its own kind first.
     *  A kind left out has no branch and denies. */
    ruleForEachKind: (
      side: string,
      field: string,
      branches: Partial<Record<string, KindBranch>>,
      at = '',
    ): ActionRule => {
      const kinds = Object.keys(branches);
      declared(side, field, kinds);
      return {
        any: kinds.map((kind) =>
          branchOf(kindCheck(read(side, field, at), [kind]), branches[kind] as KindBranch),
        ),
      };
    },

    /** The same action through each kind's own relation (the registry's foreign key for that kind),
     *  every kind of a resource's axis unless `kinds` narrows it; a kind with no relation is left out. */
    ruleActionThroughEachKind: (
      resource: R,
      axisField: string,
      action: string,
      kinds: readonly string[] = kindsOf(resource, axisField),
      at = '',
    ): ActionRule => {
      declared(resource, axisField, kinds);
      const branches = kinds.flatMap((kind) => {
        const rel = ownerRelationOf(map, resource, axisField, kind);
        return rel
          ? [branchOf(kindCheck(`${at}${axisField}`, [kind]), { rel: `${at}${rel}`, action })]
          : [];
      });
      if (branches.length === 0)
        throw new Error(
          `\`${resource}.${axisField}\` has no kind with a relation among ${kinds.join(', ')}`,
        );
      return { any: branches };
    },
  };
};

export type KindRules = ReturnType<typeof makeKindRules>;
