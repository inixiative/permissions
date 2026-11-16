/** Freezes `value` and everything in it. */
const deepFreeze = (value: unknown, seen = new WeakSet<object>()): void => {
  if (typeof value !== 'object' || value === null || seen.has(value)) return;
  seen.add(value);
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
};

/** `answer()` for `outer` and then `inner`, computed once and kept in `remembered` (kept only while `keep`). */
export const answerOnce = <O extends object, I, V>(
  remembered: WeakMap<O, Map<I, V>>,
  outer: O,
  inner: I,
  answer: () => V,
  keep = true,
): V => {
  let byInner = remembered.get(outer);
  if (!byInner) {
    byInner = new Map();
    remembered.set(outer, byInner);
  }
  if (byInner.has(inner)) return byInner.get(inner) as V;
  const value = answer();
  if (keep) byInner.set(inner, value);
  return value;
};

const judged = new WeakMap<object, Map<object, unknown>>();

/** `judge`'s answer for `value` at `key`, once: `value` is frozen first, so the answer cannot go stale. */
export const freezeThenJudgeOnce = <T>(value: object, key: object, judge: () => T): T =>
  answerOnce(judged, value, key, () => {
    deepFreeze(value);
    return judge();
  }) as T;
