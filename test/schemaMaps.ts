import type { FieldMap, ModelEntry } from '@inixiative/field-map';
import { parseEndpointKey } from '@inixiative/json-rules';
import {
  type ActionRule,
  type Admission,
  type CheckOptions,
  createCanGrantEntitlement,
  createRebacCheck,
  createRebacPaths,
  type EntitlementEntry,
  type PathsOptions,
  type PermixLike,
  type Row,
  type SchemaMap,
  type SchemaMapWithoutPermissions,
  type Subject,
} from '../index';

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

/** The rules a test lays over a map: the map's `permissions`, and its `bridges` when the case has some. */
export type Rules = Pick<SchemaMap, 'permissions' | 'bridges'>;

/** The map with `rules` laid over it: one object, as every entry point takes. */
export const mapWith = (map: SchemaMapWithoutPermissions, rules: Rules): SchemaMap => {
  let byRules = mapsWithRules.get(map);
  if (!byRules) {
    byRules = new WeakMap();
    mapsWithRules.set(map, byRules);
  }
  let whole = byRules.get(rules);
  if (!whole) {
    whole = { ...map, ...rules };
    byRules.set(rules, whole);
  }
  return whole;
};

const mapsWithRules = new WeakMap<SchemaMapWithoutPermissions, WeakMap<Rules, SchemaMap>>();

/** A check over `map` that takes each case's rules beside the subject: `(permix, rules, subject, action)`. */
export const checkWithRules =
  (map: SchemaMapWithoutPermissions, options?: CheckOptions) =>
  (permix: PermixLike, rules: Rules, subject: Subject, actionOrRule: ActionRule): boolean =>
    createRebacCheck(mapWith(map, rules), options)(permix, subject, actionOrRule);

const split = (resource: string) => {
  if (!resource.includes(':'))
    throw new Error(`\`${resource}\` names no map: a resource is \`map:Model\``);
  const { mapName, modelName: model } = parseEndpointKey(resource, '');
  return { mapName, model };
};

const modelBeside = (resource: string, target: string) => {
  const from = split(resource);
  const to = split(target);
  if (from.mapName !== to.mapName)
    throw new Error(
      `\`${resource}\` relates to \`${target}\` in another map: a relation stays in its map`,
    );
  return to.model;
};

/**
 * A map of resources (`map:model`), each a model of its map with `id`, each relation's foreign key
 * (`<name>Id`) and the given `columns` as String columns, and the given `lists`: a check reads below
 * the root only what the model has. Its supplied `actor` map is {@link actorMap}.
 */
export const mapOf = (
  relations: Record<string, Record<string, string>>,
  columns: Record<string, readonly string[]> = {},
  lists: Record<string, Record<string, ListOf>> = {},
): SchemaMapWithoutPermissions => {
  const resources = new Set([
    ...Object.keys(relations),
    ...Object.values(relations).flatMap((fields) => Object.values(fields)),
    ...Object.keys(columns),
    ...Object.keys(lists),
    ...Object.values(lists).flatMap((fields) => Object.values(fields).map((list) => list.item)),
  ]);
  const models: Record<string, Record<string, ModelEntry>> = {};
  for (const resource of resources) {
    const { mapName, model } = split(resource);
    models[mapName] ??= {};
    (models[mapName] as Record<string, ModelEntry>)[model] = {
      fields: {
        id: stringColumn,
        ...Object.fromEntries((columns[resource] ?? []).map((name) => [name, stringColumn])),
        ...Object.fromEntries(
          Object.entries(relations[resource] ?? {}).flatMap(([segment, target]) => [
            [`${segment}Id`, stringColumn],
            [
              segment,
              {
                kind: 'object',
                type: modelBeside(resource, target),
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
              type: modelBeside(resource, list.item),
              isList: true,
              fromFields: [],
              toFields: [],
              annotations: { permissions: { down: list.down } },
            },
          ]),
        ),
      },
    };
  }
  return {
    maps: Object.fromEntries(
      Object.entries(models).map(([mapName, of]) => [mapName, { models: of }]),
    ),
    supplied: { actor: actorMap },
  };
};

/** Every admission over `map`, taking each case's rules beside the subject. */
export const pathsWithRules =
  (map: SchemaMapWithoutPermissions, options?: PathsOptions) =>
  (permix: PermixLike, rules: Rules, subject: Subject, actionOrRule: ActionRule): Admission[] =>
    createRebacPaths(mapWith(map, rules), options)(permix, subject, actionOrRule);

/** The grant check over `map`, taking each case's rules beside the entry. */
export const canGrantWithRules =
  (map: SchemaMapWithoutPermissions, options?: Pick<CheckOptions, 'additionalRules'>) =>
  (permix: PermixLike, rules: Rules, entry: EntitlementEntry, placed: Row): boolean =>
    createCanGrantEntitlement(mapWith(map, rules), options)(permix, entry, placed);
