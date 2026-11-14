import type { Condition } from '@inixiative/json-rules';
import { isEqual } from 'lodash-es';
import { conjuncts } from './schemaMap';

/**
 * The `where` of an entry granted under a held one: the held `where` exactly when nothing is added,
 * otherwise `all` of the added conditions followed by the held `where`'s own conjuncts, each kept
 * intact. This is the shape `createCanGrantEntitlement` reads as narrowing the held `where`.
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
