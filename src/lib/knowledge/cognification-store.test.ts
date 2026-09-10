import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async (
    _input: Record<string, unknown>,
    _options?: Record<string, unknown>,
  ) => ({ id: "event" })),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: () => false,
  runWithDatabaseActorScope: vi.fn(
    async (_tenantId: string, _actorIds: string[], operation: () => unknown) =>
      operation(),
  ),
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildCognificationCandidateBatchV1,
  deriveCognificationBatchId,
  deriveCognificationCandidateId,
  type CognificationCandidateBatchV1,
  type CognificationEvidenceBindingV1,
} from "@/lib/knowledge/cognification-contract";
import {
  KNOWLEDGE_COGNITION_EVENT_TYPES,
  KnowledgeCognitionConflictError,
  getKnowledgeCognition,
  listKnowledgeCognitions,
  markKnowledgeCognitionProjected,
  reviewKnowledgeCognition,
  saveKnowledgeCognition,
} from "@/lib/knowledge/cognification-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { contentSha256Hex } from "@/lib/sources/text-lineage";

const tenantId = "tenant-cognition-store";
const actorId = "actor-cognition-store";
let dataDir = "";

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T09:00:00.000Z"));
  dataDir = await mkdtemp(path.join(tmpdir(), "asael-cognition-store-"));
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  mocks.appendScopedDomainEvent.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.OMNIAGENT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("knowledge cognition candidate store", () => {
  it("persists an immutable candidate idempotently in the exact owner scope", async () => {
    const candidate = cognitionCandidate();
    const first = await saveKnowledgeCognition(candidate, {
      executionScope: ownerScope(),
    });
    const second = await saveKnowledgeCognition(candidate, {
      executionScope: ownerScope(),
    });

    expect(second).toEqual(first);
    expect(await getKnowledgeCognition(candidate.batchId, {
      tenantId,
      actorId,
    })).toEqual(first);
    expect(await getKnowledgeCognition(candidate.batchId, {
      tenantId,
      actorId: "actor-someone-else",
    })).toBeUndefined();
    expect(await listKnowledgeCognitions({
      tenantId,
      actorId,
      status: "pending_review",
    })).toEqual([first]);
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledTimes(1);
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: KNOWLEDGE_COGNITION_EVENT_TYPES.proposed,
        payload: expect.objectContaining({
          cognitionId: candidate.batchId,
          contractSha256: candidate.contractSha256,
          candidateCount: 1,
          status: "pending_review",
        }),
      }),
      {},
    );
  });

  it("rejects a different valid contract for an existing deterministic batch", async () => {
    await saveKnowledgeCognition(cognitionCandidate());
    await expect(saveKnowledgeCognition(cognitionCandidate({
      model: "another-configured-memory-model",
    }))).rejects.toBeInstanceOf(KnowledgeCognitionConflictError);
  });

  it("allows only the owner to confirm or dismiss a pending candidate", async () => {
    const candidate = cognitionCandidate();
    await saveKnowledgeCognition(candidate);
    const confirmed = await reviewKnowledgeCognition({
      id: candidate.batchId,
      tenantId,
      actorId,
      decision: "confirm",
      reviewedBy: actorId,
      reviewMetadata: { reviewSource: "human", candidateCount: 1 },
      executionScope: ownerScope(),
    });
    expect(confirmed).toMatchObject({
      status: "confirmed",
      reviewDecision: "confirm",
      reviewedByActorId: actorId,
      reviewedAt: "2026-09-10T09:00:00.000Z",
    });
    await expect(reviewKnowledgeCognition({
      id: candidate.batchId,
      tenantId,
      actorId,
      decision: "dismiss",
      reviewedBy: actorId,
      executionScope: ownerScope(),
    })).rejects.toBeInstanceOf(KnowledgeCognitionConflictError);
    await expect(reviewKnowledgeCognition({
      id: candidate.batchId,
      tenantId,
      actorId,
      decision: "confirm",
      reviewedBy: "actor-someone-else",
      executionScope: ownerScope(),
    })).rejects.toThrow("exact owner");

    const event = mocks.appendScopedDomainEvent.mock.calls.at(-1)?.[0];
    expect(event).toMatchObject({
      type: KNOWLEDGE_COGNITION_EVENT_TYPES.reviewed,
      payload: {
        schemaVersion: 1,
        cognitionId: candidate.batchId,
        contractSha256: candidate.contractSha256,
        decision: "confirm",
        status: "confirmed",
        reviewedAt: "2026-09-10T09:00:00.000Z",
      },
    });
    expect(JSON.stringify(event)).not.toContain("Grounded cognition summary");
  });

  it("binds only confirmed candidates to one projected memory", async () => {
    const candidate = cognitionCandidate();
    await saveKnowledgeCognition(candidate);
    await expect(markKnowledgeCognitionProjected({
      id: candidate.batchId,
      tenantId,
      actorId,
      projectedMemoryId: "memory-cognition-one",
      executionScope: ownerScope(),
    })).rejects.toThrow("Only a confirmed cognition");

    await reviewKnowledgeCognition({
      id: candidate.batchId,
      tenantId,
      actorId,
      decision: "confirm",
      reviewedBy: actorId,
      executionScope: ownerScope(),
    });
    vi.setSystemTime(new Date("2026-09-10T09:01:00.000Z"));
    const projected = await markKnowledgeCognitionProjected({
      id: candidate.batchId,
      tenantId,
      actorId,
      projectedMemoryId: "memory-cognition-one",
      executionScope: ownerScope(),
    });
    expect(projected).toMatchObject({
      status: "confirmed",
      projectedMemoryId: "memory-cognition-one",
      projectedAt: "2026-09-10T09:01:00.000Z",
    });
    expect(await markKnowledgeCognitionProjected({
      id: candidate.batchId,
      tenantId,
      actorId,
      projectedMemoryId: "memory-cognition-one",
      executionScope: ownerScope(),
    })).toEqual(projected);
    await expect(markKnowledgeCognitionProjected({
      id: candidate.batchId,
      tenantId,
      actorId,
      projectedMemoryId: "memory-cognition-two",
      executionScope: ownerScope(),
    })).rejects.toBeInstanceOf(KnowledgeCognitionConflictError);
    expect(mocks.appendScopedDomainEvent.mock.calls.at(-1)?.[0]).toMatchObject({
      type: KNOWLEDGE_COGNITION_EVENT_TYPES.projected,
      payload: expect.objectContaining({
        projectedMemoryId: "memory-cognition-one",
      }),
    });
  });

  it("fails closed when the execution scope does not belong to the owner", async () => {
    const candidate = cognitionCandidate();
    await saveKnowledgeCognition(candidate);
    await expect(reviewKnowledgeCognition({
      id: candidate.batchId,
      tenantId,
      actorId,
      decision: "confirm",
      reviewedBy: actorId,
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: "actor-someone-else",
        executingPrincipalType: "user",
        executingPrincipalId: "actor-someone-else",
        correlationId: "wrong-owner",
        purpose: "memory.write.v1",
      }),
    })).rejects.toThrow("exact owner scope");
  });
});

function cognitionCandidate(
  options: { model?: string } = {},
): CognificationCandidateBatchV1 {
  const batchInputSha256 = "b".repeat(64);
  const sourceItemId = "source-item-cognition-store";
  const sourceRevisionId = "source-revision-cognition-store";
  const documentId = "document-cognition-store";
  const batchId = deriveCognificationBatchId({
    documentId,
    sourceItemId,
    sourceRevisionId,
    batchIndex: 0,
    batchInputSha256,
  });
  const evidence: CognificationEvidenceBindingV1 = {
    evidenceUnitId: "evidence-cognition-store",
    chunkId: "chunk-cognition-store",
    chunkIndex: 0,
    quote: "Grounded evidence",
    quoteSha256: contentSha256Hex("Grounded evidence"),
    coordinateSpace: "evidence_content",
    offsetUnit: "utf16_code_unit",
    startOffset: 0,
    endOffsetExclusive: "Grounded evidence".length,
  };
  const summaryBody = {
    text: "Grounded cognition summary",
    confidenceBasisPoints: 9_500,
    evidence: [evidence],
  };
  return buildCognificationCandidateBatchV1({
    batchId,
    tenantId,
    ownerActorId: actorId,
    documentId,
    sourceItemId,
    sourceRevisionId,
    batchIndex: 0,
    batchCount: 1,
    firstChunkIndex: 0,
    lastChunkIndex: 0,
    chunkCount: 1,
    inputCharacterCount: "Grounded evidence".length,
    batchInputSha256,
    evidenceUnitIds: [evidence.evidenceUnitId],
    ontologyVersionId: "asael-ontology:1",
    topics: [],
    claims: [],
    entities: [],
    relations: [],
    summary: {
      candidateId: deriveCognificationCandidateId("summary", summaryBody),
      ...summaryBody,
    },
    modelAttribution: {
      provider: "openai",
      model: options.model || "configured-memory-model",
      routingSource: "tenant_assignment",
      assignmentScope: "memory",
      assignmentId: "assignment-memory",
      assignmentRevision: 4,
      assignmentConfigurationSha256: "a".repeat(64),
      credentialSource: "tenant_vault",
      usageReceiptRecorded: true,
      usageReceiptId: "usage-cognition-store",
    },
  });
}

function ownerScope() {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId: "knowledge-cognition-store-test",
    purpose: "memory.write.v1",
  });
}
