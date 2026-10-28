import { type BridgeDictionary, indexBridges } from '@inixiative/json-rules';
import { evaluate } from './evaluate';
import { indexMap, type SchemaMap } from './schemaMap';
import type { ActionRule, CheckOptions, PermixLike, RebacSchema, Subject } from './types';

export type RebacCheck<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  subject: Subject<R>,
  actionOrRule: ActionRule,
  visited?: Set<string>,
) => boolean;

/**
 * Build the rebac check, bound to the app's schema map.
 *
 * A `rel` hop reads the relation field from `map` (its `fieldMap` model, the resource it leads to);
 * a path's polymorphic kinds come from `map.polymorphism`. Cross-source `rel` hops are resolved by the engine from
 * `schema.bridges`: the join-key scalar on the record looks the far row up in a `BridgeDictionary`
 * the engine builds from `subject.data`; a far row absent there denies the walk. `string` delegates
 * (rbac via permix or schema), `{ rule }` is an ABAC predicate over the record and the actor (read
 * by path at `__actor`), `any`/`all` compose. Cycles throw rather than loop.
 */
export const createRebacCheck = <R extends string = string>(
  map: SchemaMap<R>,
  { absent = 'null' }: CheckOptions = {},
): RebacCheck<R> => {
  indexMap(map as SchemaMap);
  return (permix, schema, subject, actionOrRule, visited = new Set()) => {
    // Built lazily on the first bridge hop: a check that never crosses a bridge must not pay for —
    // or be crashed by (indexBridges throws on malformed `data`) — a dictionary it never reads.
    let built = false;
    let dict: BridgeDictionary | undefined;
    const getDict = (): BridgeDictionary | undefined => {
      if (!built) {
        built = true;
        dict = schema.bridges?.length
          ? indexBridges({ maps: {}, bridges: schema.bridges }, subject.data ?? {})
          : undefined;
      }
      return dict;
    };
    return evaluate(
      { map, absent, schema, getDict },
      permix,
      subject.resource,
      subject.record,
      actionOrRule,
      visited,
    );
  };
};
