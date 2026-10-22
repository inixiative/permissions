import { get, isPlainObject } from 'lodash-es';
import type { Entitlements } from './types';

/** A root a writer may bind from: a row or a plain object, read by dotted path. */
export type BindRoots = Record<string, Record<string, unknown>>;

export class BindError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BindError';
  }
}

const PLACEHOLDER = /^\$(\w+)$/;
const ID_FIELD = /(^|\.)id$|Id$/;
export const SELF = 'self';

/**
 * Write-time binding for a holder's entitlements. Keys name a row by `self` (resolved when the
 * holder's permix is built) or by `$<root>` (that root's `id`); a rule's `value` may be
 * `{ bind: '<root>.<path>' }`. A literal on an `id` / `*Id` field is refused: ids are bound, never
 * written. `roots` names what this writer may bind from; a key or bind naming anything else throws.
 */
export const createInterpolator =
  (roots: readonly string[]) =>
  (entitlements: Entitlements, values: BindRoots): Entitlements => {
    const allowed = new Set(roots);
    const rootValue = (name: string) => {
      if (!allowed.has(name)) throw new BindError(`${name} is not a root this writer binds from`);
      const value = values[name];
      if (!value) throw new BindError(`Nothing to bind at ${name}`);
      return value;
    };

    const bindValue = (value: unknown, field?: string): unknown => {
      if (isPlainObject(value) && 'bind' in (value as object)) {
        const path = String((value as { bind: unknown }).bind);
        const [root, ...rest] = path.split('.');
        if (!root || !rest.length) throw new BindError(`A bind is <root>.<path>, got ${path}`);
        const bound = get(rootValue(root), rest.join('.'));
        if (bound === undefined) throw new BindError(`Nothing to bind at ${path}`);
        return bound;
      }
      if (field && ID_FIELD.test(field))
        throw new BindError(`An id is bound, never written: ${field}`);
      if (Array.isArray(value)) return value.map((item) => bindValue(item));
      if (isPlainObject(value)) {
        const record = value as Record<string, unknown>;
        const fieldName = typeof record.field === 'string' ? record.field : undefined;
        return Object.fromEntries(
          Object.entries(record).map(([key, item]) => [
            key,
            key === 'value' ? bindValue(item, fieldName) : bindValue(item),
          ]),
        );
      }
      return value;
    };

    const bindKey = (key: string): string => {
      const [map, model, id] = key.split(':');
      if (id === undefined || id === SELF) return key;
      const placeholder = PLACEHOLDER.exec(id);
      if (!placeholder)
        throw new BindError(`A grant key names a row by placeholder, never by id: ${key}`);
      const bound = rootValue(placeholder[1]).id;
      if (typeof bound !== 'string') throw new BindError(`${placeholder[0]} has no id to bind`);
      return `${map}:${model}:${bound}`;
    };

    if (!entitlements) return null;
    return Object.fromEntries(
      Object.entries(entitlements).map(([key, actions]) => [
        bindKey(key),
        bindValue(actions) as NonNullable<Entitlements>[string],
      ]),
    );
  };
