import type { Condition } from '@inixiative/json-rules';

const exactKeys = new Set(['field', 'operator', 'value']);

export type Leaf = { field: string; operator: string; value: unknown };

const isLiteralLeaf = (rule: unknown): rule is Leaf =>
  typeof rule === 'object' &&
  rule !== null &&
  typeof (rule as Leaf).field === 'string' &&
  typeof (rule as Leaf).operator === 'string' &&
  'value' in rule &&
  Object.keys(rule).every((key) => exactKeys.has(key));

/** A `where`'s conjuncts: the members of its one top-level `all`, or the condition alone. */
export const conjuncts = (where: Condition | null | undefined): unknown[] => {
  if (where == null) return [];
  if (
    typeof where === 'object' &&
    'all' in where &&
    Array.isArray(where.all) &&
    Object.keys(where).length === 1
  )
    return where.all;
  return [where];
};

/** The conjuncts of a `where` that are a plain `field operator value` on the record. */
export const rootLeaves = (where: Condition | undefined): Leaf[] =>
  conjuncts(where).filter(isLiteralLeaf);
