import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
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
} from "@/lib/knowledge/cognification-contract";
import {
  listKnowledgeCognitions,
  markKnowledgeCognitionProjected,
  purgeExpiredKnowledgeCognitionsBoundedLocal,
  reviewKnowledgeCognition,
  saveKnowledgeCognition,
} from "@/lib/knowledge/cognification-store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { contentSha256Hex } from "@/lib/sources/text-lineage";

const tenantId = "tenant-cognition-ttl";
const actorId = "actor-cognition-ttl";
let dataDir = "";

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T09:00:00.000Z"));
  dataDir = await mkdtemp(path.join(tmpdir(), "asael-cognition-ttl-"));
  process.env.OMNIAGENT_DATA_DIR = dataDir;
  mocks.hasDatabaseUrl.mockReset().mockReturnValue(false);
  mocks.ensureDatabaseSchema.mockClear();
  mocks.appendScopedDomainEvent.mockClear();
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.OMNIAGENT_DATA_DIR;
  await rm(dataDir, { recursive: true, force: true });
});

describe("bounded-local knowledge cognition retention", () => {
  it("purges one tenant in expiry and batch-id order and returns linked memories", async () => {
    const early = cognitionCandidate({
      suffix: "early",
      retentionExpiresAt: "2026-09-01T00:00:00.000Z",
    });
    const tied = ["tie-a", "tie-b"].map((suffix) => cognitionCandidate({
      suffix,
      retentionExpiresAt: "2026-09-02T00:00:00.000Z",
    })).sort((left, right) => left.batchId.localeCompare(right.batchId));
    const future = cognitionCandidate({
      suffix: "future",
      retentionExpiresAt: "2026-09-12T00:00:00.000Z",
    });
    const unbounded = cognitionCandidate({
      suffix: "unbounded",
      retentionExpiresAt: null,
    });
    const otherTenant = cognitionCandidate({
      suffix: "other-tenant",
      retentionExpiresAt: "2026-09-01T00:00:00.000Z",
      tenantId: "tenant-cognition-ttl-other",
      actorId: "actor-cognition-ttl-other",
    });

    for (const candidate of [
      tied[1], future, otherTenant, unbounded, tied[0], early,
    ]) {
      await saveKnowledgeCognition(candidate, {
        executionScope: ownerScope(
          candidate.tenantId,
          candidate.ownerActorId,
        ),
      });
    }
    await reviewKnowledgeCognition({
      id: early.batchId,
      tenantId,
      actorId,
      decision: "confirm",
      reviewedBy: actorId,
      executionScope: ownerScope(tenantId, actorId),
    });
    await markKnowledgeCognitionProjected({
      id: early.batchId,
      tenantId,
      actorId,
      projectedMemoryId: "memory-from-expired-cognition",
      executionScope: ownerScope(tenantId, actorId),
    });

    await expect(purgeExpiredKnowledgeCognitionsBoundedLocal({
      tenantId,
      asOf: "2026-09-10T00:00:00.000Z",
      limit: 2,
    })).resolves.toEqual({
      removedCandidateCount: 2,
      projectedMemories: [{
        id: "memory-from-expired-cognition",
        ownerActorId: actorId,
      }],
      moreAvailable: true,
    });

    const remaining = await listKnowledgeCognitions({ tenantId, actorId });
    expect(remaining.map((record) => record.candidate.batchId)).toEqual(
      expect.arrayContaining([
        tied[1].batchId,
        future.batchId,
        unbounded.batchId,
      ]),
    );
    expect(remaining).toHaveLength(3);
    expect(await listKnowledgeCognitions({
      tenantId: otherTenant.tenantId,
      actorId: otherTenant.ownerActorId,
    })).toHaveLength(1);

    await expect(purgeExpiredKnowledgeCognitionsBoundedLocal({
      tenantId,
      asOf: "2026-09-10T00:00:00.000Z",
      limit: 100_000,
    })).resolves.toEqual({
      removedCandidateCount: 1,
      projectedMemories: [],
      moreAvailable: false,
    });
    expect((await listKnowledgeCognitions({ tenantId, actorId }))
      .map((record) => record.candidate.batchId))
      .toEqual(expect.arrayContaining([future.batchId, unbounded.batchId]));
  });

  it("validates its scope and remains side-effect free when PostgreSQL is active", async () => {
    const candidate = cognitionCandidate({
      suffix: "postgres-noop",
      retentionExpiresAt: "2026-09-01T00:00:00.000Z",
    });
    await saveKnowledgeCognition(candidate, {
      executionScope: ownerScope(tenantId, actorId),
    });
    mocks.hasDatabaseUrl.mockReturnValue(true);

    await expect(purgeExpiredKnowledgeCognitionsBoundedLocal({
      tenantId,
      asOf: "2026-09-10T00:00:00.000Z",
    })).resolves.toEqual({
      removedCandidateCount: 0,
      projectedMemories: [],
      moreAvailable: false,
    });
    await expect(purgeExpiredKnowledgeCognitionsBoundedLocal({
      tenantId: " tenant-cognition-ttl",
    })).rejects.toThrow("tenant id is invalid");
    await expect(purgeExpiredKnowledgeCognitionsBoundedLocal({
      tenantId,
      asOf: "not-a-time",
    })).rejects.toThrow("timestamp is invalid");
    await expect(purgeExpiredKnowledgeCognitionsBoundedLocal({
      tenantId,
      limit: Number.NaN,
    })).rejects.toThrow("purge limit is invalid");
    expect(mocks.ensureDatabaseSchema).not.toHaveBeenCalled();

    mocks.hasDatabaseUrl.mockReturnValue(false);
    expect(await listKnowledgeCognitions({ tenantId, actorId })).toHaveLength(1);
  });
});

function cognitionCandidate(input: {
  suffix: string;
  retentionExpiresAt: string | null;
  tenantId?: string;
  actorId?: string;
}) {
  const candidateTenantId = input.tenantId || tenantId;
  const candidateActorId = input.actorId || actorId;
  const documentId = `document-${input.suffix}`;
  const sourceItemId = `source-item-${input.suffix}`;
  const sourceRevisionId = `source-revision-${input.suffix}`;
  const quote = `Grounded evidence ${input.suffix}`;
  const batchInputSha256 = contentSha256Hex(`input ${input.suffix}`);
  const batchId = deriveCognificationBatchId({
    documentId,
    sourceItemId,
    sourceRevisionId,
    retentionExpiresAt: input.retentionExpiresAt,
    batchIndex: 0,
    batchInputSha256,
  });
  const evidence = {
    evidenceUnitId: `evidence-${input.suffix}`,
    chunkId: `chunk-${input.suffix}`,
    chunkIndex: 0,
    quote,
    quoteSha256: contentSha256Hex(quote),
    coordinateSpace: "evidence_content" as const,
    offsetUnit: "utf16_code_unit" as const,
    startOffset: 0,
    endOffsetExclusive: quote.length,
  };
  const summaryBody = {
    text: `Grounded cognition summary ${input.suffix}`,
    confidenceBasisPoints: 9_500,
    evidence: [evidence],
  };
  return buildCognificationCandidateBatchV1({
    batchId,
    tenantId: candidateTenantId,
    ownerActorId: candidateActorId,
    documentId,
    sourceItemId,
    sourceRevisionId,
    retentionExpiresAt: input.retentionExpiresAt,
    batchIndex: 0,
    batchCount: 1,
    firstChunkIndex: 0,
    lastChunkIndex: 0,
    chunkCount: 1,
    inputCharacterCount: quote.length,
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
      model: "configured-memory-model",
      routingSource: "tenant_assignment",
      assignmentScope: "memory",
      assignmentId: "assignment-memory",
      assignmentRevision: 4,
      assignmentConfigurationSha256: "a".repeat(64),
      credentialSource: "tenant_vault",
      usageReceiptRecorded: true,
      usageReceiptId: `usage-${input.suffix}`,
    },
  });
}

function ownerScope(scopeTenantId: string, scopeActorId: string) {
  return createExecutionScope({
    tenantId: scopeTenantId,
    initiatingActorId: scopeActorId,
    executingPrincipalType: "user",
    executingPrincipalId: scopeActorId,
    correlationId: "knowledge-cognition-ttl-test",
    purpose: "memory.write.v1",
  });
}
