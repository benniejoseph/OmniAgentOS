import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getActiveMemoriesByIds: vi.fn(),
  getCanonicalKnowledgeEvidenceByChunkIds: vi.fn(),
}));

vi.mock("@/lib/memory/store", () => ({
  getActiveMemoriesByIds: mocks.getActiveMemoriesByIds,
}));

vi.mock("@/lib/rag/store", () => ({
  getCanonicalKnowledgeEvidenceByChunkIds:
    mocks.getCanonicalKnowledgeEvidenceByChunkIds,
}));

import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import type {
  MemoryGraphSearchResult,
  MemoryRecord,
  MemorySearchResult,
} from "@/lib/memory/types";
import {
  buildContextCompilerV2Shadow,
  parseContextCompilerV2ShadowReceipt,
  prepareContextCompilerV2Candidates,
  type ContextCompilerV2PreparedCandidate,
} from "@/lib/rag/context-compiler-v2";
import type {
  KnowledgeChunk,
  KnowledgeSearchResult,
} from "@/lib/rag/types";
import {
  createExecutionScope,
} from "@/lib/security/execution-scope";
import {
  buildCanonicalTextSourceWrite,
} from "@/lib/sources/text-lineage";
import { CONTEXT_COMPILER_V2_PURPOSE_ID } from "@/lib/sources/purposes";
import {
  databaseMemoryAccessScopeFromExecutionScope,
} from "@/lib/db/memory-access-scope";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";

const asOfTime = "2026-09-06T02:00:00.000Z";

beforeEach(() => {
  mocks.getActiveMemoriesByIds.mockReset();
  mocks.getCanonicalKnowledgeEvidenceByChunkIds.mockReset();
});

describe("Context Compiler v2 shadow", () => {
  it("selects only authorized candidates and stores no raw evidence IDs", () => {
    const candidates: ContextCompilerV2PreparedCandidate[] = [
      preparedCandidate("memory:private-secret-a", "claim", "authorized", 0.9),
      preparedCandidate(
        "knowledge:private-secret-b",
        "canonical_evidence",
        "purpose_not_allowed",
        0.99,
      ),
    ];
    const shadow = buildContextCompilerV2Shadow({
      runId: "run-a",
      tenantId: "tenant-a",
      query: "What was decided?",
      candidates,
      legacySelectedEvidenceIds: candidates.map((candidate) => candidate.evidenceId),
      limit: 8,
      asOfTime,
    });

    expect(shadow.selectedEvidenceIds).toEqual(["memory:private-secret-a"]);
    expect(shadow.receipt).toMatchObject({
      candidateCount: 2,
      authorizedCandidateCount: 1,
      selectedCount: 1,
      legacySelectedCount: 2,
      legacyOnlyCount: 1,
      v2OnlyCount: 0,
      comparisonState: "diverged",
    });
    const serialized = JSON.stringify(shadow.receipt);
    expect(serialized).not.toContain("private-secret-a");
    expect(serialized).not.toContain("private-secret-b");
  });

  it("treats an explicit empty selection as authoritative", () => {
    const candidate = preparedCandidate(
      "memory:selected",
      "claim",
      "authorized",
      0.9,
    );
    const shadow = buildContextCompilerV2Shadow({
      runId: "run-empty",
      tenantId: "tenant-a",
      query: "Do not use saved context",
      candidates: [candidate],
      legacySelectedEvidenceIds: [],
      explicitEvidenceIds: [],
      limit: 8,
      asOfTime,
    });

    expect(shadow.selectedEvidenceIds).toEqual([]);
    expect(shadow.receipt.explicitSelectionState).toBe("empty");
    expect(shadow.receipt.decisions[0].selectionReason).toBe("user_excluded");
    expect(shadow.receipt.comparisonState).toBe("matched");
  });

  it("rejects a tampered receipt", () => {
    const shadow = buildContextCompilerV2Shadow({
      runId: "run-tamper",
      tenantId: "tenant-a",
      query: "query",
      candidates: [preparedCandidate("memory:a", "claim", "authorized", 0.8)],
      legacySelectedEvidenceIds: ["memory:a"],
      limit: 8,
      asOfTime,
    });
    expect(() => parseContextCompilerV2ShadowReceipt({
      ...shadow.receipt,
      selectedCount: 0,
    })).toThrow("digest");
  });

  it("authorizes current scoped evidence and rejects stale or ungranted inputs", async () => {
    const executionScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-a",
      executingPrincipalType: "user",
      executingPrincipalId: "actor-a",
      contextGrantIds: ["grant-a"],
      correlationId: "context-a",
      purpose: "agent.run",
    });
    const memoryAccessScope = databaseMemoryAccessScopeFromExecutionScope(
      executionScope,
      { purposeId: MEMORY_PURPOSE_IDS.retrieve, auditPurpose: "context-v2" },
    );
    const accessBinding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      originPurpose: "user.remember",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });
    const memory = memoryRecord("memory-a", accessBinding);
    const sourceContent = "The launch date is 12 October 2026.";
    const sourceWrite = buildCanonicalTextSourceWrite({
      lineage: {
        executionScope,
        connectionId: "connection-a",
        adapterId: "asael.knowledge",
        externalItemId: "launch-plan",
        sourceKind: "document",
        capturedAt: "2026-09-06T00:00:00.000Z",
        permissionGrantIds: ["grant-a"],
        allowedPurposeIds: [CONTEXT_COMPILER_V2_PURPOSE_ID],
      },
      content: sourceContent,
      normalizedContent: normalizeTextForChunking(sourceContent),
      chunks: chunkText(sourceContent),
    });
    const evidenceUnit = sourceWrite.adapterOutput.evidenceUnits[0];
    const chunk: KnowledgeChunk = {
      id: "chunk-a",
      tenantId: "tenant-a",
      documentId: "document-a",
      sourceRevisionId: evidenceUnit.sourceRevisionId,
      evidenceUnitId: evidenceUnit.evidenceUnitId,
      chunkIndex: 0,
      title: "Launch plan",
      content: sourceContent,
      tags: [],
      source: "manual",
      tokenEstimate: 10,
      characterCount: sourceContent.length,
      metadata: {},
      createdAt: asOfTime,
      updatedAt: asOfTime,
    };
    mocks.getCanonicalKnowledgeEvidenceByChunkIds.mockResolvedValue([{
      chunk,
      evidenceUnit,
      sourceState: {
        currentRevisionId: evidenceUnit.sourceRevisionId,
        operation: "upsert",
        isCurrent: true,
      },
    }]);
    mocks.getActiveMemoriesByIds.mockResolvedValue([memory]);

    const prepared = await prepareContextCompilerV2Candidates({
      executionScope,
      memoryAccessScope,
      memoryResults: [memorySearchResult(memory)],
      knowledgeResults: [knowledgeSearchResult(chunk)],
      graphResults: [graphSearchResult(accessBinding, memory.id)],
      asOfTime,
    });
    expect(prepared.map((candidate) => candidate.authorizationReason)).toEqual([
      "authorized",
      "authorized",
      "authorized",
    ]);

    mocks.getCanonicalKnowledgeEvidenceByChunkIds.mockResolvedValueOnce([{
      chunk,
      evidenceUnit,
      sourceState: {
        currentRevisionId: "revision-newer",
        operation: "upsert",
        isCurrent: false,
      },
    }]);
    mocks.getActiveMemoriesByIds.mockResolvedValueOnce([]);
    const rejected = await prepareContextCompilerV2Candidates({
      executionScope,
      memoryAccessScope,
      memoryResults: [],
      knowledgeResults: [knowledgeSearchResult(chunk)],
      graphResults: [graphSearchResult(accessBinding, memory.id)],
      asOfTime,
    });
    expect(rejected.map((candidate) => candidate.authorizationReason)).toEqual([
      "source_not_current",
      "graph_backing_memory_missing",
    ]);
  });
});

function preparedCandidate(
  evidenceId: string,
  itemClass: ContextCompilerV2PreparedCandidate["itemClass"],
  authorizationReason: ContextCompilerV2PreparedCandidate["authorizationReason"],
  score: number,
): ContextCompilerV2PreparedCandidate {
  return {
    evidenceId,
    itemClass,
    sourceRevisionId: null,
    score,
    authorizationState:
      authorizationReason === "authorized" ? "authorized" : "rejected",
    authorizationReason,
  };
}

function memoryRecord(
  id: string,
  accessBinding: NonNullable<MemoryRecord["accessBinding"]>,
): MemoryRecord {
  return {
    id,
    tenantId: "tenant-a",
    type: "fact",
    title: "Private title",
    content: "Private content",
    tags: [],
    scope: "user",
    source: "user-assertion",
    importance: 0.8,
    confidence: 1,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefs: ["turn:a"],
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    accessBinding,
  };
}

function memorySearchResult(record: MemoryRecord): MemorySearchResult {
  return { record, score: 0.9, reasons: ["test"] };
}

function knowledgeSearchResult(chunk: KnowledgeChunk): KnowledgeSearchResult {
  return {
    chunk,
    score: 0.8,
    vectorScore: 0.8,
    lexicalScore: 0,
    recencyScore: 1,
    reasons: ["test"],
  };
}

function graphSearchResult(
  accessBinding: NonNullable<MemoryRecord["accessBinding"]>,
  memoryId: string,
): MemoryGraphSearchResult {
  return {
    node: {
      id: "graph-a",
      tenantId: "tenant-a",
      accessBinding,
      kind: "concept",
      label: "Launch",
      slug: "launch",
      aliases: [],
      summary: "Private graph summary",
      weight: 1,
      sourceCount: 1,
      memoryIds: [memoryId],
      traceIds: [],
      tags: [],
      metadata: {},
      createdAt: asOfTime,
      updatedAt: asOfTime,
    },
    score: 0.7,
    communityId: "community-a",
    neighborhood: [],
    reasons: ["test"],
  };
}
