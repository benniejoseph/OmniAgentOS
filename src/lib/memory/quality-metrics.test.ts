import { describe, expect, it } from "vitest";

import {
  buildCognificationCandidateBatchV1,
  deriveCognificationBatchId,
  deriveCognificationCandidateId,
  type CognificationCandidateBatchV1,
  type CognificationEvidenceBindingV1,
} from "@/lib/knowledge/cognification-contract";
import type {
  KnowledgeCognitionRecord,
  KnowledgeCognitionStatus,
} from "@/lib/knowledge/cognification-store";
import {
  buildMemoryCognitionQualityMetrics,
  MEMORY_COGNITION_QUALITY_METRICS_VERSION,
} from "@/lib/memory/quality-metrics";
import type { MemoryCatalogRecord } from "@/lib/memory/store";
import type { MemoryGraphBuildRecord } from "@/lib/memory/types";
import { contentSha256Hex } from "@/lib/sources/text-lineage";

const tenantId = "tenant-quality";
const actorId = "actor-quality";
const generatedAt = "2026-09-11T12:00:00.000Z";

describe("memory cognition quality metrics", () => {
  it("keeps absent samples explicit instead of inferring healthy rates", () => {
    const metrics = buildMemoryCognitionQualityMetrics({
      cognition: { tenantId, actorId, records: [] },
      durableMemories: [],
      knowledgeCounts: { documents: 0, chunks: 0 },
      latestGraphBuild: null,
      generatedAt,
    });

    expect(metrics).toEqual({
      version: MEMORY_COGNITION_QUALITY_METRICS_VERSION,
      generatedAt,
      scope: { tenantId, actorId },
      evidenceSupportedExtraction: {
        knowledgeDocumentCount: 0,
        knowledgeChunkCount: 0,
        cognitionBatchSampleCount: 0,
        candidateItemSampleCount: 0,
        exactEvidenceBatchCount: 0,
        exactEvidenceCandidateItemCount: 0,
        exactEvidenceBatchRate: null,
        exactEvidenceCandidateItemRate: null,
      },
      reviewAcceptance: {
        cognitionBatchSampleCount: 0,
        reviewedBatchSampleCount: 0,
        pendingCount: 0,
        confirmedCount: 0,
        unprojectedConfirmedCount: 0,
        projectedCount: 0,
        dismissedCount: 0,
        acceptanceRate: null,
      },
      retrievalUsefulness: {
        interpretation: "observed_retrieval_use_only_not_causal",
        durableMemorySampleCount: 0,
        eligibleActiveDurableMemoryCount: 0,
        usedActiveDurableMemoryCount: 0,
        observedUseCount: 0,
        usedActiveDurableMemoryRate: null,
      },
      graphLag: {
        buildSampleCount: 0,
        latestBuildAt: null,
        lagMs: null,
        status: "unbuilt",
      },
    });
    expect(Object.isFrozen(metrics)).toBe(true);
    expect(Object.isFrozen(metrics.evidenceSupportedExtraction)).toBe(true);
    expect(Object.isFrozen(metrics.reviewAcceptance)).toBe(true);
    expect(Object.isFrozen(metrics.retrievalUsefulness)).toBe(true);
    expect(Object.isFrozen(metrics.graphLag)).toBe(true);
    expect(JSON.parse(JSON.stringify(metrics))).toEqual(metrics);
  });

  it("projects exact-evidence, review, observed-use, and graph-lag samples", () => {
    const records = [
      cognitionRecord(0, "pending_review"),
      cognitionRecord(1, "confirmed"),
      cognitionRecord(2, "confirmed", true),
      cognitionRecord(3, "dismissed"),
    ];
    records[0] = withInvalidTopicEvidence(records[0]);
    const memories = [
      memory({ id: "used", useCount: 3 }),
      memory({ id: "unused", useCount: 0 }),
      memory({ id: "archived", useCount: 11, archivedAt: generatedAt }),
      memory({ id: "superseded", useCount: 9, claimStatus: "superseded" }),
      memory({
        id: "future",
        useCount: 7,
        validFrom: "2026-09-11T12:00:00.001Z",
      }),
      memory({ id: "ended", useCount: 5, validTo: generatedAt }),
      memory({ id: "expired", useCount: 4, retentionExpiresAt: generatedAt }),
    ];

    const metrics = buildMemoryCognitionQualityMetrics({
      cognition: { tenantId, actorId, records },
      durableMemories: memories,
      knowledgeCounts: { documents: 9, chunks: 27 },
      latestGraphBuild: graphBuild({
        createdAt: "2026-09-11T11:00:00.000Z",
      }),
      generatedAt,
    });

    expect(metrics.evidenceSupportedExtraction).toEqual({
      knowledgeDocumentCount: 9,
      knowledgeChunkCount: 27,
      cognitionBatchSampleCount: 4,
      candidateItemSampleCount: 8,
      exactEvidenceBatchCount: 3,
      exactEvidenceCandidateItemCount: 7,
      exactEvidenceBatchRate: 0.75,
      exactEvidenceCandidateItemRate: 0.875,
    });
    expect(metrics.reviewAcceptance).toEqual({
      cognitionBatchSampleCount: 4,
      reviewedBatchSampleCount: 3,
      pendingCount: 1,
      confirmedCount: 2,
      unprojectedConfirmedCount: 1,
      projectedCount: 1,
      dismissedCount: 1,
      acceptanceRate: 2 / 3,
    });
    expect(metrics.retrievalUsefulness).toEqual({
      interpretation: "observed_retrieval_use_only_not_causal",
      durableMemorySampleCount: 7,
      eligibleActiveDurableMemoryCount: 2,
      usedActiveDurableMemoryCount: 1,
      observedUseCount: 3,
      usedActiveDurableMemoryRate: 0.5,
    });
    expect(metrics.graphLag).toEqual({
      buildSampleCount: 1,
      latestBuildAt: "2026-09-11T11:00:00.000Z",
      lagMs: 3_600_000,
      status: "current",
    });
  });

  it("distinguishes stale and failed graph observations", () => {
    const common = {
      cognition: { tenantId, actorId, records: [] },
      durableMemories: [],
      knowledgeCounts: { documents: 0, chunks: 0 },
      generatedAt,
    } as const;

    expect(buildMemoryCognitionQualityMetrics({
      ...common,
      latestGraphBuild: graphBuild({ createdAt: "2026-09-10T11:59:59.999Z" }),
    }).graphLag).toMatchObject({
      lagMs: 86_400_001,
      status: "stale",
    });
    expect(buildMemoryCognitionQualityMetrics({
      ...common,
      latestGraphBuild: graphBuild({ status: "failed" }),
    }).graphLag.status).toBe("failed");
    expect(buildMemoryCognitionQualityMetrics({
      ...common,
      latestGraphBuild: graphBuild({ createdAt: "2026-09-11T12:01:00.000Z" }),
    }).graphLag).toMatchObject({ lagMs: 0, status: "current" });
  });

  it("rejects mixed actor or tenant samples", () => {
    const foreignCognition = cognitionRecord(0, "pending_review");
    const foreignCandidate = {
      ...foreignCognition.candidate,
      ownerActorId: "another-actor",
    } as CognificationCandidateBatchV1;

    expect(() => buildMemoryCognitionQualityMetrics({
      cognition: {
        tenantId,
        actorId,
        records: [{ ...foreignCognition, candidate: foreignCandidate }],
      },
      durableMemories: [],
      knowledgeCounts: { documents: 1, chunks: 1 },
      latestGraphBuild: null,
      generatedAt,
    })).toThrow("cross the requested actor scope");

    expect(() => buildMemoryCognitionQualityMetrics({
      cognition: { tenantId, actorId, records: [] },
      durableMemories: [memory({ id: "foreign", tenantId: "another-tenant" })],
      knowledgeCounts: { documents: 1, chunks: 1 },
      latestGraphBuild: null,
      generatedAt,
    })).toThrow("cross the requested tenant scope");

    expect(() => buildMemoryCognitionQualityMetrics({
      cognition: { tenantId, actorId, records: [] },
      durableMemories: [],
      knowledgeCounts: { documents: 1, chunks: 1 },
      latestGraphBuild: graphBuild({ tenantId: "another-tenant" }),
      generatedAt,
    })).toThrow("graph build crosses the requested tenant scope");
  });
});

function cognitionRecord(
  batchIndex: number,
  status: KnowledgeCognitionStatus,
  projected = false,
): KnowledgeCognitionRecord {
  const candidate = cognitionCandidate(batchIndex);
  const reviewed = status !== "pending_review";
  const confirmed = status === "confirmed";
  return {
    candidate,
    status,
    reviewedByActorId: reviewed ? actorId : null,
    reviewDecision: reviewed ? confirmed ? "confirm" : "dismiss" : null,
    reviewMetadata: {},
    reviewedAt: reviewed ? "2026-09-11T10:00:00.000Z" : null,
    projectedMemoryId: projected ? `memory-projected-${batchIndex}` : null,
    projectedAt: projected ? "2026-09-11T10:30:00.000Z" : null,
    createdAt: "2026-09-11T09:00:00.000Z",
    updatedAt: projected
      ? "2026-09-11T10:30:00.000Z"
      : reviewed
        ? "2026-09-11T10:00:00.000Z"
        : "2026-09-11T09:00:00.000Z",
  };
}

function cognitionCandidate(batchIndex: number) {
  const quote = `Grounded evidence ${batchIndex}`;
  const evidence: CognificationEvidenceBindingV1 = {
    evidenceUnitId: `evidence-quality-${batchIndex}`,
    chunkId: `chunk-quality-${batchIndex}`,
    chunkIndex: batchIndex,
    quote,
    quoteSha256: contentSha256Hex(quote),
    coordinateSpace: "evidence_content",
    offsetUnit: "utf16_code_unit",
    startOffset: 0,
    endOffsetExclusive: quote.length,
  };
  const topicBody = {
    label: `Topic ${batchIndex}`,
    description: `Grounded topic ${batchIndex}`,
    confidenceBasisPoints: 9_000,
    evidence: [evidence],
  };
  const summaryBody = {
    text: `Grounded summary ${batchIndex}`,
    confidenceBasisPoints: 9_500,
    evidence: [evidence],
  };
  const documentId = `document-quality-${batchIndex}`;
  const sourceItemId = `source-item-quality-${batchIndex}`;
  const sourceRevisionId = `source-revision-quality-${batchIndex}`;
  const batchInputSha256 = contentSha256Hex(quote);
  const batchId = deriveCognificationBatchId({
    documentId,
    sourceItemId,
    sourceRevisionId,
    retentionExpiresAt: null,
    batchIndex,
    batchInputSha256,
  });
  return buildCognificationCandidateBatchV1({
    batchId,
    tenantId,
    ownerActorId: actorId,
    documentId,
    sourceItemId,
    sourceRevisionId,
    retentionExpiresAt: null,
    batchIndex,
    batchCount: 4,
    firstChunkIndex: batchIndex,
    lastChunkIndex: batchIndex,
    chunkCount: 1,
    inputCharacterCount: quote.length,
    batchInputSha256,
    evidenceUnitIds: [evidence.evidenceUnitId],
    ontologyVersionId: "asael-ontology:1",
    topics: [{
      candidateId: deriveCognificationCandidateId("topic", topicBody),
      ...topicBody,
    }],
    claims: [],
    entities: [],
    relations: [],
    summary: {
      candidateId: deriveCognificationCandidateId("summary", summaryBody),
      ...summaryBody,
    },
    modelAttribution: {
      provider: "openai",
      model: "configured-memory-model",
      routingSource: "tenant_assignment",
      assignmentScope: "memory",
      assignmentId: "assignment-memory-quality",
      assignmentRevision: 1,
      assignmentConfigurationSha256: "a".repeat(64),
      credentialSource: "tenant_vault",
      usageReceiptRecorded: true,
      usageReceiptId: `usage-memory-quality-${batchIndex}`,
    },
  });
}

function withInvalidTopicEvidence(
  record: KnowledgeCognitionRecord,
): KnowledgeCognitionRecord {
  const topic = record.candidate.topics[0];
  const binding = topic.evidence[0];
  return {
    ...record,
    candidate: {
      ...record.candidate,
      topics: [{
        ...topic,
        evidence: [{ ...binding, quoteSha256: "0".repeat(64) }],
      }],
    } as unknown as CognificationCandidateBatchV1,
  };
}

function memory(
  input: Partial<MemoryCatalogRecord> & Pick<MemoryCatalogRecord, "id">,
): MemoryCatalogRecord {
  const { id, ...overrides } = input;
  return {
    id,
    tenantId,
    type: "fact",
    tier: "semantic",
    tierPolicyVersion: 1,
    formationReason: "manual_user_entry",
    title: id,
    tags: [],
    scope: "user",
    source: "manual",
    importance: 0.8,
    confidence: 0.9,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefCount: 1,
    byteCount: 24,
    useCount: 0,
    createdAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    ...overrides,
  };
}

function graphBuild(
  overrides: Partial<MemoryGraphBuildRecord> = {},
): MemoryGraphBuildRecord {
  return {
    id: "graph-build-quality",
    tenantId,
    status: "completed",
    source: "memory-quality-test",
    memoryCount: 2,
    traceCount: 0,
    nodeCount: 3,
    edgeCount: 2,
    latencyMs: 120,
    createdAt: "2026-09-11T11:00:00.000Z",
    ...overrides,
  };
}
