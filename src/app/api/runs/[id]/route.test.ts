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
  it("returns only exact-owner governed media artifacts with a server-built content URL", async () => {
    const runs = await import("@/lib/runs/store");
    const { saveCaptureAsset } = await import("@/lib/capture/assets");
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const { createToolExecutionRecord, saveToolExecution } = await import("@/lib/tools/audit-store");
    const { GET } = await import("@/app/api/runs/[id]/route");
    const tenantId = "run-media-projection-tenant";
    const actorId = "run-media-projection-owner";
    const run = await runs.createAgentRun({
      tenantId,
      actorId,
      mode: "execute",
      prompt: "Create a private image.",
      messages: [{ role: "user", content: "Create a private image." }],
      agentId: "forge",
    });
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "forge",
      correlationId: run.id,
      purpose: "media.image.generate",
    });
    const asset = await saveCaptureAsset({
      tenantId,
      actorId,
      executionScope,
      filename: "authoritative-portrait.png",
      mediaType: "image/png",
      bytes: new Uint8Array([137, 80, 78, 71]),
      tags: ["ai-media"],
      metadata: { origin: "media_studio", operation: "generate" },
    });
    const execution = createToolExecutionRecord({
      tenantId,
      actorId,
      toolId: "media.image.generate",
      toolName: "Generate Image",
      riskLevel: 1,
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      input: { prompt: "private prompt that must not be projected" },
      output: {
        kind: "video",
        operation: "edit",
        contentUrl: "https://untrusted.example/private.png",
        bytes: "private-image-bytes",
        asset: {
          id: asset.id,
          filename: "spoofed-name.html",
          mediaType: "text/html",
        },
      },
      completedAt: "2026-09-10T08:00:00.000Z",
    });
    await saveToolExecution(execution, { executionScope });
    // Legacy run events may predate actor attribution. The exact-owner tool and
    // Capture records remain the authority for the reconstructed projection.
    await runs.appendRunEvent(run.id, {
      type: "tool",
      toolId: execution.toolId,
      toolName: execution.toolName,
      status: "executed",
      riskLevel: execution.riskLevel,
      executionId: execution.id,
    }, { tenantId });
    await runs.completeAgentRun(run.id, "The private image is ready.", undefined, {
      tenantId,
    });

    const response = await GET(
      runRequest(run.id, tenantId, actorId),
      { params: Promise.resolve({ id: run.id }) },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.mediaArtifacts).toEqual([{
      executionId: execution.id,
      sequence: expect.any(Number),
      kind: "image",
      operation: "generate",
      assetId: asset.id,
      filename: "authoritative-portrait.png",
      mediaType: "image/png",
      byteCount: 4,
      status: "stored",
      contentUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1`,
      createdAt: "2026-09-10T08:00:00.000Z",
    }]);
    expect(JSON.stringify(body.mediaArtifacts)).not.toContain("untrusted.example");
    expect(JSON.stringify(body.mediaArtifacts)).not.toContain("private-image-bytes");
    expect(JSON.stringify(body.mediaArtifacts)).not.toContain("private prompt");
    expect(body).not.toHaveProperty("computerUseEvidence");
  });

  it("hides sibling media records and enforces the owner boundary for replay reads", async () => {
    const runs = await import("@/lib/runs/store");
    const { createToolExecutionRecord, saveToolExecution } = await import("@/lib/tools/audit-store");
    const { GET } = await import("@/app/api/runs/[id]/route");
    const tenantId = "run-media-sibling-tenant";
    const actorId = "run-media-primary-owner";
    const siblingActorId = "run-media-sibling-owner";
    const run = await runs.createAgentRun({
      tenantId,
      actorId,
      mode: "execute",
      prompt: "Create an image.",
      messages: [{ role: "user", content: "Create an image." }],
      agentId: "forge",
    });
    const siblingExecution = createToolExecutionRecord({
      tenantId,
      actorId: siblingActorId,
      toolId: "media.image.generate",
      toolName: "Generate Image",
      riskLevel: 1,
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      input: {},
      output: { asset: { id: "capture_asset_sibling_private" } },
      completedAt: "2026-09-10T08:05:00.000Z",
    });
    await saveToolExecution(siblingExecution);
    await runs.appendRunEvent(run.id, {
      type: "tool",
      toolId: siblingExecution.toolId,
      toolName: siblingExecution.toolName,
      status: "executed",
      riskLevel: siblingExecution.riskLevel,
      executionId: siblingExecution.id,
    }, { tenantId });

    const ownerResponse = await GET(
      runRequest(run.id, tenantId, actorId),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(ownerResponse.status).toBe(200);
    await expect(ownerResponse.json()).resolves.toMatchObject({ mediaArtifacts: [] });

    const siblingResponse = await GET(
      runRequest(run.id, tenantId, siblingActorId, true),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(siblingResponse.status).toBe(404);
  });

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

function runRequest(
  runId: string,
  tenantId: string,
  actorId: string,
  replay = false,
) {
  return new Request(
    `http://asael.test/api/runs/${encodeURIComponent(runId)}${replay ? "?replay=true" : ""}`,
    {
      headers: {
        "x-omni-tenant-id": tenantId,
        "x-omni-user-id": actorId,
        "x-omni-user-role": "admin",
      },
    },
  );
}
