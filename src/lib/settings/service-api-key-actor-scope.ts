import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const canonicalAuthUserIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Keeps request-bound PostgreSQL service-key metadata reads canonical-first.
 * Missing or malformed bindings repeat the exact actor so callers retain one
 * fixed query shape without widening service-principal or file-mode reads.
 */
export function serviceApiKeyActorReadOrder(
  actorId: string,
  binding?: CanonicalRequestActorBindingV1,
  exactFallbackActorId = actorId,
): readonly [string, string] {
  if (
    !binding ||
    binding.version !== 1 ||
    binding.kind !== "auth_user" ||
    !canonicalAuthUserIdPattern.test(binding.authUserId) ||
    !isExactRequestActor(actorId) ||
    binding.canonicalActorId !== `actor:${binding.authUserId}` ||
    !isExactRequestActor(binding.canonicalActorId) ||
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

function isExactRequestActor(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.trim() === value &&
    Array.from(value).length <= 320;
}
