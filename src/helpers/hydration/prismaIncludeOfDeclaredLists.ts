import type { DeclaredListsToLoad, DeclaredPaths } from './hydrate';

/** A Prisma `include`: a relation is `true`, or carries the include under it. */
export type PrismaInclude = { [relation: string]: true | { include: PrismaInclude } };

const prismaIncludeOfDeclaredPaths = (paths: DeclaredPaths): true | { include: PrismaInclude } => {
  const include: PrismaInclude = {};
  for (const [relation, below] of Object.entries(paths))
    include[relation] = prismaIncludeOfDeclaredPaths(below);
  return Object.keys(include).length ? { include } : true;
};

/**
 * The lists `load` is asked to bring, as a Prisma `include` for the read of their parent
 * (`findFirst({ where, include })`), or undefined when the resource declares none. Prisma does not
 * leave removed rows out of a to-one include: the app's `load` still returns only live rows.
 */
export const prismaIncludeOfDeclaredLists = (
  declaredLists: DeclaredListsToLoad,
): PrismaInclude | undefined => {
  const include: PrismaInclude = {};
  for (const [listField, paths] of Object.entries(declaredLists))
    include[listField] = prismaIncludeOfDeclaredPaths(paths);
  return Object.keys(include).length ? include : undefined;
};
