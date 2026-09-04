import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";

const canonicalAuthUserIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Keeps request-bound PostgreSQL custom-skill reads canonical-first while a
 * missing or malformed binding falls back to the store's exact actor scope.
 */
export function skillActorReadOrder(
  actorId: string,
  binding?: CanonicalRequestActorBindingV1,
  exactFallbackActorId = actorId,
): readonly [string, string] {
  if (
    !binding ||
    binding.version !== 1 ||
    binding.kind !== "auth_user" ||
    !canonicalAuthUserIdPattern.test(binding.authUserId) ||
    safeActorId(actorId) !== actorId ||
    binding.canonicalActorId !== `actor:${binding.authUserId}` ||
    safeActorId(binding.canonicalActorId) !== binding.canonicalActorId ||
    binding.canonicalActorId === actorId ||
    !Array.isArray(binding.legacyOwnerActorIds) ||
    binding.legacyOwnerActorIds.length !== 1 ||
    binding.legacyOwnerActorIds[0] !== actorId ||
    !Array.isArray(binding.readableOwnerActorIds) ||
    binding.readableOwnerActorIds.length !== 2 ||
    binding.readableOwnerActorIds[0] !== binding.canonicalActorId ||
    binding.readableOwnerActorIds[1] !== actorId
  ) {
    return [exactFallbackActorId, exactFallbackActorId];
  }
  return [binding.canonicalActorId, actorId];
}

function safeActorId(value: string) {
  return String(redactSensitive(value || "")).trim().slice(0, 200);
}
