import type { FieldMap } from '@inixiative/field-map';
import type { Bridge } from '@inixiative/json-rules';
import type { ResourcePermission } from './types';

/** A polymorphic model's discriminator: `field` names the kind, `fkMap` the columns each kind carries. */
export type PolymorphicAxis = { field: string; fkMap: Partial<Record<string, readonly string[]>> };

/** One field map's polymorphic models by model name, in the shape of a false-polymorphism registry. */
export type PolymorphismRegistry = Partial<Record<string, { axes: readonly PolymorphicAxis[] }>>;

/**
 * The one object the checks walk. What describes a map is keyed by map name: `fieldMaps` are the
 * field maps (`@inixiative/field-map`) of the records the app loads and walks, `suppliedFieldMaps`
 * those whose rows each check is given in its `bridgeData` (who is acting, for one), and
 * `polymorphismRegistries` say which kind a relation makes a polymorphic record. `bridges` are
 * json-rules bridges between their models. The rules (`permissions`) are keyed by resource: a model
 * goes by `map:Model` everywhere (`db:Inquiry`, `actor:User`), json-rules' endpoint key, the model
 * spelled as its field map spells it. Indexed once per object.
 */
export type SchemaMap<R extends string = string> = {
  fieldMaps: Record<string, FieldMap>;
  suppliedFieldMaps?: Record<string, FieldMap>;
  polymorphismRegistries?: Partial<Record<string, PolymorphismRegistry>>;
  bridges?: Bridge[];
  permissions: Partial<Record<R, ResourcePermission>>;
};

/** What the relation readers read: field maps by map name, and their polymorphism registries. */
export type FieldMapsWithPolymorphism = Pick<SchemaMap, 'fieldMaps' | 'polymorphismRegistries'>;
