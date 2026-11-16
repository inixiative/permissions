/**
 * How one walk combines what it finds. `check` stops at the first admission (a boolean); `paths`
 * keeps every admission. Both run the same walk.
 */
export type Algebra<T> = {
  none: T;
  unit: T;
  any: (branches: Iterable<() => T>) => T;
  all: (branches: Iterable<() => T>) => T;
  /** An entitlement admitted because its owner admitted `above`. */
  through: (ref: string | undefined, above: T) => T;
  /** The walk came back to a node it is already on, for the same table and action. */
  loop: (resource: string, action: string) => T;
};

export const booleanAlgebra: Algebra<boolean> = {
  none: false,
  unit: true,
  any: (branches) => {
    for (const branch of branches) if (branch()) return true;
    return false;
  },
  all: (branches) => {
    for (const branch of branches) if (!branch()) return false;
    return true;
  },
  through: (_ref, above) => above,
  loop: (resource, action) => {
    throw new Error(`Cycle detected in permission graph: ${resource}.${action}`);
  },
};

/**
 * One chain of entitlement refs, from the holder up to the grant that backs it. An entitlement set
 * up without a `ref` is `null`, so a delegated link never reads as a grant held directly.
 */
export type Chain = readonly (string | null)[];

/**
 * One way a check is admitted: the chains it stands on. A grant held directly stands on none;
 * an `all` that needs two delegated branches stands on two.
 */
export type Admission = readonly Chain[];

export class PathLimitError extends Error {
  constructor(readonly limit: number) {
    super(`a check admits along more than ${limit} paths`);
    this.name = 'PathLimitError';
  }
}

const uniqueChains = (admission: Admission): Admission => {
  const seen = new Set<string>();
  return admission.filter((chain) => {
    const key = JSON.stringify(chain);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

export const pathsAlgebra = (limit: number): Algebra<Admission[]> => {
  // One admission reached along two walks (an action and the action implying it, say) is one way
  // in, so it is kept once and counted once against the limit.
  const add = (into: Map<string, Admission>, admission: Admission) => {
    const normal = uniqueChains(admission);
    into.set(JSON.stringify(normal), normal);
    if (into.size > limit) throw new PathLimitError(limit);
  };
  return {
    none: [],
    unit: [[]],
    any: (branches) => {
      const admissions = new Map<string, Admission>();
      for (const branch of branches) for (const admission of branch()) add(admissions, admission);
      return [...admissions.values()];
    },
    // Each admission of the branches so far, joined with each admission of the next branch; a
    // branch that admits nothing ends it, so later branches are never walked (as `check` stops).
    all: (branches) => {
      let admissions: Admission[] = [[]];
      for (const branch of branches) {
        const next = branch();
        const joined = new Map<string, Admission>();
        for (const held of admissions) for (const more of next) add(joined, [...held, ...more]);
        admissions = [...joined.values()];
        if (!admissions.length) return [];
      }
      return admissions;
    },
    through: (ref, above) =>
      above.map((admission) =>
        admission.length ? admission.map((chain) => [ref ?? null, ...chain]) : [[ref ?? null]],
      ),
    // Whatever a loop admits is admitted without it, so it adds nothing; `check`'s throw for a
    // schema loop is kept by `check`, which stops before walking past an admission.
    loop: () => [],
  };
};
