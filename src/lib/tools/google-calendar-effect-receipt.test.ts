import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_CALENDAR_WRITE_SCOPE } from "@/lib/connectors/oauth-providers";
import { createExecutionScope } from "@/lib/security/execution-scope";

const oauth = vi.hoisted(() => ({
  getOAuthGrantSecrets: vi.fn(),
  saveOAuthGrant: vi.fn(),
}));

vi.mock("@/lib/connectors/oauth-store", () => ({
  getOAuthGrantSecrets: oauth.getOAuthGrantSecrets,
  saveOAuthGrant: oauth.saveOAuthGrant,
}));

const eventInput = {
  summary: "Governed planning session",
  description: "Created through the governed executor.",
  start: "2026-09-08T10:00:00.000Z",
  end: "2026-09-08T11:00:00.000Z",
};

describe("governed Google Calendar effect receipts", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-calendar-effect-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    oauth.getOAuthGrantSecrets.mockResolvedValue({
      grant: {
        id: "grant-calendar",
        tenantId: "tenant-calendar",
        actorId: "owner-calendar",
        provider: "google",
        scopes: [GOOGLE_CALENDAR_WRITE_SCOPE],
        status: "active",
        authorizationGeneration: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
      tokens: { access_token: "test-access-token" },
    });
  });

  it("creates once and records a verified read-after-write receipt", async () => {
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "POST") return Response.json({ id: "accepted" });
      const eventId = decodeURIComponent(url.split("/").at(-1) || "");
      return Response.json({
        id: eventId,
        summary: eventInput.summary,
        description: eventInput.description,
        start: { dateTime: eventInput.start },
        end: { dateTime: eventInput.end },
        htmlLink: "https://calendar.google.com/calendar/event?eid=test",
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tenantId = "tenant-calendar";
    const actorId = "owner-calendar";
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "calendar-direct",
      purpose: "tool.calendar.create",
    });
    const context = { tenantId, actorId, role: "admin" as const, source: "default" as const };
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executor.executeGovernedTool({
      toolId: "calendar.create",
      input: eventInput,
      dryRun: false,
      context,
      executionScope: scope,
    });
    expect(pending.record.status).toBe("approval_required");
    const claimToken = "calendar-direct-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "calendar-reviewer",
      approvedRole: "admin",
      claimToken,
    });
    const result = await executor.executeGovernedTool({
      toolId: "calendar.create",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    expect(result.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId: "calendar.create",
        targetType: "google_calendar_event",
        providerAcknowledgement: "provider_response",
        verificationState: "verified",
        verificationReasonCode: "state_matched",
      },
    });
  });

  it("reconciles an acknowledged event after the first verification response is lost", async () => {
    let postCount = 0;
    let getCount = 0;
    const fetchMock = vi.fn(async (request: string | URL | Request, init?: RequestInit) => {
      const url = String(request);
      if (init?.method === "POST") {
        postCount += 1;
        return Response.json({ id: "accepted" });
      }
      getCount += 1;
      if (getCount === 1) throw new Error("verification response lost");
      const eventId = decodeURIComponent(url.split("/").at(-1) || "");
      return Response.json({
        id: eventId,
        summary: eventInput.summary,
        description: eventInput.description,
        start: { dateTime: eventInput.start },
        end: { dateTime: eventInput.end },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const tenantId = "tenant-calendar";
    const actorId = "owner-calendar";
    const workflowRunId = "calendar-workflow-run";
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: `workflow:${workflowRunId}`,
      correlationId: workflowRunId,
      causationId: "workflow.tool:calendar-create",
      purpose: "workflow.tool.execute",
    });
    const context = { tenantId, actorId, role: "admin" as const, source: "default" as const };
    const effectBinding = {
      workflowRunId,
      planId: "calendar-plan",
      planSha256: "a".repeat(64),
      planNodeId: "create-event",
    };
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const request = {
      toolId: "calendar.create",
      input: eventInput,
      dryRun: false,
      approved: true,
      context,
      executionScope: scope,
      effectBinding,
      idempotencyKey: "workflow:calendar:create-once",
    } as const;

    await expect(executor.executeGovernedTool(request))
      .rejects.toBeInstanceOf(executor.EffectReceiptFinalizationError);
    const retained = await store.getToolExecution(
      `idem_${(await import("node:crypto")).createHash("sha256").update(`${tenantId}\0${request.idempotencyKey}`).digest("hex")}`,
      { tenantId },
    );
    expect(retained?.status).toBe("executing");
    expect(postCount).toBe(1);
    expect(store.getToolExecutionEffectIntentV2(retained!)).toMatchObject({
      toolId: "calendar.create",
      executionKind: "workflow",
    });

    const reconciled = await executor.executeGovernedTool(request);
    expect(postCount).toBe(1);
    expect(getCount).toBe(2);
    expect(reconciled.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        providerAcknowledgement: "provider_idempotency_reconciliation",
        verificationState: "verified",
        observedTargetStateSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });
});
