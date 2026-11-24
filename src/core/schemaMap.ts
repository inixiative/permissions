import type { FieldMap } from '@inixiative/field-map';
import type { Bridge, JoinedBridge, SuppliedBridge } from '@inixiative/json-rules';
import type { ResourcePermission } from './types';

/** A polymorphic model's discriminator: `field` names the kind, `fkMap` the columns each kind carries. */
export type PolymorphicAxis = { field: string; fkMap: Partial<Record<string, readonly string[]>> };

/** One field map's polymorphic models by model name, in the shape of a false-polymorphism registry. */
export type PolymorphismRegistry = Partial<Record<string, { axes: readonly PolymorphicAxis[] }>>;

/**
 * The one object the checks walk. What describes a map is keyed by map name: `fieldMaps` are the
 * field maps (`@inixiative/field-map`) of every model a rule reads, and `polymorphismRegistries`
 * say which kind a relation makes a polymorphic record. `bridges` are json-rules bridges between
 * their models: a joined bridge is crossed by a `rel`; a supplied bridge (no join) makes its far
 * model one whose row each check is given in its `bridgeData` (who is acting, for one), read by
 * rules on the models it starts from. The rules (`permissions`) are keyed by resource: a model goes
 * by `map:Model` everywhere (`db:Inquiry`, `actor:User`), json-rules' endpoint key, the model
 * spelled as its field map spells it. Indexed once per object.
 */
export type SchemaMap<R extends string = string> = {
  fieldMaps: Record<string, FieldMap>;
  polymorphismRegistries?: Partial<Record<string, PolymorphismRegistry>>;
  bridges?: Bridge[];
  permissions: Partial<Record<R, ResourcePermission>>;
};

/**
 * A schema map with its supplied maps told apart, as every reader inside the library takes it:
 * `fieldMaps` are the record maps alone, `suppliedFieldMaps` the supplied ones, `bridges` the
 * joined bridges and `suppliedBridges` the declared supplied ones. Made once per schema map by
 * `resolvedSchemaMap`.
 */
export type ResolvedSchemaMap<R extends string = string> = {
  fieldMaps: Record<string, FieldMap>;
  suppliedFieldMaps: Record<string, FieldMap>;
  polymorphismRegistries: Partial<Record<string, PolymorphismRegistry>> | undefined;
  bridges: JoinedBridge[];
  suppliedBridges: SuppliedBridge[];
  permissions: Partial<Record<R, ResourcePermission>>;
  /** Every field map the schema map declares, records and supplied alike. */
  declaredFieldMaps: Record<string, FieldMap>;
  /** The schema map's own list of bridges, frozen with its rules on first use. */
  declaredBridges: Bridge[] | undefined;
};

/** What the relation readers read: field maps by map name, and their polymorphism registries. */
export type FieldMapsWithPolymorphism = Pick<SchemaMap, 'fieldMaps' | 'polymorphismRegistries'>;
