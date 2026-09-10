import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class KnowledgeCognitionConflictError extends Error {}
  class KnowledgeCognitionNotFoundError extends Error {}
  return {
    KnowledgeCognitionConflictError,
    KnowledgeCognitionNotFoundError,
    authorize: vi.fn(),
    getCognition: vi.fn(),
    listCognitions: vi.fn(),
    reviewCognition: vi.fn(),
    markProjected: vi.fn(),
    getSource: vi.fn(),
    listDocuments: vi.fn(),
    enqueue: vi.fn(),
    saveMemory: vi.fn(),
    indexGraph: vi.fn(),
    projectEntities: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  hasDatabaseUrl: () => false,
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

vi.mock("@/lib/knowledge/cognification-store", () => ({
  KnowledgeCognitionConflictError: mocks.KnowledgeCognitionConflictError,
  KnowledgeCognitionNotFoundError: mocks.KnowledgeCognitionNotFoundError,
  getKnowledgeCognition: mocks.getCognition,
  listKnowledgeCognitions: mocks.listCognitions,
  reviewKnowledgeCognition: mocks.reviewCognition,
  markKnowledgeCognitionProjected: mocks.markProjected,
}));

vi.mock("@/lib/rag/store", () => ({
  getActorOwnedKnowledgeForCognition: mocks.getSource,
  listActorOwnedKnowledgeDocumentsForCognition: mocks.listDocuments,
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  enqueueKnowledgeCognificationPlan: mocks.enqueue,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: (job: unknown) => job,
}));

vi.mock("@/lib/memory/store", () => ({
  saveMemory: mocks.saveMemory,
  saveMemoryWithCommitStatusInTransaction: vi.fn(),
}));

vi.mock("@/lib/memory/graph", () => ({
  indexUserPrivateMemoryGraphRecords: mocks.indexGraph,
}));

vi.mock("@/lib/entities/extraction", () => ({
  projectExplicitMemoryEntities: mocks.projectEntities,
}));

import { GET, PATCH, POST } from "@/app/api/knowledge/cognification/route";
import {
  buildCognificationCandidateBatchV1,
  deriveCognificationBatchId,
  deriveCognificationCandidateId,
} from "@/lib/knowledge/cognification-contract";
import { ASAEL_ONTOLOGY_VERSION_ID } from "@/lib/entities/ontology";
import { contentSha256Hex } from "@/lib/sources/text-lineage";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const context = {
  tenantId: "tenant-cognition-api",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-cognition",
    tenantName: "Tenant cognition",
  },
};

const quote = "Liquidity rests above old highs.";
const retentionExpiresAt = "2026-10-10T00:00:00.000Z";
const batchInputSha256 = sourceContractSha256({ source: "batch" });
const batchId = deriveCognificationBatchId({
  documentId: "knowledge-document",
  sourceItemId: "source-item",
  sourceRevisionId: "source-revision",
  retentionExpiresAt,
  batchIndex: 0,
  batchInputSha256,
});
const evidence = [{
  evidenceUnitId: "evidence-unit",
  chunkId: "knowledge-chunk",
  chunkIndex: 0,
  quote,
  quoteSha256: contentSha256Hex(quote),
  coordinateSpace: "evidence_content" as const,
  offsetUnit: "utf16_code_unit" as const,
  startOffset: 0,
  endOffsetExclusive: quote.length,
}];
const claimBody = {
  statement: quote,
  epistemicKind: "fact" as const,
  confidenceBasisPoints: 8_800,
  evidence,
};
const summaryBody = {
  text: quote,
  confidenceBasisPoints: 8_800,
  evidence,
};
const candidate = buildCognificationCandidateBatchV1({
  batchId,
  tenantId: context.tenantId,
  ownerActorId: context.actorId,
  documentId: "knowledge-document",
  sourceItemId: "source-item",
  sourceRevisionId: "source-revision",
  retentionExpiresAt,
  batchIndex: 0,
  batchCount: 1,
  firstChunkIndex: 0,
  lastChunkIndex: 0,
  chunkCount: 1,
  inputCharacterCount: quote.length,
  batchInputSha256,
  evidenceUnitIds: ["evidence-unit"],
  ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
  topics: [],
  claims: [{
    candidateId: deriveCognificationCandidateId("claim", claimBody),
    ...claimBody,
  }],
  entities: [],
  relations: [],
  summary: {
    candidateId: deriveCognificationCandidateId("summary", summaryBody),
    ...summaryBody,
  },
  modelAttribution: {
    provider: "openai",
    model: "configured-model",
    routingSource: "tenant_assignment",
    assignmentScope: "memory",
    assignmentId: "assignment-memory",
    assignmentRevision: 3,
    assignmentConfigurationSha256: sourceContractSha256({ revision: 3 }),
    credentialSource: "tenant_vault",
    usageReceiptRecorded: true,
    usageReceiptId: "usage-receipt",
  },
});
const pending = {
  candidate,
  status: "pending_review" as const,
  reviewedByActorId: null,
  reviewDecision: null,
  reviewMetadata: {},
  reviewedAt: null,
  projectedMemoryId: null,
  projectedAt: null,
  createdAt: "2026-09-10T12:00:00.000Z",
  updatedAt: "2026-09-10T12:00:00.000Z",
};
const source = {
  document: {
    id: "knowledge-document",
    tenantId: context.tenantId,
    sourceItemId: "source-item",
    sourceRevisionId: "source-revision",
    title: "ICT liquidity lesson",
    source: "capture:asset:lesson",
    sourceType: "file" as const,
    tags: [],
    contentHash: "hash",
    chunkCount: 1,
    totalCharacters: quote.length,
    metadata: {},
    createdAt: pending.createdAt,
    updatedAt: pending.updatedAt,
  },
  chunks: [],
  sourceItemId: "source-item",
  sourceRevisionId: "source-revision",
  retentionExpiresAt,
};

describe("knowledge cognition API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(context);
    mocks.listCognitions.mockResolvedValueOnce([pending]).mockResolvedValueOnce([]);
    mocks.getCognition.mockResolvedValue(pending);
    mocks.getSource.mockResolvedValue(source);
    mocks.listDocuments.mockResolvedValue([source.document]);
    mocks.enqueue.mockResolvedValue({
      id: "cognition-job",
      type: "knowledge.cognify",
      status: "queued",
    });
    mocks.reviewCognition.mockImplementation(async (input) => ({
      ...pending,
      status: input.decision === "confirm" ? "confirmed" : "dismissed",
      reviewDecision: input.decision,
      reviewedByActorId: context.actorId,
      reviewMetadata: input.reviewMetadata,
      reviewedAt: "2026-09-10T12:01:00.000Z",
      updatedAt: "2026-09-10T12:01:00.000Z",
    }));
    mocks.saveMemory.mockImplementation(async (input) => ({
      ...input,
      createdAt: pending.createdAt,
      updatedAt: pending.updatedAt,
    }));
    mocks.markProjected.mockImplementation(async (input) => ({
      ...pending,
      status: "confirmed",
      reviewDecision: "confirm",
      reviewedByActorId: context.actorId,
      reviewMetadata: {
        reviewSurface: "memory_intelligence",
        canonicalOwnerActorId: "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      },
      reviewedAt: "2026-09-10T12:01:00.000Z",
      projectedMemoryId: input.projectedMemoryId,
      projectedAt: "2026-09-10T12:02:00.000Z",
      updatedAt: "2026-09-10T12:02:00.000Z",
    }));
  });

  it("returns only the owner's review records without actor identifiers", async () => {
    const response = await GET(new Request(
      "http://localhost/api/knowledge/cognification",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.reviews).toHaveLength(1);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(context.tenantId);
    expect(serialized).not.toContain(context.actorId);
    expect(serialized).not.toContain(context.auth.userId);
    expect(serialized).not.toContain("source-revision");
    expect(serialized).not.toContain("usage-receipt");
    expect(body.reviews[0]).not.toHaveProperty("reviewedByActorId");
    expect(body.reviews[0]).not.toHaveProperty("reviewMetadata");
    expect(mocks.listCognitions).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      actorId: context.actorId,
    }));
  });

  it("queues only actor-owned current source revisions", async () => {
    const response = await POST(new Request(
      "http://localhost/api/knowledge/cognification",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      },
    ));

    expect(response.status).toBe(202);
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      actorId: context.actorId,
      documentId: "knowledge-document",
      sourceRevisionId: "source-revision",
    }));
  });

  it("promotes a confirmed proposal as canonical private memory with evidence", async () => {
    const response = await PATCH(new Request(
      "http://localhost/api/knowledge/cognification",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: batchId, decision: "confirm" }),
      },
    ));

    expect(response.status).toBe(200);
    const body = await response.clone().json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(context.tenantId);
    expect(serialized).not.toContain(context.actorId);
    expect(serialized).not.toContain(context.auth.userId);
    expect(serialized).not.toContain("accessBinding");
    expect(mocks.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      formationReason: "source_cognition",
      formationOrigin: "reviewed_source_cognition",
      claimStatus: "active",
      assertedBy: "user",
      retentionExpiresAt,
      source: `cognify-reviewed:${batchId}`,
      evidenceRefs: expect.arrayContaining([
        "knowledge:knowledge-document",
        "evidence:evidence-unit",
        `cognition-review:${batchId}`,
      ]),
      accessBinding: expect.objectContaining({
        ownerActorId: "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        visibility: "user_private",
      }),
    }));
    expect(mocks.indexGraph).toHaveBeenCalled();
    expect(mocks.projectEntities).toHaveBeenCalled();
    expect(mocks.markProjected).toHaveBeenCalledWith(expect.objectContaining({
      actorId: context.actorId,
      projectedMemoryId: `memory:${batchId}`,
    }));
  });

  it("requires a fresh proposal after the source retention policy changes", async () => {
    mocks.getSource.mockResolvedValueOnce({
      ...source,
      retentionExpiresAt: "2026-09-20T00:00:00.000Z",
    });

    const response = await PATCH(new Request(
      "http://localhost/api/knowledge/cognification",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: batchId, decision: "confirm" }),
      },
    ));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The source policy changed after this proposal was created. Cognify the current source instead.",
    });
    expect(mocks.reviewCognition).not.toHaveBeenCalled();
    expect(mocks.saveMemory).not.toHaveBeenCalled();
  });

  it("dismisses without creating memory or graph state", async () => {
    const response = await PATCH(new Request(
      "http://localhost/api/knowledge/cognification",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: batchId, decision: "dismiss" }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.saveMemory).not.toHaveBeenCalled();
    expect(mocks.indexGraph).not.toHaveBeenCalled();
    expect(mocks.projectEntities).not.toHaveBeenCalled();
  });
});
