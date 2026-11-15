import {
  type Condition,
  listFields,
  pathSegments,
  type ValidationIssue,
} from '@inixiative/json-rules';
import {
  fieldOf,
  isColumn,
  type LensNode,
  lensOf,
  listOf,
  relationOf,
  type SchemaMap,
  skipsHydration,
} from './schemaMap';

/** Where a walk stands under a list item: the list, and the declared path walked so far. */
export type Under = { list: string; prefix: readonly string[] };

/** Why a read leaves the lens: `lens` for the map, `down` for what a list's declaration loads. */
export type LensMiss = { code: 'lens' | 'down'; message: string };

export const notLoaded = (under: Under, prefix: readonly string[]): LensMiss => ({
  code: 'down',
  message: `\`${under.list}\` loads no \`${prefix.join('.')}\` under an item: name it in \`/// @permissions(down: [...])\``,
});

export const listMessage = (map: SchemaMap, resource: string, segment: string): string =>
  listOf(map, resource, segment)
    ? `\`${resource}.${segment}\` is a list: no path reads into one; cross it with { rel: '${segment}', arrayOperator: 'any', condition }`
    : `\`${resource}.${segment}\` is a list: no path reads into one; declare it (\`/// @permissions(down: [...])\`) and cross it with { rel: '${segment}', arrayOperator: 'any', condition }`;

/** Why a to-one relation of the model is outside the lens: nothing hydrates it. */
export const outsideMessage = (map: SchemaMap, resource: string, segment: string): string => {
  const field = fieldOf(map, resource, segment);
  const at = `\`${resource}.${segment}\``;
  if (field?.kind === 'bridge') return `${at} is a bridge: cross it with { rel, action }`;
  if (skipsHydration(field))
    return `${at} is \`hydrate: false\`: nothing loads it, so no rule reads it; drop the annotation or read it from \`${field?.type}\``;
  if (!field?.fromFields?.length)
    return `${at} keeps its foreign key on \`${field?.type}\`: nothing loads it; write the rule on \`${field?.type}\`, or hold the key on this model`;
  return `${at} leads to \`${field.type}\`, which is not a resource in the map: nothing loads it`;
};

const lens = (message: string): LensMiss => ({ code: 'lens', message });

/**
 * Why one path a rule reads from a row at `start` leaves the lens, or null. A path at `__actor`,
 * a first key the model does not have (the root's computed field) and anything past a column
 * (a Json sub-path, an index into a scalar list) are not the lens's. Otherwise each key is a
 * column or a to-one relation of the node it stands on; a list, a relation outside the lens, an
 * index into a relation and a key the model does not have are refused, and so is coming back to
 * a model the path already passed, except on a declared `down` path, which is loaded as written.
 */
export const pathMiss = (
  map: SchemaMap,
  start: LensNode,
  path: string,
  under?: Under,
): LensMiss | null => {
  const segments = pathSegments(path);
  if (segments[0] === '__actor') return null;
  let node = start;
  const passed = new Set([start.resource]);
  const walked: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const field = fieldOf(map, node.resource, segment);
    if (!field) {
      if (index === 0) return null;
      return lens(
        /^\d+$/.test(segment)
          ? `\`${path}\`: \`${walked.join('.')}\` is one row and is never indexed; read its fields`
          : `\`${node.resource}\` has no field \`${segment}\` (\`${path}\`)`,
      );
    }
    if (isColumn(field)) return null;
    if (field.isList) return lens(listMessage(map, node.resource, segment));
    if (!node.toOne.has(segment)) {
      if (under && relationOf(map, node.resource, segment))
        return notLoaded(under, [...under.prefix, ...walked, segment]);
      return lens(outsideMessage(map, node.resource, segment));
    }
    walked.push(segment);
    const next = node.below(segment);
    if (!node.down && passed.has(next.resource))
      return lens(
        `\`${path}\` comes back to \`${next.resource}\`: a path passes each model once, and hydration stops where a loop closes; read it from \`${next.resource}\` itself`,
      );
    passed.add(next.resource);
    node = next;
  }
  return null;
};

/** Every path a json-rules condition reads from a row at `node` that leaves the lens. */
export const conditionMisses = (
  map: SchemaMap,
  node: LensNode,
  condition: Condition,
  at: string,
  under?: Under,
): ValidationIssue[] =>
  listFields(condition).flatMap((field) => {
    const miss = pathMiss(map, node, field, under);
    return miss ? [{ path: at, ...miss }] : [];
  });

const judgedWheres = new WeakMap<SchemaMap, WeakMap<object, Map<string, boolean>>>();

/** Whether every path an entitlement's `where` reads at `resource` stays in the lens, memoised. */
export const whereInLens = (map: SchemaMap, resource: string, where: Condition): boolean => {
  if (typeof where !== 'object' || where === null) return true;
  const byWhere = judgedWheres.get(map) ?? new WeakMap<object, Map<string, boolean>>();
  judgedWheres.set(map, byWhere);
  const byResource = byWhere.get(where) ?? new Map<string, boolean>();
  byWhere.set(where, byResource);
  const known = byResource.get(resource);
  if (known !== undefined) return known;
  const ok = conditionMisses(map, lensOf(map, resource), where, '$').length === 0;
  byResource.set(resource, ok);
  return ok;
};
