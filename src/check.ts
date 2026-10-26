import { type BridgeDictionary, indexBridges } from '@inixiative/json-rules';
import { evaluate } from './evaluate';
import type { ActionRule, PermixLike, RebacSchema, ResolveRelation, Subject } from './types';

export type RebacCheck<R extends string = string> = (
  permix: PermixLike,
  schema: RebacSchema<R>,
  subject: Subject<R>,
  actionOrRule: ActionRule,
  visited?: Set<string>,
) => boolean;

/**
 * Build the rebac check, bound to an intra-map relation resolver.
 *
 * `resolveRelation(resource, segment)` maps a hydrated relation field to the resource it points at
 * (the ORM-specific seam the app injects). Cross-source `rel` hops are resolved by the engine from
 * `schema.bridges`: the join-key scalar on the record looks the far row up in a `BridgeDictionary`
 * the engine builds from `subject.data`; a far row absent there denies the walk. `string` delegates
 * (rbac via permix or schema), `{ rule }` is an ABAC predicate over the record (the actor's fields bound as `actor.<field>`), `{ actor }` one over
 * the actor, `any`/`all` compose. Cycles throw rather than loop.
 */
export const createRebacCheck = <R extends string = string>(
  resolveRelation: ResolveRelation<R>,
): RebacCheck<R> => {
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
      { resolveRelation, schema, getDict },
      permix,
      subject.resource,
      subject.record,
      actionOrRule,
      visited,
    );
  };
};
