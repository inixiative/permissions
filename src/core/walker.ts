import { type BridgeDictionary, indexBridges, type JoinedBridge } from '@inixiative/json-rules';
import type { Algebra } from './algebra';
import { evaluate, startOneCheck } from './evaluate';
import { withExactStrings } from './exactStrings';
import { answerOnce, freezeThenJudgeOnce } from './freezeThenJudgeOnce';
import { idField } from './recordId';
import { indexMap } from './relations';
import { whyNameIsNoModel } from './resourceNames';
import { issuesForRuleReadsOutsideLens } from './ruleReads';
import type { SchemaMap } from './schemaMap';
import { problemsOfBridges, problemsOfMapNames } from './schemaMapProblems';
import { bridgesWalkedFromRecords, joinedBridgesOfSupplied } from './supplied';
import type { ActionRule, AdditionalRules, PermixLike, Row, Subject } from './types';
import { validateActionRule } from './validateActionRule';
import { schemaIssuesRefusedOnFirstUse, schemaRuleIssues } from './validateSchemaMap';

const refuse = (what: string) => {
  throw new Error(
    `${what} is not a well-formed positive rule: a rule names what the record carries, so negations, and null checks without an exists on their row's key, are refused on every check (run validateSchemaMap)`,
  );
};

const outsideLens = ({ path, message }: { path: string; message: string }) => {
  throw new Error(`\`${path}\`: ${message} (run validateSchemaMap)`);
};

// why: a negated rule, or a read outside the lens, answers on what nothing loaded; the rules and bridges are frozen so the answer holds, the field maps are the app's and are not
const assertMap = (schemaMap: SchemaMap) =>
  freezeThenJudgeOnce(schemaMap.permissions, schemaMap, () => {
    if (schemaMap.bridges) freezeThenJudgeOnce(schemaMap.bridges, schemaMap, () => true);
    const [bridge] = problemsOfBridges(schemaMap);
    if (bridge) throw new Error(`${bridge} (run validateSchemaMap)`);
    const [negated] = schemaRuleIssues(schemaMap);
    if (negated) refuse(`\`${negated.path}\``);
    const [outside] = schemaIssuesRefusedOnFirstUse(schemaMap);
    if (outside) outsideLens(outside);
    return true;
  });

export const makeWalker = <R extends string, T>(
  schemaMap: SchemaMap<R>,
  algebra: Algebra<T>,
  ignoreWheres = false,
  additionalRules?: AdditionalRules,
) => {
  const [nameProblem] = problemsOfMapNames(schemaMap);
  if (nameProblem) throw new Error(nameProblem);
  indexMap(schemaMap);
  // why: an inline rule passed again as the same object is judged once (and frozen); a fresh literal each call is judged each time
  const inlineKeys = new WeakMap<object, Map<string, object>>();
  const inlineKey = (resource: string): object =>
    answerOnce(inlineKeys, schemaMap.permissions, resource, () => ({}));
  return (
    permix: PermixLike,
    subject: Subject<R>,
    actionOrRule: ActionRule,
    above?: ReadonlySet<Row>,
  ): T => {
    const why = whyNameIsNoModel(schemaMap, subject.resource);
    if (why) throw new Error(why);
    assertMap(schemaMap);
    if (typeof actionOrRule === 'object' && actionOrRule !== null)
      freezeThenJudgeOnce(actionOrRule, inlineKey(subject.resource), () => {
        if (!validateActionRule(actionOrRule).ok) refuse('the rule asked');
        const [outside] = issuesForRuleReadsOutsideLens(schemaMap, subject.resource, actionOrRule);
        if (outside) outsideLens(outside);
        return true;
      });
    const record = subject.record;
    // Each built lazily, once per check: a check that never crosses a bridge must not pay for, or
    // be crashed by (indexBridges throws on malformed `bridgeData`), a dictionary it never reads.
    const dictionaryOnceOver = (bridges: JoinedBridge[]) => {
      let built = false;
      let dict: BridgeDictionary | undefined;
      return (): BridgeDictionary | undefined => {
        if (!built) {
          built = true;
          dict = bridges.length
            ? indexBridges({ maps: {}, bridges }, subject.bridgeData ?? {})
            : undefined;
        }
        return dict;
      };
    };
    const getDict = dictionaryOnceOver(bridgesWalkedFromRecords(schemaMap));
    const suppliedDictionary = dictionaryOnceOver(joinedBridgesOfSupplied(schemaMap));
    return withExactStrings(() =>
      evaluate(
        {
          schemaMap,
          getDict,
          suppliedDictionary,
          ...(subject.bridgeData ? { bridgeData: subject.bridgeData } : {}),
          algebra,
          ignoreWheres,
          ...(additionalRules ? { additionalRules } : {}),
          idField: idField(),
          oneCheck: startOneCheck(),
          ...(above ? { above } : {}),
        },
        permix,
        subject.resource,
        record,
        actionOrRule,
        new Map(),
      ),
    );
  };
};
