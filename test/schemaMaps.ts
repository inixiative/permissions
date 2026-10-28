import type { SchemaMap } from '../index';

export const mapOf = (relations: Record<string, Record<string, string>>): SchemaMap => {
  const resources = new Set([
    ...Object.keys(relations),
    ...Object.values(relations).flatMap((fields) => Object.values(fields)),
  ]);
  return {
    resources: Object.fromEntries([...resources].map((resource) => [resource, resource])),
    fieldMap: {
      models: Object.fromEntries(
        [...resources].map((resource) => [
          resource,
          {
            fields: Object.fromEntries(
              Object.entries(relations[resource] ?? {}).map(([segment, target]) => [
                segment,
                {
                  kind: 'object',
                  type: target,
                  isList: false,
                  fromFields: [`${segment}Id`],
                  toFields: ['id'],
                },
              ]),
            ),
          },
        ]),
      ),
    },
  };
};
