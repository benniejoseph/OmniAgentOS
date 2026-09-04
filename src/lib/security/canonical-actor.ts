import type { SecurityContext } from "@/lib/security/types";

export const CANONICAL_AUTH_USER_ACTOR_VERSION = 1 as const;
export const CANONICAL_REQUEST_ACTOR_BINDING_VERSION = 1 as const;

export type CanonicalAuthUserActorV1 = Readonly<{
  version: typeof CANONICAL_AUTH_USER_ACTOR_VERSION;
  kind: "auth_user";
  authUserId: string;
  actorId: string;
}>;

export type CanonicalRequestActorBindingV1 = Readonly<{
  version: typeof CANONICAL_REQUEST_ACTOR_BINDING_VERSION;
  kind: "auth_user";
  authUserId: string;
  canonicalActorId: string;
  legacyOwnerActorIds: readonly string[];
  readableOwnerActorIds: readonly string[];
}>;

const canonicalAuthUserIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Returns the v46 canonical actor projection for an authenticated user.
 *
 * This is deliberately an accessor rather than an enumerable SecurityContext
 * field: browser and mobile APIs serialize that context directly. Unsupported
 * or legacy contexts stay unbound instead of being normalized or guessed.
 */
export function canonicalAuthUserActorFromSecurityContext(
  context: SecurityContext,
): CanonicalAuthUserActorV1 | undefined {
  if (
    context.source !== "session" ||
    !context.auth ||
    !canonicalAuthUserIdPattern.test(context.auth.userId) ||
    !context.auth.email ||
    context.actorId !== context.auth.email
  ) {
    return undefined;
  }

  return Object.freeze({
    version: CANONICAL_AUTH_USER_ACTOR_VERSION,
    kind: "auth_user" as const,
    authUserId: context.auth.userId,
    actorId: `actor:${context.auth.userId}`,
  });
}

/**
 * Builds the dormant v50 request binding for a canonical-first owner lookup.
 *
 * This helper does not change the served actor or authorize a lookup. Callers
 * must still preserve the actor stored on the selected row for AAD, hashes,
 * approvals, and receipts. Until a separately gated dual-read slice adopts
 * this binding, existing request and persistence behavior remains unchanged.
 */
export function canonicalRequestActorBindingFromSecurityContext(
  context: SecurityContext,
): CanonicalRequestActorBindingV1 | undefined {
  const canonicalActor = canonicalAuthUserActorFromSecurityContext(context);
  const legacyOwnerActorId = context.auth?.email;
  if (
    !canonicalActor ||
    !legacyOwnerActorId ||
    legacyOwnerActorId !== legacyOwnerActorId.trim() ||
    Array.from(legacyOwnerActorId).length > 320 ||
    legacyOwnerActorId === canonicalActor.actorId
  ) {
    return undefined;
  }

  const legacyOwnerActorIds = Object.freeze([legacyOwnerActorId]);
  const readableOwnerActorIds = Object.freeze([
    canonicalActor.actorId,
    ...legacyOwnerActorIds,
  ]);

  return Object.freeze({
    version: CANONICAL_REQUEST_ACTOR_BINDING_VERSION,
    kind: "auth_user" as const,
    authUserId: canonicalActor.authUserId,
    canonicalActorId: canonicalActor.actorId,
    legacyOwnerActorIds,
    readableOwnerActorIds,
  });
}
