import { isPlainObject } from 'lodash-es';
import { entitlementProblem } from '../../core/entitlementProblem';
import type { EntitlementEntry } from '../../core/permix';
import { withoutRedundantEntitlements } from '../../core/redundantEntitlements';

/** The entries of a stored value a table can install: well-formed, none redundant; anything else is none. */
export const wellFormedEntitlements = (value: unknown): EntitlementEntry[] =>
  Array.isArray(value)
    ? withoutRedundantEntitlements(
        value.filter(
          (entry): entry is EntitlementEntry =>
            isPlainObject(entry) && entitlementProblem(entry as EntitlementEntry) === null,
        ),
      )
    : [];
