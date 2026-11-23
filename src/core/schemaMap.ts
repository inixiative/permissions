import type { FieldMap } from '@inixiative/field-map';
import type { Bridge } from '@inixiative/json-rules';
import type { ResourcePermission } from './types';

/** A polymorphic model's discriminator: `field` names the kind, `fkMap` the columns each kind carries. */
export type PolymorphicAxis = { field: string; fkMap: Partial<Record<string, readonly string[]>> };

/** Polymorphic models by model name, in the shape of a false-polymorphism registry. */
export type Polymorphism = Partial<Record<string, { axes: readonly PolymorphicAxis[] }>>;

/**
 * The map before it has rules: what the rule builders and every reader of the data shape take.
 * `maps` are the field maps (`@inixiative/field-map`) of the records the app loads and walks,
 * `supplied` those whose rows each check is given in its `data` (who is acting, for one), both by
 * map name; `bridges` are json-rules bridges between their models; `polymorphism` says, by map name
 * then model, which kind a relation makes a polymorphic record. A model goes by `map:Model`
 * everywhere (`db:Inquiry`, `actor:User`): json-rules' endpoint key, the model spelled as its field
 * map spells it.
 */
export type SchemaMapWithoutPermissions = {
  maps: Record<string, FieldMap>;
  supplied?: Record<string, FieldMap>;
  bridges?: Bridge[];
  polymorphism?: Partial<Record<string, Polymorphism>>;
};

/** The schema the checks walk: the data shape and the rules, by resource (`map:Model`). Indexed once per map object. */
export type SchemaMap<R extends string = string> = SchemaMapWithoutPermissions & {
  permissions: Partial<Record<R, ResourcePermission>>;
};
