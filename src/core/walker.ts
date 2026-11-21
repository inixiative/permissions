import { type BridgeDictionary, indexBridges, type JoinedBridge } from '@inixiative/json-rules';
import type { Algebra } from './algebra';
import { evaluate, startOneCheck } from './evaluate';
import { withExactStrings } from './exactStrings';
import { answerOnce, freezeThenJudgeOnce } from './freezeThenJudgeOnce';
import { idField } from './recordId';
import { indexMap, type SchemaMap } from './schemaMap';
import { joinedBridgesOfSupplied } from './supplied';
import type { ActionRule, AdditionalRules, PermixLike, RebacSchema, Row, Subject } from './types';
import { validateActionRule } from './validateActionRule';
import {
  issuesForRuleReadsOutsideLens,
  schemaIssuesRefusedOnFirstUse,
  schemaRuleIssues,
} from './validateSchema';

const refuse = (what: string) => {
  throw new Error(
    `${what} is not a well-formed positive rule: a rule names what the record carries, so negations and null checks are refused on every check (run validateSchema)`,
  );
};

const outsideLens = ({ path, message }: { path: string; message: string }) => {
  throw new Error(`\`${path}\`: ${message} (run validateSchema)`);
};

// why: a negated rule, or a read outside the lens, answers on what nothing loaded
const assertSchema = (map: SchemaMap, schema: RebacSchema) =>
  freezeThenJudgeOnce(schema, map, () => {
    const [negated] = schemaRuleIssues(schema);
    if (negated) refuse(`\`${negated.path}\``);
    const [outside] = schemaIssuesRefusedOnFirstUse(map, schema);
    if (outside) outsideLens(outside);
    return true;
  });

export const createWalker = <R extends string, T>(
  map: SchemaMap<R>,
  algebra: Algebra<T>,
  ignoreWheres = false,
  additionalRules?: AdditionalRules,
) => {
  indexMap(map as SchemaMap);
  // why: an inline rule passed again as the same object is judged once (and frozen); a fresh literal each call is judged each time
  const inlineKeys = new WeakMap<object, Map<string, object>>();
  const inlineKey = (schema: object, resource: string): object =>
    answerOnce(inlineKeys, schema, resource, () => ({}));
  return (
    permix: PermixLike,
    schema: RebacSchema<R>,
    subject: Subject<R>,
    actionOrRule: ActionRule,
    above?: ReadonlySet<Row>,
  ): T => {
    assertSchema(map as SchemaMap, schema);
    if (typeof actionOrRule === 'object' && actionOrRule !== null)
      freezeThenJudgeOnce(actionOrRule, inlineKey(schema, subject.resource), () => {
        if (!validateActionRule(actionOrRule).ok) refuse('the rule asked');
        const [outside] = issuesForRuleReadsOutsideLens(
          map as SchemaMap,
          schema as RebacSchema,
          subject.resource,
          actionOrRule,
        );
        if (outside) outsideLens(outside);
        return true;
      });
    const record = subject.record;
    // Each built lazily, once per check: a check that never crosses a bridge must not pay for, or
    // be crashed by (indexBridges throws on malformed `data`), a dictionary it never reads.
    const dictionaryOnceOver = (bridges: JoinedBridge[]) => {
      let built = false;
      let dict: BridgeDictionary | undefined;
      return (): BridgeDictionary | undefined => {
        if (!built) {
          built = true;
          dict = bridges.length
            ? indexBridges({ maps: {}, bridges }, subject.data ?? {})
            : undefined;
        }
        return dict;
      };
    };
    const getDict = dictionaryOnceOver(schema.bridges ?? []);
    const suppliedDictionary = dictionaryOnceOver(joinedBridgesOfSupplied(map));
    return withExactStrings(() =>
      evaluate(
        {
          map,
          schema,
          getDict,
          suppliedDictionary,
          ...(subject.data ? { data: subject.data } : {}),
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
