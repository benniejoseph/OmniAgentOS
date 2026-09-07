import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-run-feedback-route-"),
  );
  process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS = "true";
  process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE = "0";
  process.env.OMNIAGENT_INTERNAL_AUTH_SECRET = "run-context-receipt-test-secret";
  delete process.env.DATABASE_URL;
});

describe("run feedback effects", () => {
  it("returns the content-free context receipt for later inspection", async () => {
    const runs = await import("@/lib/runs/store");
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const { issueContextSelectionPreview, lockContextSelection } = await import("@/lib/rag/context-selection-lock");
    const { buildContextUseReceiptV1 } = await import("@/lib/rag/context-use-receipt");
    const { GET } = await import("@/app/api/runs/[id]/route");
    const tenantId = "context-receipt-tenant";
    const actorId = "context-receipt-owner";
    const run = await runs.createAgentRun({
      tenantId,
      actorId,
      mode: "orchestrate",
      prompt: "Use the selected runbook.",
      messages: [{ role: "user", content: "Use the selected runbook." }],
      agentId: "atlas",
    });
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "context-receipt-request",
      purpose: "agent.run",
    });
    await runs.bindAgentRunExecutionScope(run.id, executionScope, { tenantId });
    const preview = issueContextSelectionPreview({
      tenantId,
      actorId,
      query: "Use the selected runbook.",
      candidateEvidenceIds: ["knowledge:runbook", "memory:preference"],
      contextPackSha256: "a".repeat(64),
    });
    const selection = lockContextSelection({
      tenantId,
      actorId,
      query: "Use the selected runbook.",
      evidenceIds: ["knowledge:runbook"],
      previewToken: preview.token,
    }).binding;
    const receipt = buildContextUseReceiptV1({
      runId: run.id,
      selection,
      actualEvidenceIds: ["knowledge:runbook"],
      compiledContext: "context body",
      contextBudget: { effectiveTokenLimit: 8_192 },
    });
    await runs.appendContextUseReceiptEvent(run.id, receipt, {
      tenantId,
      executionScope,
    });

    const response = await GET(
      new Request(`http://asael.test/api/runs/${run.id}`, {
        headers: {
          "x-omni-tenant-id": tenantId,
          "x-omni-user-id": actorId,
          "x-omni-user-role": "admin",
        },
      }),
      { params: Promise.resolve({ id: run.id }) },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      agentIdentity: { state: "unbound" },
      contextReceipt: {
        receiptSha256: receipt.receiptSha256,
        userInclusionIds: ["knowledge:runbook"],
        userExclusionIds: ["memory:preference"],
        actualEvidenceIds: ["knowledge:runbook"],
      },
    });
  });

  it("demotes executed capabilities only when feedback enters needs_work", async () => {
    const runs = await import("@/lib/runs/store");
    const trust = await import("@/lib/trust/ledger");
    const { PATCH } = await import("@/app/api/runs/[id]/route");
    const tenantId = "feedback-transition-tenant";
    const actorId = "feedback-owner";
    const run = await runs.createAgentRun({
      tenantId,
      actorId,
      mode: "execute",
      prompt: "Call the governed endpoint.",
      messages: [{ role: "user", content: "Call the governed endpoint." }],
      agentId: "forge",
    });
    await runs.appendRunEvent(run.id, {
      type: "tool",
      toolId: "http.request",
      toolName: "HTTP Request",
      status: "executed",
      riskLevel: 2,
      executionId: "feedback-execution",
    }, { tenantId });
    await runs.completeAgentRun(run.id, "The request completed.");

    const first = await PATCH(
      feedbackRequest(run.id, tenantId, actorId),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      feedbackEffects: { demotedCapabilities: ["http.request"] },
    });

    const repeated = await PATCH(
      feedbackRequest(run.id, tenantId, actorId),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      feedbackEffects: { demotedCapabilities: [] },
    });
    await expect(trust.getTrustProfile("http.request", { tenantId })).resolves.toMatchObject({
      rejections: 1,
    });
  });
});

function feedbackRequest(runId: string, tenantId: string, actorId: string) {
  return new Request(`http://asael.test/api/runs/${encodeURIComponent(runId)}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      "x-omni-tenant-id": tenantId,
      "x-omni-user-id": actorId,
      "x-omni-user-role": "admin",
    },
    body: JSON.stringify({ verdict: "needs_work", correction: "Retry safely." }),
  });
}
