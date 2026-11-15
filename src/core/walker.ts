import { type BridgeDictionary, indexBridges } from '@inixiative/json-rules';
import type { Algebra } from './algebra';
import { evaluate } from './evaluate';
import { withExactStrings } from './exactStrings';
import { judgeOnce } from './lens';
import { indexMap, type SchemaMap } from './schemaMap';
import type { ActionRule, CheckOptions, PermixLike, RebacSchema, Row, Subject } from './types';
import { validateActionRule } from './validateActionRule';
import { actionRuleLensIssues, lensIssues, schemaRuleIssues } from './validateSchema';

const refuse = (what: string) => {
  throw new Error(
    `${what} is not a well-formed positive rule: negated rules are refused on every check (run validateSchema)`,
  );
};

const outsideLens = ({ path, message }: { path: string; message: string }) => {
  throw new Error(`\`${path}\`: ${message} (run validateSchema)`);
};

// why: a negated rule, or a read outside the lens, answers on what nothing loaded
const assertSchema = (map: SchemaMap, schema: RebacSchema) =>
  judgeOnce(schema, map, () => {
    const [negated] = schemaRuleIssues(schema);
    if (negated) refuse(`\`${negated.path}\``);
    const [outside] = lensIssues(map, schema);
    if (outside) outsideLens(outside);
    return true;
  });

export const createWalker = <R extends string, T>(
  map: SchemaMap<R>,
  absent: CheckOptions['absent'] & {},
  algebra: Algebra<T>,
  ignoreWheres = false,
) => {
  indexMap(map as SchemaMap);
  return (
    permix: PermixLike,
    schema: RebacSchema<R>,
    subject: Subject<R>,
    actionOrRule: ActionRule,
    visited: Set<string> = new Set(),
    above?: (record: Row) => ReadonlySet<Row>,
  ): T => {
    assertSchema(map as SchemaMap, schema);
    if (typeof actionOrRule === 'object' && actionOrRule !== null) {
      if (!validateActionRule(actionOrRule).ok) refuse('the rule asked');
      const [outside] = actionRuleLensIssues(
        map as SchemaMap,
        schema as RebacSchema,
        subject.resource,
        actionOrRule,
        '$',
        true,
      );
      if (outside) outsideLens(outside);
    }
    const record = subject.record;
    // Built lazily on the first bridge hop: a check that never crosses a bridge must not pay for —
    // or be crashed by (indexBridges throws on malformed `data`) — a dictionary it never reads.
    let built = false;
    let dict: BridgeDictionary | undefined;
    const getDict = (): BridgeDictionary | undefined => {
      if (!built) {
        built = true;
        dict = schema.bridges?.length
          ? indexBridges({ maps: {}, bridges: schema.bridges }, subject.data ?? {})
          : undefined;
      }
      return dict;
    };
    return withExactStrings(() =>
      evaluate(
        {
          map,
          absent,
          schema,
          getDict,
          algebra,
          ignoreWheres,
          ...(above ? { above: above(record) } : {}),
        },
        permix,
        subject.resource,
        record,
        actionOrRule,
        new Map([...visited].map((key) => [key, 0])),
      ),
    );
  };
};
