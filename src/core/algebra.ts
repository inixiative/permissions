/**
 * How one walk combines what it finds. `check` stops at the first admission (a boolean); `paths`
 * keeps every admission. Both run the same walk, so they never disagree on what admits.
 */
export type Algebra<T> = {
  none: T;
  unit: T;
  any: (branches: Iterable<() => T>) => T;
  all: (branches: Iterable<() => T>) => T;
  /** An entitlement admitted because its owner admitted `above`. */
  through: (ref: string | undefined, above: T) => T;
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
};

/** One chain of entitlement refs, from the holder up to the grant that backs it. */
export type Chain = readonly string[];

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

export const pathsAlgebra = (limit: number): Algebra<Admission[]> => {
  const capped = (admissions: Admission[]) => {
    if (admissions.length > limit) throw new PathLimitError(limit);
    return admissions;
  };
  return {
    none: [],
    unit: [[]],
    any: (branches) => {
      const admissions: Admission[] = [];
      for (const branch of branches) {
        admissions.push(...branch());
        capped(admissions);
      }
      return admissions;
    },
    // Each admission of the branches so far, joined with each admission of the next branch; a
    // branch that admits nothing ends it, so later branches are never walked (as `check` stops).
    all: (branches) => {
      let admissions: Admission[] = [[]];
      for (const branch of branches) {
        const next = branch();
        admissions = capped(admissions.flatMap((held) => next.map((more) => [...held, ...more])));
        if (!admissions.length) return [];
      }
      return admissions;
    },
    through: (ref, above) =>
      ref === undefined
        ? above
        : above.map((admission) =>
            admission.length ? admission.map((chain) => [ref, ...chain]) : [[ref]],
          ),
  };
};
