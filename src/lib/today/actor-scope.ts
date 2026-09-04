import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";

/**
 * Keeps request-bound PostgreSQL Today lookups canonical-first while treating
 * a missing or malformed binding as an exact-actor read. Returning the exact
 * actor twice lets callers use one fixed query shape in both modes.
 */
export function todayActorReadOrder(
  actorId: string,
  binding?: CanonicalRequestActorBindingV1,
  exactFallbackActorId = actorId,
): readonly [string, string] {
  if (
    !binding ||
    binding.version !== 1 ||
    binding.kind !== "auth_user" ||
    safeText(actorId, 200) !== actorId ||
    binding.canonicalActorId !== `actor:${binding.authUserId}` ||
    binding.canonicalActorId === actorId ||
    !Array.isArray(binding.legacyOwnerActorIds) ||
    binding.legacyOwnerActorIds.length !== 1 ||
    binding.legacyOwnerActorIds[0] !== actorId ||
    !Array.isArray(binding.readableOwnerActorIds) ||
    binding.readableOwnerActorIds.length !== 2 ||
    binding.readableOwnerActorIds[0] !== binding.canonicalActorId ||
    binding.readableOwnerActorIds[1] !== actorId ||
    safeText(binding.canonicalActorId, 200) !== binding.canonicalActorId
  ) {
    return [exactFallbackActorId, exactFallbackActorId];
  }
  return [binding.canonicalActorId, actorId];
}

function safeText(value: string, max: number) {
  return String(redactSensitive(value)).replace(/\s+/g, " ").trim().slice(0, max);
}
