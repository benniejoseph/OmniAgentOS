import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  memoryTierPolicy,
  resolveMemoryTier,
  type MemoryTier,
} from "@/lib/memory/tier-policy";
import type { MemoryRecord } from "@/lib/memory/types";

export const MEMORY_LIFECYCLE_POLICY_VERSION = 1 as const;
export const MEMORY_EXACT_DUPLICATE_RATE_TARGET = 0.01;

export const memoryArchiveReasonSchema = z.enum([
  "manual",
  "exact_duplicate",
  "retention_expired",
]);

export type MemoryArchiveReason = z.infer<typeof memoryArchiveReasonSchema>;

export const memoryLifecycleActionSchema = z.enum([
  "pin",
  "unpin",
  "archive",
  "restore",
]);

export type MemoryLifecycleAction = z.infer<
  typeof memoryLifecycleActionSchema
>;

export const memoryPromotionDecisionSchema = z.enum(["promote", "dismiss"]);
export type MemoryPromotionDecision = z.infer<
  typeof memoryPromotionDecisionSchema
>;

export type MemoryPromotionReview = Readonly<{
  id: string;
  tenantId: string;
  ownerActorId?: string;
  policyVersion: typeof MEMORY_LIFECYCLE_POLICY_VERSION;
  status: "pending" | "resolved";
  decision?: MemoryPromotionDecision;
  sourceMemoryIds: readonly string[];
  canonicalMemoryId: string;
  sourceClaimSha256: string;
  targetTier: "procedural";
  promotedMemoryId?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}>;

export type MemoryMaintenanceReport = Readonly<{
  policyVersion: typeof MEMORY_LIFECYCLE_POLICY_VERSION;
  scanned: number;
  eligible: number;
  exactDuplicateGroups: number;
  autoArchivedDuplicates: number;
  pinnedDuplicateConflicts: number;
  promotionReviewsCreated: number;
  expiredArchived: number;
  duplicateRateBefore: number;
  duplicateRateAfter: number;
  duplicateRateTarget: typeof MEMORY_EXACT_DUPLICATE_RATE_TARGET;
}>;

export type MemoryLifecyclePolicyV1 = Readonly<{
  version: typeof MEMORY_LIFECYCLE_POLICY_VERSION;
  duplicateRateTarget: typeof MEMORY_EXACT_DUPLICATE_RATE_TARGET;
  deduplication: Readonly<{
    match: "normalized_exact_claim";
    canonicalOrder: readonly ["pinned", "confidence", "usage", "oldest", "id"];
    disposition: "reversible_archive";
    pinnedRecordsAreProtected: true;
  }>;
  decay: Readonly<{
    mutatesHistoricalTruth: false;
    minimumMultiplier: number;
    pinnedMultiplier: number;
    halfLifeDaysByTier: Readonly<Record<MemoryTier, number>>;
  }>;
  promotion: Readonly<{
    sourceTier: "episodic";
    targetTier: "procedural";
    reviewRequired: true;
    minimumVerifiedOccurrences: number;
    exactClaimRequired: true;
  }>;
  archive: Readonly<{
    reversible: true;
    separateFromDeletion: true;
    excludedFromRetrieval: true;
  }>;
}>;

export const memoryLifecyclePolicyV1 = Object.freeze({
  version: MEMORY_LIFECYCLE_POLICY_VERSION,
  duplicateRateTarget: MEMORY_EXACT_DUPLICATE_RATE_TARGET,
  deduplication: Object.freeze({
    match: "normalized_exact_claim" as const,
    canonicalOrder: Object.freeze([
      "pinned",
      "confidence",
      "usage",
      "oldest",
      "id",
    ] as const),
    disposition: "reversible_archive" as const,
    pinnedRecordsAreProtected: true as const,
  }),
  decay: Object.freeze({
    mutatesHistoricalTruth: false as const,
    minimumMultiplier: 0.35,
    pinnedMultiplier: 1.35,
    halfLifeDaysByTier: Object.freeze({
      working: 3,
      episodic: 30,
      semantic: 180,
      procedural: 365,
      preference: 365,
      decision: 365,
      commitment: 90,
      summary: 90,
    }),
  }),
  promotion: Object.freeze({
    sourceTier: "episodic" as const,
    targetTier: "procedural" as const,
    reviewRequired: true as const,
    minimumVerifiedOccurrences: memoryTierPolicy("episodic").promotion
      .minimumVerifiedOccurrences,
    exactClaimRequired: true as const,
  }),
  archive: Object.freeze({
    reversible: true as const,
    separateFromDeletion: true as const,
    excludedFromRetrieval: true as const,
  }),
}) satisfies MemoryLifecyclePolicyV1;

export function memoryClaimFingerprint(record: MemoryRecord) {
  return sha256(JSON.stringify({
    version: MEMORY_LIFECYCLE_POLICY_VERSION,
    tier: resolveMemoryTier(record.tier, record.type),
    type: record.type,
    scope: record.scope,
    title: normalizedClaimText(record.title),
    content: normalizedClaimText(record.content),
    tags: [...new Set(record.tags.map(normalizedClaimText).filter(Boolean))]
      .sort(compareIds),
    validFrom: record.validFrom || null,
    validTo: record.validTo || null,
    accessScopeSha256: record.accessBinding?.accessScopeSha256 || null,
  }));
}

export function memoryPromotionReviewId(input: {
  tenantId: string;
  ownerActorId?: string;
  sourceClaimSha256: string;
}) {
  return `memory_promotion_${sha256(JSON.stringify({
    version: MEMORY_LIFECYCLE_POLICY_VERSION,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId || null,
    sourceClaimSha256: input.sourceClaimSha256,
    targetTier: "procedural",
  })).slice(0, 48)}`;
}

export function memoryPromotedRecordId(reviewId: string) {
  return `memory_promoted_${sha256(reviewId).slice(0, 48)}`;
}

export function isVerifiedPromotionEpisode(record: MemoryRecord) {
  const trustedFormation = new Set([
    "explicit_user_request",
    "canonical_source_observation",
    "verified_effect",
  ]);
  return record.claimStatus === "active" &&
    resolveMemoryTier(record.tier, record.type) === "episodic" &&
    trustedFormation.has(record.formationReason || "") &&
    (record.confidence ?? 0) >= 0.8 &&
    Boolean(record.evidenceRefs?.length);
}

export function verifiedMemoryOccurrenceKey(record: MemoryRecord) {
  return sha256(JSON.stringify({
    source: normalizedClaimText(record.source),
    evidenceRefs: [...new Set(record.evidenceRefs || [])].sort(compareIds),
  }));
}

export function compareMemoryCanonicalOrder(
  left: MemoryRecord,
  right: MemoryRecord,
) {
  const pinned = Number(Boolean(right.pinnedAt)) - Number(Boolean(left.pinnedAt));
  if (pinned) return pinned;
  const confidence = (right.confidence ?? 0.7) - (left.confidence ?? 0.7);
  if (confidence) return confidence;
  const usage = (right.useCount || 0) - (left.useCount || 0);
  if (usage) return usage;
  const created = left.createdAt.localeCompare(right.createdAt);
  return created || compareIds(left.id, right.id);
}

export function memoryRetrievalPriorityMultiplier(
  record: MemoryRecord,
  now: string | number | Date = Date.now(),
) {
  if (record.archivedAt) return 0;
  if (record.pinnedAt) return memoryLifecyclePolicyV1.decay.pinnedMultiplier;
  const nowMs = now instanceof Date
    ? now.getTime()
    : typeof now === "number"
      ? now
      : Date.parse(now);
  const referenceMs = Date.parse(
    record.lastUsedAt || record.updatedAt || record.createdAt,
  );
  if (!Number.isFinite(nowMs) || !Number.isFinite(referenceMs)) return 1;
  const ageDays = Math.max(0, nowMs - referenceMs) / 86_400_000;
  const tier = resolveMemoryTier(record.tier, record.type);
  const halfLifeDays = memoryLifecyclePolicyV1.decay.halfLifeDaysByTier[tier];
  const timeMultiplier = 0.5 ** (ageDays / halfLifeDays);
  const usageMultiplier = Math.min(
    1.15,
    1 + Math.log2(Math.max(0, record.useCount || 0) + 1) * 0.03,
  );
  return Math.max(
    memoryLifecyclePolicyV1.decay.minimumMultiplier,
    Math.min(1.15, timeMultiplier * usageMultiplier),
  );
}

export function memoryLifecycleReasons(record: MemoryRecord) {
  if (record.archivedAt) {
    return [record.archiveReason === "exact_duplicate"
      ? "exact duplicate archived"
      : "archived outside recall"];
  }
  if (record.pinnedAt) return ["pinned memory priority"];
  const multiplier = memoryRetrievalPriorityMultiplier(record);
  return multiplier < 0.75 ? ["retrieval priority decayed"] : [];
}

function normalizedClaimText(value: string) {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function compareIds(left: string, right: string) {
  return Buffer.from(left).compare(Buffer.from(right));
}
