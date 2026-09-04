import type { SecurityContext } from "@/lib/security/types";

export const CANONICAL_AUTH_USER_ACTOR_VERSION = 1 as const;

export type CanonicalAuthUserActorV1 = Readonly<{
  version: typeof CANONICAL_AUTH_USER_ACTOR_VERSION;
  kind: "auth_user";
  authUserId: string;
  actorId: string;
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
