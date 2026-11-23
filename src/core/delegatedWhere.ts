import type { Condition } from '@inixiative/json-rules';
import { isEqual } from 'lodash-es';
import { conjuncts } from './placement';

/**
 * The `where` of an entry granted under a held one: `all` of the added conditions, then the held
 * `where`'s conjuncts, flat and each kept whole (one conjunct comes back alone). A narrowing never
 * rewrites a held condition: a narrower list sits beside it, `all[ in [A], in [A, B] ]`.
 */
export const delegatedWhere = (
  held: Condition | null | undefined,
  ...added: (Condition | null | undefined)[]
): Condition | undefined => {
  const parts = [...added.flatMap((where) => conjuncts(where)), ...conjuncts(held)].filter(
    (part, index, all) => all.findIndex((other) => isEqual(other, part)) === index,
  ) as Condition[];
  if (parts.length === 0) return undefined;
  if (parts.length === 1) return parts[0];
  return { all: parts };
};
