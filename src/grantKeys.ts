import type { Entitlements, PermissionEntry } from './permix';

/** The placeholder a grant key may name for a subject the grant is bound to: `db:integration:$self`. */
export const SELF = '$self';

export type GrantKey = { resource: string; id?: string };

/**
 * Split a grant key into its resource and optional row id. `resources` are the schema's resource keys
 * (which may themselves contain `:`, e.g. `db:integration`); the longest that prefixes the key wins.
 * Returns null for a key naming no known resource.
 */
export const parseGrantKey = (key: string, resources: readonly string[]): GrantKey | null => {
  let best: string | null = null;
  for (const resource of resources) {
    if (
      (key === resource || key.startsWith(`${resource}:`)) &&
      resource.length > (best?.length ?? -1)
    )
      best = resource;
  }
  if (best === null) return null;
  if (key === best) return { resource: best };
  const id = key.slice(best.length + 1);
  return id ? { resource: best, id } : null;
};

/** The grant's bound subjects by resource, e.g. `{ 'db:integration': 'i1', 'db:organization': 'o1' }`. */
export type GrantSubjects = Record<string, string | null | undefined>;

/** The placeholders a grant bound to `subjects` may use: `['db:integration:$self', …]`. */
export const selfPlaceholders = (subjects: GrantSubjects): string[] =>
  Object.entries(subjects)
    .filter(([, id]) => typeof id === 'string' && id.length > 0)
    .map(([resource]) => `${resource}:${SELF}`);

export type InterpolatedGrant<V> =
  | { ok: true; value: Record<string, V> | null }
  | { ok: false; unresolved: string[] };

/**
 * Write-time self interpolation: every `<resource>:$self` key becomes `<resource>:<id>` for the
 * grant's own subject of that resource. Only keys are rewritten, never values. Two keys landing on
 * the same literal key merge (the later action wins). A placeholder whose subject is absent makes the
 * whole grant unresolved: refuse the write and name them.
 */
export const interpolateSelf = <V extends Record<string, unknown>>(
  grant: Record<string, V> | null,
  subjects: GrantSubjects,
): InterpolatedGrant<V> => {
  if (!grant) return { ok: true, value: grant };
  const suffix = `:${SELF}`;
  const unresolved: string[] = [];
  const value: Record<string, V> = {};
  for (const [key, actions] of Object.entries(grant)) {
    let target = key;
    if (key.endsWith(suffix)) {
      const id = subjects[key.slice(0, -suffix.length)];
      if (!id) {
        unresolved.push(key);
        continue;
      }
      target = `${key.slice(0, -suffix.length)}:${id}`;
    }
    value[target] = { ...value[target], ...actions } as V;
  }
  return unresolved.length ? { ok: false, unresolved } : { ok: true, value };
};

/**
 * Turn stored entitlements into permix entries: a bare resource key is resource-wide, an id key is
 * that row; `true` is a held action, any other value a rule the engine evaluates. Throws on a key that
 * names no known resource or still holds `$self` (validate and interpolate before storing).
 */
export const entitlementEntries = (
  entitlements: Entitlements,
  resources: readonly string[],
): PermissionEntry[] =>
  Object.entries(entitlements ?? {}).map(([key, actions]) => {
    const parsed = parseGrantKey(key, resources);
    if (!parsed) throw new Error(`Unknown grant key: ${key}`);
    if (parsed.id === SELF) throw new Error(`Uninterpolated grant key: ${key}`);
    return parsed.id
      ? { resource: parsed.resource, id: parsed.id, actions }
      : { resource: parsed.resource, actions };
  });
