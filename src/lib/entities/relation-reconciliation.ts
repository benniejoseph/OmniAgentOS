import {
  parseTemporalRelationClaimRecord,
  parseTemporalRelationClaimRevision,
  reviseTemporalRelationClaim,
  type TemporalRelationClaimRecord,
  type TemporalRelationClaimRevision,
} from "@/lib/entities/temporal-claims";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export type RelationProjectionReconciliation = Readonly<{
  appendedRevisions: readonly TemporalRelationClaimRevision[];
  activeClaims: readonly TemporalRelationClaimRevision[];
  createdCount: number;
  revisedCount: number;
  retractedCount: number;
  unchangedCount: number;
  stateSha256: string;
}>;

/**
 * Converges the append-only relation ledger on one deterministic desired set.
 * This pure function is shared by queued incremental repair and operator full
 * rebuild, making their final active state byte-for-byte comparable.
 */
export function reconcileRelationProjectionState(input: {
  desiredClaims: readonly TemporalRelationClaimRevision[];
  currentRecords: readonly TemporalRelationClaimRecord[];
  reconciledAt?: string;
}): RelationProjectionReconciliation {
  const desired = input.desiredClaims.map(parseTemporalRelationClaimRevision);
  const currentRecords = input.currentRecords.map(
    parseTemporalRelationClaimRecord,
  );
  assertUnique(desired.map((claim) => claim.claimId), "desired claim");
  const current = currentRecords.filter((record) => record.supersededAt === null);
  assertUnique(current.map((record) => record.claim.claimId), "current claim");
  const currentById = new Map(current.map((record) => [
    record.claim.claimId,
    record.claim,
  ]));
  const desiredById = new Map(desired.map((claim) => [claim.claimId, claim]));
  const appendedRevisions: TemporalRelationClaimRevision[] = [];
  const finalById = new Map(currentById);
  let createdCount = 0;
  let revisedCount = 0;
  let retractedCount = 0;
  let unchangedCount = 0;
  const reconciledAt = canonicalTimestamp(
    input.reconciledAt || new Date().toISOString(),
  );

  for (const desiredClaim of desired) {
    const stored = currentById.get(desiredClaim.claimId);
    if (!stored) {
      appendedRevisions.push(desiredClaim);
      finalById.set(desiredClaim.claimId, desiredClaim);
      createdCount += 1;
      continue;
    }
    if (activeStateSha256(stored) === activeStateSha256(desiredClaim)) {
      unchangedCount += 1;
      continue;
    }
    const revision = reviseTemporalRelationClaim({
      current: stored,
      source: desiredClaim.source,
      target: desiredClaim.target,
      epistemicKind: desiredClaim.epistemicKind,
      claimState: "active",
      confidenceBasisPoints: desiredClaim.confidenceBasisPoints,
      lineage: desiredClaim.lineage,
      validFrom: desiredClaim.validFrom,
      validTo: desiredClaim.validTo,
      recordedAt: advancingTimestamp(reconciledAt, stored.recordedAt),
    });
    appendedRevisions.push(revision);
    finalById.set(revision.claimId, revision);
    revisedCount += 1;
  }

  for (const stored of currentById.values()) {
    if (
      desiredById.has(stored.claimId) ||
      stored.claimState === "retracted" ||
      !isCanonicalProjectionClaim(stored)
    ) continue;
    const revision = reviseTemporalRelationClaim({
      current: stored,
      claimState: "retracted",
      recordedAt: advancingTimestamp(reconciledAt, stored.recordedAt),
    });
    appendedRevisions.push(revision);
    finalById.set(revision.claimId, revision);
    retractedCount += 1;
  }

  const activeClaims = [...finalById.values()]
    .filter((claim) =>
      claim.claimState === "active" && isCanonicalProjectionClaim(claim)
    )
    .sort((left, right) => left.claimId.localeCompare(right.claimId));
  return deepFreeze({
    appendedRevisions: appendedRevisions.sort((left, right) =>
      left.claimId.localeCompare(right.claimId)
    ),
    activeClaims,
    createdCount,
    revisedCount,
    retractedCount,
    unchangedCount,
    stateSha256: sourceContractSha256(
      activeClaims.map(activeStateContract),
    ),
  });
}

export function relationProjectionActiveStateSha256(
  claims: readonly TemporalRelationClaimRevision[],
) {
  return sourceContractSha256(claims
    .map(parseTemporalRelationClaimRevision)
    .filter((claim) =>
      claim.claimState === "active" && isCanonicalProjectionClaim(claim)
    )
    .sort((left, right) => left.claimId.localeCompare(right.claimId))
    .map(activeStateContract));
}

function isCanonicalProjectionClaim(claim: TemporalRelationClaimRevision) {
  return claim.lineage.length > 0 && claim.lineage.every((reference) =>
    reference.kind === "memory" || reference.kind === "evidence_unit"
  );
}

function activeStateSha256(claim: TemporalRelationClaimRevision) {
  return sourceContractSha256(activeStateContract(claim));
}

function activeStateContract(claim: TemporalRelationClaimRevision) {
  return {
    claimId: claim.claimId,
    ontologyVersionId: claim.ontologyVersionId,
    relationTypeId: claim.relationTypeId,
    source: claim.source,
    target: claim.target,
    epistemicKind: claim.epistemicKind,
    claimState: claim.claimState,
    confidenceBasisPoints: claim.confidenceBasisPoints,
    accessScopeSha256: claim.accessBinding.accessScopeSha256,
    lineage: claim.lineage,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
  };
}

function advancingTimestamp(requested: string, previous: string) {
  const requestedMs = Date.parse(requested);
  const previousMs = Date.parse(previous);
  return new Date(Math.max(requestedMs, previousMs + 1)).toISOString();
}

function canonicalTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Relation projection reconciliation time is invalid.");
  }
  return parsed.toISOString();
}

function assertUnique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) {
    throw new Error(`Relation projection contains a duplicate ${label}.`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}
