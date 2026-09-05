import { z } from "zod";

const MAX_ITEMS = 128;
const idSchema = z.string().trim().min(1).max(240);
const propositionSchema = z.object({
  subject: z.string().trim().min(1).max(500),
  predicate: z.string().trim().min(1).max(500),
  object: z.union([
    z.string().max(4_000),
    z.number().finite(),
    z.boolean(),
    z.null(),
  ]),
}).strict();

const inputSchema = z.object({
  claims: z.array(z.object({
    id: idSchema,
    proposition: propositionSchema,
    material: z.boolean(),
  }).strict()).min(1).max(MAX_ITEMS),
  evidenceUnits: z.array(z.object({
    id: idSchema,
    assertions: z.array(propositionSchema).max(MAX_ITEMS),
  }).strict()).max(MAX_ITEMS),
  candidateLinks: z.array(z.object({
    claimId: idSchema,
    evidenceId: idSchema,
  }).strict()).max(MAX_ITEMS * MAX_ITEMS),
  authorizedEvidenceIds: z.array(idSchema).max(MAX_ITEMS),
}).strict();

export type StructuredClaimSupportResult = Readonly<{
  claims: readonly Readonly<{
    id: string;
    supportState: "supported" | "unsupported";
    verified: boolean;
    evidenceIds: readonly string[];
  }>[];
  materialCoverageBasisPoints: number;
  unauthorizedEvidenceCount: number;
}>;

/**
 * Deterministic support for structured subject/predicate/object claims.
 * Candidate citation IDs are never support by themselves: an authorized,
 * linked evidence assertion must exactly match the full proposition.
 */
export function evaluateStructuredClaimSupport(
  input: unknown,
): StructuredClaimSupportResult {
  const parsed = inputSchema.parse(input);
  assertUniqueIds(parsed.claims.map((claim) => claim.id), "claim");
  assertUniqueIds(
    parsed.evidenceUnits.map((evidence) => evidence.id),
    "evidence",
  );

  const claimsById = new Map(parsed.claims.map((claim) => [claim.id, claim]));
  const evidenceById = new Map(
    parsed.evidenceUnits.map((evidence) => [evidence.id, evidence]),
  );
  const authorizedEvidenceIds = new Set(parsed.authorizedEvidenceIds);
  const unauthorizedEvidenceIds = new Set<string>();
  const linkedEvidenceByClaim = new Map<string, Set<string>>();

  for (const link of parsed.candidateLinks) {
    if (!claimsById.has(link.claimId) || !evidenceById.has(link.evidenceId)) {
      continue;
    }
    if (!authorizedEvidenceIds.has(link.evidenceId)) {
      unauthorizedEvidenceIds.add(link.evidenceId);
      continue;
    }
    const linked = linkedEvidenceByClaim.get(link.claimId) || new Set<string>();
    linked.add(link.evidenceId);
    linkedEvidenceByClaim.set(link.claimId, linked);
  }

  const claims = parsed.claims.map((claim) => {
    const proposition = canonicalProposition(claim.proposition);
    const evidenceIds = [...(linkedEvidenceByClaim.get(claim.id) || [])]
      .filter((evidenceId) => evidenceById.get(evidenceId)?.assertions.some(
        (assertion) => canonicalProposition(assertion) === proposition,
      ))
      .sort();
    const supported = evidenceIds.length > 0;
    return Object.freeze({
      id: claim.id,
      supportState: supported ? "supported" as const : "unsupported" as const,
      verified: supported,
      evidenceIds: Object.freeze(evidenceIds),
    });
  });
  const materialClaims = parsed.claims.filter((claim) => claim.material);
  const supportedMaterialClaims = materialClaims.filter((claim) =>
    claims.find((result) => result.id === claim.id)?.supportState === "supported"
  );

  return Object.freeze({
    claims: Object.freeze(claims),
    materialCoverageBasisPoints: materialClaims.length
      ? Math.floor((supportedMaterialClaims.length * 10_000) / materialClaims.length)
      : 10_000,
    unauthorizedEvidenceCount: unauthorizedEvidenceIds.size,
  });
}

function canonicalProposition(
  proposition: z.infer<typeof propositionSchema>,
) {
  return JSON.stringify([
    proposition.subject,
    proposition.predicate,
    proposition.object,
  ]);
}

function assertUniqueIds(ids: readonly string[], kind: string) {
  if (new Set(ids).size !== ids.length) {
    throw new Error(`Structured ${kind} IDs must be unique.`);
  }
}
