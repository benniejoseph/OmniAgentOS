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
  delete process.env.DATABASE_URL;
});

describe("run feedback learning", () => {
  it("demotes executed capabilities only when feedback enters needs_work", async () => {
    const runs = await import("@/lib/runs/store");
    const trust = await import("@/lib/trust/ledger");
    const { PATCH } = await import("@/app/api/runs/[id]/route");
    const tenantId = "feedback-transition-tenant";
    const actorId = "feedback-owner";
    const run = await runs.createAgentRun({
      tenantId,
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
      learning: { demotedCapabilities: ["http.request"] },
    });

    const repeated = await PATCH(
      feedbackRequest(run.id, tenantId, actorId),
      { params: Promise.resolve({ id: run.id }) },
    );
    expect(repeated.status).toBe(200);
    await expect(repeated.json()).resolves.toMatchObject({
      learning: { demotedCapabilities: [] },
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
