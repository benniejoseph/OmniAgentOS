import { describe, expect, it, vi } from "vitest";
import { canonicalSourceRevisionAdvanceAllowed, persistCanonicalSourceWrite, type SourceSqlClient } from "@/lib/sources/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

const current = {
  requestedRevisionId: "source_revision_requested",
  requestedSourceUpdatedAt: "2026-08-28T08:04:54.202Z",
  requestedCapturedAt: "2026-08-28T08:04:54.202Z",
  currentRevisionId: "source_revision_current",
  currentSourceUpdatedAt: "2026-08-28T08:04:54.202Z",
  currentCapturedAt: "2026-08-28T08:04:54.202Z",
  currentHasKnowledgeBinding: true,
} as const;

describe("canonical source revision advancement", () => {
  it("orders revisions by provider observation time, not content-derived ids", () => {
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      requestedSourceUpdatedAt: "2026-08-29T08:04:54.202Z",
    })).toBe(true);
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      requestedSourceUpdatedAt: "2026-08-27T08:04:54.202Z",
    })).toBe(false);
  });

  it("allows an exact retry but protects a bound equal-time revision", () => {
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      requestedRevisionId: current.currentRevisionId,
    })).toBe(true);
    expect(canonicalSourceRevisionAdvanceAllowed(current)).toBe(false);
  });

  it("repairs an orphaned equal-time revision", () => {
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      currentHasKnowledgeBinding: false,
    })).toBe(true);
  });
});

describe("scoped canonical source authority", () => {
  it.each([
    { executingPrincipalType: "agent" as const, executingPrincipalId: null },
    { executingPrincipalType: "system" as const, executingPrincipalId: null },
    { executingPrincipalType: "user" as const, executingPrincipalId: "another-user" },
  ])("rejects an unbound or mismatched $executingPrincipalType before a source write", async principal => {
    const executionScope = createExecutionScope({ tenantId: "source-tenant", initiatingActorId: "source-owner",
      projectId: "source-project", correlationId: "source-request", purpose: "agent.run", ...principal });
    const content = "Project brief.";
    const write = buildCanonicalTextSourceWrite({
      lineage: { executionScope, connectionId: "source-connection", adapterId: "source-adapter",
        externalItemId: "brief", sourceKind: "document", capturedAt: "2026-11-02T11:00:00.000Z" },
      content, normalizedContent: content,
      chunks: [{ index: 0, content, characterStart: 0, characterEnd: content.length }],
    });
    const query = vi.fn();
    const sql = Object.assign(query, { transactionScoped: true }) as unknown as SourceSqlClient;
    await expect(persistCanonicalSourceWrite(sql, write, { documentId: "source-document" }))
      .rejects.toThrow("actor-bound executing principal");
    expect(query).not.toHaveBeenCalled();
  });
});
