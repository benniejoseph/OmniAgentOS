import { z } from "zod";
import type { MemoryDeletionReceiptV1 } from "@/lib/memory/deletion-receipt";
import type { MemoryReconciliationReview } from "@/lib/memory/reconciliation";
import {
  memoryFormationReasonLabel,
  resolveMemoryTier,
} from "@/lib/memory/tier-policy";
import type { MemoryRecord } from "@/lib/memory/types";
import type { RetrievalTraceRecord } from "@/lib/rag/types";

export const READABLE_MEMORY_OVERVIEW_VERSION =
  "p11.6-readable-memory:1" as const;

const timestampSchema = z.string().datetime({ offset: true });
const countSchema = z.number().int().min(0);

const readableMemoryClaimSchema = z.object({
  id: z.string().min(1).max(240),
  title: z.string().min(1).max(240),
  type: z.enum([
    "preference",
    "fact",
    "episode",
    "procedure",
    "knowledge",
    "decision",
    "task",
  ]),
  tier: z.enum([
    "working",
    "episodic",
    "semantic",
    "procedural",
    "preference",
    "decision",
    "commitment",
    "summary",
  ]),
  state: z.enum([
    "active",
    "candidate",
    "superseded",
    "contradicted",
    "archived",
  ]),
  confidence: z.number().min(0).max(1),
  assertedBy: z.enum(["user", "agent", "system", "import", "unknown"]),
  provenance: z.string().min(1).max(240),
  sourceKind: z.enum([
    "direct",
    "conversation",
    "canonical_source",
    "governed_action",
    "import",
    "legacy",
  ]),
  scope: z.object({
    visibility: z.string().min(1).max(80),
    boundary: z.enum(["personal", "project", "workspace"]),
    sensitivity: z.string().min(1).max(80),
  }).strict(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  validFrom: timestampSchema.nullable(),
  validTo: timestampSchema.nullable(),
  lastUsedAt: timestampSchema.nullable(),
  useCount: countSchema,
  recentUseCount: countSchema,
  hasConflict: z.boolean(),
  detailDisclosure: z.literal("explicit_selection"),
}).strict();

const timelineItemSchema = z.object({
  id: z.string().min(1).max(500),
  kind: z.enum([
    "claim_created",
    "claim_revised",
    "claim_used",
    "conflict_opened",
    "conflict_resolved",
    "deletion_barrier_recorded",
  ]),
  occurredAt: timestampSchema,
  label: z.string().min(1).max(160),
  memoryId: z.string().min(1).max(240).nullable(),
  count: countSchema,
  contentDisclosure: z.literal("withheld"),
}).strict();

export const readableMemoryOverviewSchema = z.object({
  version: z.literal(READABLE_MEMORY_OVERVIEW_VERSION),
  generatedAt: timestampSchema,
  state: z.enum(["ready", "empty"]),
  disclosure: z.object({
    aggregate: z.literal("metadata_only"),
    claimContent: z.literal("explicit_selection"),
    entityLabels: z.literal("explicit_reveal"),
    relationshipPaths: z.literal("explicit_query"),
    visualAggregation: z.literal("content_excluded"),
  }).strict(),
  summary: z.object({
    claims: countSchema,
    active: countSchema,
    needsReview: countSchema,
    archived: countSchema,
    people: countSchema,
    projects: countSchema,
    scopes: countSchema,
    recentUses: countSchema,
    deletionBarriers: countSchema,
  }).strict(),
  claims: z.array(readableMemoryClaimSchema).max(200),
  timeline: z.array(timelineItemSchema).max(80),
  scopes: z.array(z.object({
    boundary: z.enum(["personal", "project", "workspace"]),
    count: countSchema,
  }).strict()).max(3),
  entities: z.object({
    state: z.enum(["available", "unavailable"]),
    people: countSchema,
    projects: countSchema,
    labelsIncluded: z.literal(false),
  }).strict(),
  conflicts: z.object({
    pending: countSchema,
    resolved: countSchema,
    detailsIncluded: z.literal(false),
  }).strict(),
  deletion: z.object({
    barriers: countSchema,
    latestAt: timestampSchema.nullable(),
    descendantsBlocked: countSchema,
    tracesInvalidated: countSchema,
    graphProjectionsInvalidated: countSchema,
    receiptIdentifiersIncluded: z.literal(false),
  }).strict(),
}).strict();

export type ReadableMemoryOverview = z.infer<
  typeof readableMemoryOverviewSchema
>;
export type ReadableMemoryClaim = ReadableMemoryOverview["claims"][number];

export function projectReadableMemoryOverview(input: {
  memories: readonly MemoryRecord[];
  reviews: readonly MemoryReconciliationReview[];
  traces: readonly RetrievalTraceRecord[];
  deletionReceipts: readonly MemoryDeletionReceiptV1[];
  entityCounts?: Readonly<{ people: number; projects: number }>;
  generatedAt?: string;
  limit?: number;
}): ReadableMemoryOverview {
  const limit = Math.min(Math.max(input.limit || 100, 1), 200);
  const memories = input.memories
    .filter((memory) => (memory.claimStatus || "active") !== "forgotten")
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit);
  const visibleIds = new Set(memories.map((memory) => memory.id));
  const usesByMemoryId = new Map<string, number>();
  const useTimeline: ReadableMemoryOverview["timeline"] = [];

  for (const [traceIndex, trace] of input.traces.entries()) {
    const usedMemoryIds = [...new Set(
      trace.results
        .filter((result) => result.kind === "memory" && visibleIds.has(result.id))
        .map((result) => result.id),
    )];
    if (!usedMemoryIds.length) continue;
    for (const memoryId of usedMemoryIds) {
      usesByMemoryId.set(memoryId, (usesByMemoryId.get(memoryId) || 0) + 1);
    }
    useTimeline.push({
      id: `use:${trace.createdAt}:${traceIndex}`,
      kind: "claim_used",
      occurredAt: trace.createdAt,
      label: usedMemoryIds.length === 1
        ? "A claim was used in context"
        : `${usedMemoryIds.length} claims were used in context`,
      memoryId: usedMemoryIds.length === 1 ? usedMemoryIds[0] : null,
      count: usedMemoryIds.length,
      contentDisclosure: "withheld",
    });
  }

  const pendingConflictMemoryIds = new Set(
    input.reviews
      .filter((review) => review.status === "pending")
      .flatMap((review) => [review.candidate.id, review.existing?.id])
      .filter((id): id is string => Boolean(id)),
  );
  const claims = memories.map((memory) => ({
    id: memory.id,
    title: memory.title,
    type: memory.type,
    tier: resolveMemoryTier(memory.tier, memory.type),
    state: memory.archivedAt
      ? "archived" as const
      : (memory.claimStatus || "active") as Exclude<
          NonNullable<MemoryRecord["claimStatus"]>,
          "forgotten"
        >,
    confidence: memory.confidence ?? 0.7,
    assertedBy: memory.assertedBy || "unknown" as const,
    provenance: memoryFormationReasonLabel(
      memory.formationReason || "legacy_record",
    ),
    sourceKind: readableSourceKind(memory.source),
    scope: readableScope(memory),
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    validFrom: memory.validFrom || null,
    validTo: memory.validTo || null,
    lastUsedAt: memory.lastUsedAt || null,
    useCount: memory.useCount || 0,
    recentUseCount: usesByMemoryId.get(memory.id) || 0,
    hasConflict: pendingConflictMemoryIds.has(memory.id),
    detailDisclosure: "explicit_selection" as const,
  }));

  const claimTimeline: ReadableMemoryOverview["timeline"] = memories.flatMap(
    (memory) => [{
      id: `created:${memory.id}`,
      kind: "claim_created" as const,
      occurredAt: memory.createdAt,
      label: "Claim recorded",
      memoryId: memory.id,
      count: 1,
      contentDisclosure: "withheld" as const,
    }, ...(memory.updatedAt !== memory.createdAt ? [{
      id: `revised:${memory.id}:${memory.updatedAt}`,
      kind: "claim_revised" as const,
      occurredAt: memory.updatedAt,
      label: "Claim revised",
      memoryId: memory.id,
      count: 1,
      contentDisclosure: "withheld" as const,
    }] : [])],
  );
  const conflictTimeline: ReadableMemoryOverview["timeline"] = input.reviews
    .filter((review) =>
      visibleIds.has(review.candidate.id) ||
      Boolean(review.existing && visibleIds.has(review.existing.id))
    )
    .map((review, index) => ({
      id: `conflict:${review.updatedAt}:${index}`,
      kind: review.status === "pending"
        ? "conflict_opened" as const
        : "conflict_resolved" as const,
      occurredAt: review.resolvedAt || review.updatedAt,
      label: review.status === "pending"
        ? "A claim needs review"
        : "A claim review was resolved",
      memoryId: visibleIds.has(review.candidate.id)
        ? review.candidate.id
        : review.existing?.id || null,
      count: 1,
      contentDisclosure: "withheld" as const,
    }));
  const deletionTimeline: ReadableMemoryOverview["timeline"] =
    input.deletionReceipts.map((receipt, index) => ({
      id: `deletion:${receipt.forgottenAt}:${index}`,
      kind: "deletion_barrier_recorded" as const,
      occurredAt: receipt.forgottenAt,
      label: "Permanent deletion barrier recorded",
      memoryId: null,
      count: 1 + receipt.descendantMemoryCount,
      contentDisclosure: "withheld" as const,
    }));
  const timeline = [
    ...claimTimeline,
    ...useTimeline,
    ...conflictTimeline,
    ...deletionTimeline,
  ].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
    .slice(0, 80);

  const boundaryCounts = new Map<"personal" | "project" | "workspace", number>();
  for (const claim of claims) {
    boundaryCounts.set(
      claim.scope.boundary,
      (boundaryCounts.get(claim.scope.boundary) || 0) + 1,
    );
  }
  const scopes = (["personal", "project", "workspace"] as const)
    .map((boundary) => ({ boundary, count: boundaryCounts.get(boundary) || 0 }))
    .filter((entry) => entry.count > 0);
  const pending = input.reviews.filter((review) => review.status === "pending")
    .length;
  const resolved = input.reviews.length - pending;
  const deletion = input.deletionReceipts.reduce((summary, receipt) => ({
    barriers: summary.barriers + 1,
    latestAt: !summary.latestAt || receipt.forgottenAt > summary.latestAt
      ? receipt.forgottenAt
      : summary.latestAt,
    descendantsBlocked:
      summary.descendantsBlocked + receipt.descendantMemoryCount,
    tracesInvalidated:
      summary.tracesInvalidated + receipt.retrievalTraceCount,
    graphProjectionsInvalidated:
      summary.graphProjectionsInvalidated + receipt.graphNodeCount +
      receipt.graphEdgeCount,
    receiptIdentifiersIncluded: false as const,
  }), {
    barriers: 0,
    latestAt: null as string | null,
    descendantsBlocked: 0,
    tracesInvalidated: 0,
    graphProjectionsInvalidated: 0,
    receiptIdentifiersIncluded: false as const,
  });
  const people = Math.max(0, input.entityCounts?.people || 0);
  const projects = Math.max(0, input.entityCounts?.projects || 0);
  const entityState = input.entityCounts ? "available" : "unavailable";

  return readableMemoryOverviewSchema.parse({
    version: READABLE_MEMORY_OVERVIEW_VERSION,
    generatedAt: input.generatedAt || new Date().toISOString(),
    state: claims.length ? "ready" : "empty",
    disclosure: {
      aggregate: "metadata_only",
      claimContent: "explicit_selection",
      entityLabels: "explicit_reveal",
      relationshipPaths: "explicit_query",
      visualAggregation: "content_excluded",
    },
    summary: {
      claims: claims.length,
      active: claims.filter((claim) => claim.state === "active").length,
      needsReview: pending,
      archived: claims.filter((claim) => claim.state === "archived").length,
      people,
      projects,
      scopes: scopes.length,
      recentUses: useTimeline.length,
      deletionBarriers: deletion.barriers,
    },
    claims,
    timeline,
    scopes,
    entities: {
      state: entityState,
      people,
      projects,
      labelsIncluded: false,
    },
    conflicts: { pending, resolved, detailsIncluded: false },
    deletion,
  });
}

function readableSourceKind(
  source: string,
): ReadableMemoryClaim["sourceKind"] {
  const normalized = source.toLowerCase();
  if (normalized.includes("manual") || normalized.includes("direct")) {
    return "direct";
  }
  if (normalized.includes("conversation") || normalized.includes("thread")) {
    return "conversation";
  }
  if (normalized.includes("workflow") || normalized.includes("tool")) {
    return "governed_action";
  }
  if (
    normalized.includes("source") ||
    normalized.includes("capture") ||
    normalized.includes("knowledge")
  ) return "canonical_source";
  if (normalized.includes("import")) return "import";
  return "legacy";
}

function readableScope(memory: MemoryRecord): ReadableMemoryClaim["scope"] {
  const binding = memory.accessBinding;
  if (!binding) {
    return {
      visibility: `${memory.scope} legacy`,
      boundary: memory.scope === "user" ? "personal" : memory.scope,
      sensitivity: "legacy unspecified",
    };
  }
  return {
    visibility: binding.visibility.replaceAll("_", " "),
    boundary: memory.scope === "user" ? "personal" : memory.scope,
    sensitivity: binding.sensitivity.replaceAll("_", " "),
  };
}
