import { listBindings, type RuleValue } from '@inixiative/json-rules';
import type { Actor } from './types';

// The actor's fields, as the `actor.<field>` binds a `{ rule }` may compare a record against.
export const actorBindings = (actor: Actor | null): Record<string, RuleValue> =>
  actor
    ? Object.fromEntries(Object.entries(actor).map(([k, v]) => [`actor.${k}`, v as RuleValue]))
    : {};

// Optional binds included: with nobody acting, `ownerId notEquals actor.id` must not pass on null.
export const readsActor = (condition: Parameters<typeof listBindings>[0]): boolean =>
  listBindings(condition).some((name) => name.startsWith('actor.'));
