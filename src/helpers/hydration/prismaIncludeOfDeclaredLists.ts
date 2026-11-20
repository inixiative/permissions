import type { DeclaredListsToLoad, DeclaredPaths } from './hydrate';

/** A Prisma `include` of declared lists and paths: a relation is `true`, or carries the include under it. */
export type PrismaIncludeOfDeclaredLists = {
  [relation: string]: true | { include: PrismaIncludeOfDeclaredLists };
};

const prismaIncludeOfDeclaredPaths = (
  paths: DeclaredPaths,
): true | { include: PrismaIncludeOfDeclaredLists } => {
  const include: PrismaIncludeOfDeclaredLists = {};
  for (const [relation, below] of Object.entries(paths))
    include[relation] = prismaIncludeOfDeclaredPaths(below);
  return Object.keys(include).length ? { include } : true;
};

/**
 * The lists `load` is asked to bring, as a Prisma `include` for the read of their parent
 * (`findFirst({ where, include })`), or undefined when the resource declares none. It names
 * relations only and adds no filter: leaving removed rows out, among the items and under them,
 * is still `load`'s.
 */
export const prismaIncludeOfDeclaredLists = (
  declaredLists: DeclaredListsToLoad,
): PrismaIncludeOfDeclaredLists | undefined => {
  const include: PrismaIncludeOfDeclaredLists = {};
  for (const [listField, paths] of Object.entries(declaredLists))
    include[listField] = prismaIncludeOfDeclaredPaths(paths);
  return Object.keys(include).length ? include : undefined;
};
