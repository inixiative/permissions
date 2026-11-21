import type { FieldMap } from '@inixiative/field-map';
import type { Row, SchemaMap } from '../index';

export const stringColumn = { kind: 'scalar', type: 'String', isList: false } as const;

/**
 * The app's supplied `actor` map, as template declares one: `Acting` says which kind is acting
 * (`model`, every kind, `Internal` acting with no row), and each kind with a row has its own columns.
 */
export const actorMap: FieldMap = {
  models: {
    Acting: { fields: { model: { kind: 'enum', type: 'ActingKind', isList: false } } },
    User: { fields: { id: stringColumn, uuid: stringColumn, userId: stringColumn } },
    Token: {
      fields: {
        id: stringColumn,
        uuid: stringColumn,
        userId: stringColumn,
        ownerModel: stringColumn,
      },
    },
  },
  enums: { ActingKind: ['User', 'Token', 'Internal'] },
};

/** Who is acting, as the check's `data` gives it: `actor:Acting` names the kind, `actor:<kind>` its row. */
export const actorData = (
  model: string | null,
  record?: Row,
  data: Record<string, Row[]> = {},
): Record<string, Row[]> =>
  model === null
    ? data
    : {
        ...data,
        'actor:Acting': [{ model }],
        ...(record ? { [`actor:${model}`]: [record] } : {}),
      };

/** A list relation `name` on a resource: its items' resource and its `/// @permissions(down: [...])` paths. */
export type ListOf = { item: string; down: readonly string[] };

/**
 * A map of resources, each its own model, with `id`, each relation's foreign key (`<name>Id`) and
 * the given `columns` as String columns, and the given `lists`: a check reads below the root only
 * what the model has. Its supplied `actor` map is {@link actorMap}.
 */
export const mapOf = (
  relations: Record<string, Record<string, string>>,
  columns: Record<string, readonly string[]> = {},
  lists: Record<string, Record<string, ListOf>> = {},
): SchemaMap => {
  const resources = new Set([
    ...Object.keys(relations),
    ...Object.values(relations).flatMap((fields) => Object.values(fields)),
    ...Object.keys(columns),
    ...Object.keys(lists),
    ...Object.values(lists).flatMap((fields) => Object.values(fields).map((list) => list.item)),
  ]);
  return {
    resources: Object.fromEntries([...resources].map((resource) => [resource, resource])),
    fieldMap: {
      models: {
        ...Object.fromEntries(
          [...resources].map((resource) => [
            resource,
            {
              fields: {
                id: stringColumn,
                ...Object.fromEntries(
                  (columns[resource] ?? []).map((name) => [name, stringColumn]),
                ),
                ...Object.fromEntries(
                  Object.entries(relations[resource] ?? {}).flatMap(([segment, target]) => [
                    [`${segment}Id`, stringColumn],
                    [
                      segment,
                      {
                        kind: 'object',
                        type: target,
                        isList: false,
                        fromFields: [`${segment}Id`],
                        toFields: ['id'],
                      },
                    ],
                  ]),
                ),
                ...Object.fromEntries(
                  Object.entries(lists[resource] ?? {}).map(([name, list]) => [
                    name,
                    {
                      kind: 'object',
                      type: list.item,
                      isList: true,
                      fromFields: [],
                      toFields: [],
                      annotations: { permissions: { down: list.down } },
                    },
                  ]),
                ),
              },
            },
          ]),
        ),
      },
    },
    supplied: { actor: actorMap },
  };
};
