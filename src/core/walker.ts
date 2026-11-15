import { type BridgeDictionary, indexBridges } from '@inixiative/json-rules';
import type { Algebra } from './algebra';
import { evaluate } from './evaluate';
import { withExactStrings } from './exactStrings';
import { indexMap, type SchemaMap } from './schemaMap';
import type { ActionRule, CheckOptions, PermixLike, RebacSchema, Row, Subject } from './types';
import { validateActionRule } from './validateActionRule';
import { declarationIssues, schemaRuleIssues } from './validateSchema';

const refuse = (what: string) => {
  throw new Error(
    `${what} is not a well-formed positive rule: negated rules are refused on every check (run validateSchema)`,
  );
};

const judged = new WeakMap<object, WeakSet<object>>();

// why: a negated rule, or a walk under a list item outside its declaration, answers on what nothing loaded
const assertSchema = (map: SchemaMap, schema: RebacSchema) => {
  const known = judged.get(map) ?? new WeakSet();
  if (known.has(schema)) return;
  const [negated] = schemaRuleIssues(schema);
  if (negated) refuse(`\`${negated.path}\``);
  const [undeclared] = declarationIssues(map, schema);
  if (undeclared)
    throw new Error(`\`${undeclared.path}\`: ${undeclared.message} (run validateSchema)`);
  judged.set(map, known.add(schema));
};

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
    above?: ReadonlySet<Row>,
  ): T => {
    assertSchema(map as SchemaMap, schema);
    if (
      typeof actionOrRule === 'object' &&
      actionOrRule !== null &&
      !validateActionRule(actionOrRule).ok
    )
      refuse('the rule asked');
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
        { map, absent, schema, getDict, algebra, ignoreWheres, ...(above ? { above } : {}) },
        permix,
        subject.resource,
        subject.record,
        actionOrRule,
        visited,
      ),
    );
  };
};
