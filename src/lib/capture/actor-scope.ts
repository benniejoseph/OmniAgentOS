import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const canonicalAuthUserIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Keeps request-bound PostgreSQL Capture reads canonical-first while treating
 * a missing or malformed binding as an exact-actor read. Capture persistence
 * accepts actor identifiers up to 256 UTF-16 code units.
 */
export function captureActorReadOrder(
  actorId: string,
  binding?: CanonicalRequestActorBindingV1,
  exactFallbackActorId = actorId,
): readonly [string, string] {
  if (
    !binding ||
    binding.version !== 1 ||
    binding.kind !== "auth_user" ||
    !canonicalAuthUserIdPattern.test(binding.authUserId) ||
    !isExactCaptureActorId(actorId) ||
    binding.canonicalActorId !== `actor:${binding.authUserId}` ||
    !isExactCaptureActorId(binding.canonicalActorId) ||
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

function isExactCaptureActorId(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value.trim() === value;
}
