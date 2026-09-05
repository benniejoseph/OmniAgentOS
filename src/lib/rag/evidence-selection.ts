const MAX_EXPLICIT_EVIDENCE_IDS = 24;
const EVIDENCE_ID_PATTERN = /^(?:memory|knowledge|graph):[^\s]+$/;

/** Client input is an ID allowlist only; evidence content stays server-owned. */
export function normalizeExplicitEvidenceIds(
  evidenceIds: readonly string[] | undefined,
): string[] | undefined {
  if (evidenceIds === undefined) return undefined;
  return [
    ...new Set(
      evidenceIds
        .map((id) => id.trim())
        .filter((id) => EVIDENCE_ID_PATTERN.test(id)),
    ),
  ].slice(0, MAX_EXPLICIT_EVIDENCE_IDS);
}

/**
 * Applies the same exact-ID intersection used after tenant-scoped retrieval.
 * An explicit ID not present in current retrieval candidates is not selected.
 */
export function selectExplicitEvidenceIds(input: {
  explicitEvidenceIds: readonly string[];
  retrievableEvidenceIds: readonly string[];
}): string[] {
  const allowed = new Set(normalizeExplicitEvidenceIds(input.explicitEvidenceIds));
  return input.retrievableEvidenceIds.filter((id) => allowed.has(id));
}

/**
 * Resolves an explicit allowlist against independently authorized exact IDs.
 * Semantic ranking candidates are deliberately not consulted: selecting an
 * exact saved item and discovering related items are different operations.
 */
export function resolveAuthorizedExplicitEvidenceIds(input: {
  explicitEvidenceIds: readonly string[];
  authorizedEvidenceIds: readonly string[];
}): string[] {
  const explicit = normalizeExplicitEvidenceIds(input.explicitEvidenceIds) || [];
  const authorized = new Set(
    normalizeExplicitEvidenceIds(input.authorizedEvidenceIds) || [],
  );
  return explicit.filter((id) => authorized.has(id));
}
