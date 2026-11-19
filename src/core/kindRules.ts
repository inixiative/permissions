import { Operator } from '@inixiative/json-rules';
import { actingModel, actorKinds, actorMapName, actorModelsWithRows } from './actor';
import { ownerRelationOf, type SchemaMap } from './schemaMap';
import type { ActionRule } from './types';

/**
 * The standard shape of a polymorphic check (Aron 2026-11-19, R-2026-11-19-15): fan out over the
 * kinds, each branch checking its own model before anything else, every rule positive. A pseudo
 * kind (no row, no id) is named by its model alone.
 */

/** A branch of a fan-out: the rule a kind must also meet, or `true` when its kind check is all. */
export type KindBranch = ActionRule;

const kindCheck = (field: string, kinds: readonly string[]): ActionRule => {
  if (kinds.length === 0) throw new Error(`a kind check on \`${field}\` names no kind`);
  return kinds.length === 1
    ? { rule: { field, operator: Operator.equals, value: kinds[0] } }
    : { rule: { field, operator: Operator.in, value: [...kinds] } };
};

const branchOf = (check: ActionRule, rule: KindBranch): ActionRule =>
  rule === true ? check : { all: [check, rule] };

const actingKindField = `${actorMapName}:${actingModel}.model`;

/** The rule builders for one map, each reading its kinds from the map so no app restates them. */
export const makeKindRules = <R extends string>(map: SchemaMap<R>) => {
  const kindsOf = (resource: R, axisField: string): string[] => {
    const model = map.resources[resource];
    const axis = map.polymorphism?.[model]?.axes.find((candidate) => candidate.field === axisField);
    if (!axis)
      throw new Error(
        `\`${resource}\` has no polymorphic axis \`${axisField}\` in map.polymorphism`,
      );
    return Object.keys(axis.fkMap);
  };
  const declared = (known: readonly string[], kinds: readonly string[], what: string) => {
    for (const kind of kinds)
      if (!known.includes(kind)) throw new Error(`${what} has no kind \`${kind}\``);
  };
  const actorKindsDeclared = (kinds: readonly string[]) =>
    declared(actorKinds(map), kinds, "the map's actors");

  return {
    /** `<at><axisField>` is one of `kinds`: a positive kind check on a polymorphic side. */
    ruleKindIsOneOf: (
      resource: R,
      axisField: string,
      kinds: readonly string[],
      at = '',
    ): ActionRule => {
      declared(kindsOf(resource, axisField), kinds, `\`${resource}.${axisField}\``);
      return kindCheck(`${at}${axisField}`, kinds);
    },

    /** A fan-out over a side's kinds: one branch per kind given, each checking its own kind first.
     *  A kind left out has no branch and denies. */
    ruleForEachKind: (
      resource: R,
      axisField: string,
      branches: Partial<Record<string, KindBranch>>,
      at = '',
    ): ActionRule => {
      const kinds = Object.keys(branches);
      declared(kindsOf(resource, axisField), kinds, `\`${resource}.${axisField}\``);
      return {
        any: kinds.map((kind) =>
          branchOf(kindCheck(`${at}${axisField}`, [kind]), branches[kind] as KindBranch),
        ),
      };
    },

    /** The same action through each kind's own relation (the registry's foreign key for that kind),
     *  every kind of the axis unless `kinds` narrows it; a kind with no relation (a pseudo kind) is
     *  left out. */
    ruleActionThroughEachKind: (
      resource: R,
      axisField: string,
      action: string,
      kinds: readonly string[] = kindsOf(resource, axisField),
      at = '',
    ): ActionRule => {
      declared(kindsOf(resource, axisField), kinds, `\`${resource}.${axisField}\``);
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

    /** Who is acting is one of `kinds`: `actor:Acting.model in kinds`. */
    ruleActorKindIsOneOf: (kinds: readonly string[]): ActionRule => {
      actorKindsDeclared(kinds);
      return kindCheck(actingKindField, kinds);
    },

    /** A fan-out over who is acting: one branch per kind given, each checking the acting kind first. */
    ruleForEachActorKind: (branches: Partial<Record<string, KindBranch>>): ActionRule => {
      const kinds = Object.keys(branches);
      actorKindsDeclared(kinds);
      return {
        any: kinds.map((kind) =>
          branchOf(kindCheck(actingKindField, [kind]), branches[kind] as KindBranch),
        ),
      };
    },

    /** The record's `field` is the acting `kind`'s `column`: the kind, then the column exists, then
     *  the match. */
    ruleActorIdMatches: (field: string, kind: string, column = 'id'): ActionRule => {
      if (!actorModelsWithRows(map).includes(kind))
        throw new Error(`\`${kind}\` is not an actor model with a row (actors.models)`);
      const actorColumn = `${actorMapName}:${kind}.${column}`;
      return {
        all: [
          kindCheck(actingKindField, [kind]),
          { rule: { field: actorColumn, operator: Operator.exists } },
          { rule: { field, operator: Operator.equals, path: actorColumn } },
        ],
      };
    },
  };
};

export type KindRules = ReturnType<typeof makeKindRules>;
