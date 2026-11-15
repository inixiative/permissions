/** Freezes `value` and everything in it. */
const deepFreeze = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
};

const judged = new WeakMap<object, Map<object, unknown>>();

/** `judge`'s answer for `value` at `key`, once: `value` is frozen first, so the answer cannot go stale. */
export const freezeThenJudgeOnce = <T>(value: object, key: object, judge: () => T): T => {
  const byKey = judged.get(value) ?? new Map<object, unknown>();
  judged.set(value, byKey);
  if (byKey.has(key)) return byKey.get(key) as T;
  deepFreeze(value);
  const answer = judge();
  byKey.set(key, answer);
  return answer;
};
