import type { SchemaMap } from '../index';

const column = { kind: 'scalar', type: 'String', isList: false } as const;

/**
 * A map of resources, each its own model, with `id`, each relation's foreign key (`<name>Id`) and
 * the given `columns` as String columns: a check reads below the root only what the model has.
 */
export const mapOf = (
  relations: Record<string, Record<string, string>>,
  columns: Record<string, readonly string[]> = {},
): SchemaMap => {
  const resources = new Set([
    ...Object.keys(relations),
    ...Object.values(relations).flatMap((fields) => Object.values(fields)),
    ...Object.keys(columns),
  ]);
  return {
    resources: Object.fromEntries([...resources].map((resource) => [resource, resource])),
    fieldMap: {
      models: Object.fromEntries(
        [...resources].map((resource) => [
          resource,
          {
            fields: {
              id: column,
              ...Object.fromEntries((columns[resource] ?? []).map((name) => [name, column])),
              ...Object.fromEntries(
                Object.entries(relations[resource] ?? {}).flatMap(([segment, target]) => [
                  [`${segment}Id`, column],
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
            },
          },
        ]),
      ),
    },
  };
};
