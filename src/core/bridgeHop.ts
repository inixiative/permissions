import type { Bridge, BridgeDictionary } from '@inixiative/json-rules';
import type { Row } from './types';

const splitResource = (resource: string): [string, string] => {
  const i = resource.indexOf(':');
  return i === -1 ? ['', resource] : [resource.slice(0, i), resource.slice(i + 1)];
};

export type BridgeHop = {
  farResource: string;
  localOn: string;
  farMap: string;
  farModel: string;
  farOn: string;
};

// A relation segment is a bridge when it names the OTHER endpoint's `map:model`. The local join key
// is this endpoint's `on` (a scalar already on the record); the far record joins on the other `on`.
export const bridgeHop = (
  bridges: Bridge[] | undefined,
  resource: string,
  segment: string,
): BridgeHop | null => {
  const [map, model] = splitResource(resource);
  for (const b of bridges ?? []) {
    const [a, c] = b.endpoints;
    const aKey = `${a.fieldMap}:${a.model}`;
    const cKey = `${c.fieldMap}:${c.model}`;
    // a → c. For `oneToMany`, c is the "many" side (endpoints[1]) — a single-record permission check
    // can't span a list, so this direction is NOT walkable; it would otherwise collapse to an
    // arbitrary `found[0]` (a non-deterministic wrong-allow). `oneToOne` is symmetric → walkable.
    if (a.fieldMap === map && a.model === model && cKey === segment) {
      if (b.cardinality === 'oneToMany') continue; // to-one walks only
      return {
        farResource: cKey,
        localOn: a.on,
        farMap: c.fieldMap,
        farModel: c.model,
        farOn: c.on,
      };
    }
    // c → a. The far endpoint a is the "one" side (oneToMany) or symmetric (oneToOne) — always to-one.
    if (c.fieldMap === map && c.model === model && aKey === segment) {
      return {
        farResource: aKey,
        localOn: c.on,
        farMap: a.fieldMap,
        farModel: a.model,
        farOn: a.on,
      };
    }
  }
  return null;
};

export const lookupFar = (
  dict: BridgeDictionary | undefined,
  hop: BridgeHop,
  farId: string,
): Row | undefined => {
  const found = dict?.[hop.farMap]?.[hop.farModel]?.[hop.farOn]?.[farId];
  if (found === undefined) return undefined;
  return Array.isArray(found) ? found[0] : found; // many→one: the single far row
};
