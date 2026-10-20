import type { Actor, ActorValue, Party } from './types';

export const DEFAULT_ACTOR_MODEL = 'User';

export type ActorInput = {
  id: string;
  /** What kind of thing acts. Defaults to `'User'`. */
  model?: string;
  /** Whose authority it draws on. Defaults to the actor itself (`{ model, id }`). */
  principal?: Party;
} & { [field: string]: ActorValue | Party | undefined };

/** Fill an actor's defaults: `model` is `'User'`, the principal is the actor itself. */
export const defineActor = ({
  id,
  model = DEFAULT_ACTOR_MODEL,
  principal,
  ...meta
}: ActorInput): Actor => ({ ...meta, model, id, principal: principal ?? { model, id } }) as Actor;

/**
 * The default `selfId`: the person behind the actor. A principal whose model is `'User'` is that
 * person; any other principal answers with its `userId` (a membership), or null (an organization).
 */
export const defaultSelfId = (actor: Actor | null): string | null => {
  if (!actor) return null;
  const { principal } = actor;
  if (principal.model === DEFAULT_ACTOR_MODEL) return principal.id;
  return typeof principal.userId === 'string' ? principal.userId : null;
};
