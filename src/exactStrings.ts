import { engineGlobals } from '@inixiative/json-rules';

export const withExactStrings = <T>(fn: () => T): T =>
  engineGlobals.with({ string: { caseInsensitive: false, fuzzy: false } }, fn);
