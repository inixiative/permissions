import { columnsOf, type FieldMap, fieldOf, type ModelEntry, modelOf } from '@inixiative/field-map';
import type { SuppliedBridge } from '@inixiative/json-rules';
import type { SchemaMap } from './schemaMap';
import type { Actor, Row } from './types';

/** The map the actor's rows sit in, beside the app's: a rule reads `actor:<Model>.<column>`. */
export const actorMapName = 'actor';
/** The model that says which kind is acting (`model`), and facts about the acting. */
export const actingModel = 'Acting';
/** The enum of the kinds that can act, which `actor:Acting.model` holds. */
const actingKindEnum = 'ActingKind';

const actorKey = (model: string) => `${actorMapName}:${model}`;

/** The declared models that act with a row, each checked against the map. */
export const actorModelsWithRows = (map: SchemaMap): string[] => {
  const models = [...(map.actors?.models ?? [])];
  for (const model of models)
    if (!modelOf(map.fieldMap, model))
      throw new Error(`actors.models names \`${model}\`, which is not a model of the map`);
  if (models.includes(actingModel))
    throw new Error(
      `actors.models names \`${actingModel}\`, the actor's own row: rename the model`,
    );
  return models;
};

/** Every kind that can act: the models with rows, then the pseudo kinds. */
export const actorKinds = (map: SchemaMap): string[] => {
  const kinds = [...actorModelsWithRows(map), ...(map.actors?.pseudo ?? [])];
  if (new Set(kinds).size !== kinds.length)
    throw new Error('actors.models and actors.pseudo name a kind twice');
  return kinds;
};

/** The actor map: `Acting` (the kind and the acting's facts) and each acting model's own columns. */
const actorFieldMap = (map: SchemaMap): FieldMap => {
  if (map.fieldMap.enums && actingKindEnum in map.fieldMap.enums)
    throw new Error(`the map has an enum \`${actingKindEnum}\`, the actor's kinds: rename it`);
  const entries: Record<string, ModelEntry> = {
    [actingModel]: {
      fields: {
        ...map.actors?.acting,
        model: { kind: 'enum', type: actingKindEnum, isRequired: true, isList: false },
      },
    },
  };
  for (const model of actorModelsWithRows(map))
    entries[model] = {
      fields: Object.fromEntries(
        columnsOf(map.fieldMap, model).map((column) => [
          column,
          fieldOf(map.fieldMap, model, column),
        ]),
      ) as ModelEntry['fields'],
    };
  return { models: entries, enums: { ...map.fieldMap.enums, [actingKindEnum]: actorKinds(map) } };
};

/**
 * What a rule lens anchored at `model` adds for the actor: the actor map, a supplied bridge from
 * the anchor to `actor:Acting` and to each acting model, each turned on at the root with nothing
 * below it, so a rule reads the kind, the acting's facts and the actor's own columns only.
 */
export const actorPartsOfRuleLens = (
  map: SchemaMap,
  appMapName: string,
  model: string,
): {
  maps: Record<string, FieldMap>;
  bridges: SuppliedBridge[];
  relations: Record<string, object>;
} => {
  const far = [actingModel, ...actorModelsWithRows(map)];
  return {
    maps: { [actorMapName]: actorFieldMap(map) },
    bridges: far.map((farModel) => ({
      endpoints: [
        { fieldMap: appMapName, model },
        { fieldMap: actorMapName, model: farModel },
      ],
      cardinality: 'oneToOne',
    })),
    relations: Object.fromEntries(far.map((farModel) => [actorKey(farModel), {}])),
  };
};

/**
 * The record a `{ rule }` is checked on: any `actor:` key the record brought dropped, then
 * `actor:Acting` (the kind and the acting's facts), the acting row under `actor:<model>`, and the
 * other models empty, so a record never carries an actor of its own. Throws for a kind a map that
 * declares actors leaves out; a map that declares none has no actor in its rule lens.
 */
export const recordWithActor = (map: SchemaMap, record: Row, actor: Actor | null): Row => {
  const own: Row = Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith(`${actorMapName}:`)),
  );
  if (!map.actors) return own;
  if (actor && !actorKinds(map).includes(actor.model))
    throw new Error(`\`${actor.model}\` is acting, but the map's actors do not declare it`);
  const keys: Row = {
    [actorKey(actingModel)]: actor ? { ...actor.acting, model: actor.model } : undefined,
  };
  for (const model of actorModelsWithRows(map))
    keys[actorKey(model)] = model === actor?.model ? actor.record : undefined;
  return { ...own, ...keys };
};
