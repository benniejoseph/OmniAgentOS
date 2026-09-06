import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  issueContextSelectionPreview,
  lockContextSelection,
  parseContextSelectionLockBinding,
  verifyContextSelectionLock,
} from "@/lib/rag/context-selection-lock";
import {
  buildContextUseReceiptV1,
  parseContextUseReceiptV1,
} from "@/lib/rag/context-use-receipt";

const now = new Date("2026-09-06T10:00:00.000Z");

describe("context selection locks", () => {
  beforeEach(() => {
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "context-lock-unit-test-secret");
  });

  it("binds the reviewed subset and exclusions to tenant, actor, and task", () => {
    const preview = issueContextSelectionPreview({
      tenantId: "tenant-a",
      actorId: "actor-a",
      query: "Restore the database",
      candidateEvidenceIds: [
        "knowledge:restore-runbook",
        "memory:operator-preference",
        "graph:database-owner",
      ],
      contextPackSha256: "a".repeat(64),
      now,
    });
    const locked = lockContextSelection({
      tenantId: "tenant-a",
      actorId: "actor-a",
      query: "Restore   the database",
      evidenceIds: ["knowledge:restore-runbook", "graph:database-owner"],
      previewToken: preview.token,
      now,
    });
    const binding = verifyContextSelectionLock({
      tenantId: "tenant-a",
      actorId: "actor-a",
      selection: {
        query: "Restore the database",
        evidenceIds: ["knowledge:restore-runbook", "graph:database-owner"],
        lockToken: locked.token,
      },
      now,
    });

    expect(binding.evidenceIds).toEqual([
      "knowledge:restore-runbook",
      "graph:database-owner",
    ]);
    expect(binding.excludedEvidenceIds).toEqual(["memory:operator-preference"]);
    expect(parseContextSelectionLockBinding(binding)).toEqual(binding);
  });

  it("rejects tampering, cross-actor reuse, changed selections, and expiry", () => {
    const preview = issueContextSelectionPreview({
      tenantId: "tenant-a",
      actorId: "actor-a",
      query: "Use my runbook",
      candidateEvidenceIds: ["knowledge:runbook"],
      contextPackSha256: "b".repeat(64),
      now,
    });
    const locked = lockContextSelection({
      tenantId: "tenant-a",
      actorId: "actor-a",
      query: "Use my runbook",
      evidenceIds: ["knowledge:runbook"],
      previewToken: preview.token,
      now,
    });
    const selection = {
      query: "Use my runbook",
      evidenceIds: ["knowledge:runbook"],
      lockToken: locked.token,
    };

    expect(() => verifyContextSelectionLock({
      tenantId: "tenant-a",
      actorId: "actor-b",
      selection,
      now,
    })).toThrow(/another workspace actor/i);
    expect(() => verifyContextSelectionLock({
      tenantId: "tenant-a",
      actorId: "actor-a",
      selection: { ...selection, evidenceIds: [] },
      now,
    })).toThrow(/changed after it was locked/i);
    expect(() => verifyContextSelectionLock({
      tenantId: "tenant-a",
      actorId: "actor-a",
      selection: { ...selection, lockToken: `${locked.token.slice(0, -1)}x` },
      now,
    })).toThrow(/signature/i);
    expect(() => verifyContextSelectionLock({
      tenantId: "tenant-a",
      actorId: "actor-a",
      selection,
      now: new Date("2026-09-06T10:31:00.000Z"),
    })).toThrow(/expired/i);
  });

  it("records the final compiled subset without storing context content", () => {
    const preview = issueContextSelectionPreview({
      tenantId: "tenant-a",
      actorId: "actor-a",
      query: "Use my runbook",
      candidateEvidenceIds: ["knowledge:runbook", "memory:preference"],
      contextPackSha256: "c".repeat(64),
      now,
    });
    const locked = lockContextSelection({
      tenantId: "tenant-a",
      actorId: "actor-a",
      query: "Use my runbook",
      evidenceIds: ["knowledge:runbook", "memory:preference"],
      previewToken: preview.token,
      now,
    });
    const receipt = buildContextUseReceiptV1({
      runId: "run-a",
      selection: locked.binding,
      actualEvidenceIds: ["knowledge:runbook"],
      retrievalTraceId: "trace-a",
      compiledContext: "private compiled context",
      contextBudget: { effectiveTokenLimit: 8_192, estimatedTokens: 120 },
      recordedAt: now.toISOString(),
    });

    expect(receipt.actualEvidenceIds).toEqual(["knowledge:runbook"]);
    expect(receipt.droppedEvidenceIds).toEqual(["memory:preference"]);
    expect(JSON.stringify(receipt)).not.toContain("private compiled context");
    expect(parseContextUseReceiptV1(receipt)).toEqual(receipt);
    expect(() => parseContextUseReceiptV1({
      ...receipt,
      actualCount: 2,
    })).toThrow(/digest|counts/i);
  });
});
