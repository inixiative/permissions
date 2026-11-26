import type { Down, DownPaths } from './hydrationRun';

/** A Prisma `include` of declared lists and paths: a relation is `true`, or carries the include under it. */
export type PrismaIncludeOfDown = {
  [relation: string]: true | { include: PrismaIncludeOfDown };
};

const prismaIncludeOfDownPaths = (paths: DownPaths): true | { include: PrismaIncludeOfDown } => {
  const include: PrismaIncludeOfDown = {};
  for (const [relation, below] of Object.entries(paths))
    include[relation] = prismaIncludeOfDownPaths(below);
  return Object.keys(include).length ? { include } : true;
};

/**
 * The `down` that `loadMany` is given, as a Prisma `include` for the read of the rows
 * (`findMany({ where, include })`), or undefined when the resource declares no list.
 */
export const prismaIncludeOfDown = (down: Down): PrismaIncludeOfDown | undefined => {
  const include: PrismaIncludeOfDown = {};
  for (const [listField, paths] of Object.entries(down))
    include[listField] = prismaIncludeOfDownPaths(paths);
  return Object.keys(include).length ? include : undefined;
};
