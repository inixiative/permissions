import { describe, expect, test } from 'bun:test';
import { prismaIncludeOfDeclaredLists } from '../index';

describe('prismaIncludeOfDeclaredLists: the declared lists `load` is given, as a Prisma include', () => {
  test('a declared path nests an include, and a leaf is true', () => {
    expect(
      prismaIncludeOfDeclaredLists({
        participants: { forumUser: { fanUser: { user: {} }, brandUser: {} } },
      }),
    ).toEqual({
      participants: {
        include: {
          forumUser: { include: { fanUser: { include: { user: true } }, brandUser: true } },
        },
      },
    });
  });

  test('a list with nothing declared under its items is true, and each list is its own key', () => {
    expect(prismaIncludeOfDeclaredLists({ kids: {}, tags: {} })).toEqual({
      kids: true,
      tags: true,
    });
  });

  test('a resource that declares no list has no include', () => {
    expect(prismaIncludeOfDeclaredLists({})).toBeUndefined();
  });
});
