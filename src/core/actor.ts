import { columnsOf, type FieldMap, fieldOf, type ModelEntry, modelOf } from '@inixiative/field-map';
import type { SuppliedBridge } from '@inixiative/json-rules';
import type { SchemaMap } from './schemaMap';
import type { Actor, Row } from './types';

/** The map the actor's rows sit in, beside the app's: a rule reads `actor:<Model>.<column>`. */
export const actorMapName = 'actor';
/** The model the session's facts sit in (`actor:Session`). */
export const actorSessionModel = 'Session';

const actorKey = (model: string) => `${actorMapName}:${model}`;

const declaredActorModels = (map: SchemaMap): string[] => {
  const models = [...(map.actors?.models ?? [])];
  for (const model of models)
    if (!modelOf(map.fieldMap, model))
      throw new Error(`actors.models names \`${model}\`, which is not a model of the map`);
  if (map.actors?.session && models.includes(actorSessionModel))
    throw new Error(
      `actors.models names \`${actorSessionModel}\`, the name of the session's facts: rename one`,
    );
  return models;
};

/** The actor map: each acting model's own columns (never its relations), and the session. */
const actorFieldMap = (map: SchemaMap, models: readonly string[]): FieldMap => {
  const entries: Record<string, ModelEntry> = {};
  for (const model of models) {
    entries[model] = {
      fields: Object.fromEntries(
        columnsOf(map.fieldMap, model).map((column) => [
          column,
          fieldOf(map.fieldMap, model, column),
        ]),
      ) as ModelEntry['fields'],
    };
  }
  if (map.actors?.session) entries[actorSessionModel] = map.actors.session;
  return { models: entries, ...(map.fieldMap.enums ? { enums: map.fieldMap.enums } : {}) };
};

/**
 * What a rule lens anchored at `model` adds for the actor: the actor map, a supplied bridge from
 * the anchor to each acting model (and the session), and each turned on at the root with nothing
 * below it, so a rule reads the actor's own columns only.
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
  const models = declaredActorModels(map);
  const far = map.actors?.session ? [...models, actorSessionModel] : models;
  return {
    maps: { [actorMapName]: actorFieldMap(map, models) },
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
 * The record a `{ rule }` is checked on: every declared actor key written, the acting row under
 * `actor:<model>`, the session under `actor:Session`, the others empty, so a row can never carry
 * an actor of its own. A map that declares no actors has no actor in its rule lens, so a rule that
 * reads one is refused before it runs. Throws for an actor whose model a declaring map leaves out.
 */
export const recordWithActor = (map: SchemaMap, record: Row, actor: Actor | null): Row => {
  if (!map.actors) return record;
  const models = declaredActorModels(map);
  if (actor && !models.includes(actor.model))
    throw new Error(
      `\`${actor.model}\` is acting, but the map's actors.models does not declare it`,
    );
  const keys: Row = Object.fromEntries(
    models.map((model) => [actorKey(model), model === actor?.model ? actor.record : undefined]),
  );
  if (map.actors?.session) keys[actorKey(actorSessionModel)] = actor?.session;
  return { ...record, ...keys };
};
