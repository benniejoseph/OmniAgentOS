import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const network = vi.hoisted(() => ({
  assertPublicHttpUrl: vi.fn(),
  fetchPublicHttpUrl: vi.fn(),
}));

vi.mock("@/lib/security/network", () => ({
  assertPublicHttpUrl: network.assertPublicHttpUrl,
  fetchPublicHttpUrl: network.fetchPublicHttpUrl,
}));

describe("governed HTTP effect receipts", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-http-effect-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    network.assertPublicHttpUrl.mockImplementation(async (value: string) =>
      new URL(value).toString()
    );
    network.fetchPublicHttpUrl.mockResolvedValue(new Response("accepted", {
      status: 202,
      statusText: "Accepted",
      headers: { "content-type": "text/plain" },
    }));
  });

  it("binds approval, intent, delivery acknowledgement, and receipt", async () => {
    const tenantId = "tenant-http-effect";
    const actorId = "owner-http-effect";
    const input = {
      url: "https://example.com/hooks/asael",
      method: "POST" as const,
      body: JSON.stringify({ message: "exact-approved-value" }),
    };
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "http-effect-request",
      purpose: "tool.http.request",
    });
    const context = {
      tenantId,
      actorId,
      role: "admin" as const,
      source: "default" as const,
    };
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");

    const pending = await executeGovernedTool({
      toolId: "http.request",
      input,
      dryRun: false,
      context,
      executionScope: scope,
    });
    expect(pending.record.status).toBe("approval_required");
    expect(store.publicToolExecution(pending.record).output).toEqual({});

    const claimToken = "http-effect-execution-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "reviewer-http-effect",
      approvedRole: "admin",
      claimToken,
    });
    expect(claim.outcome).toBe("claimed");
    const approvedInput = store.openToolExecutionInput(claim.record!);

    const executed = await executeGovernedTool({
      toolId: "http.request",
      input: approvedInput,
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(network.fetchPublicHttpUrl).toHaveBeenCalledTimes(1);
    expect(network.fetchPublicHttpUrl).toHaveBeenCalledWith(
      "https://example.com/hooks/asael",
      expect.objectContaining({
        method: "POST",
        body: input.body,
      }),
      "Request URL",
    );
    expect(executed.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId: "http.request",
        executionId: pending.record.id,
        tenantId,
        actorId,
        approvalState: "approved",
        targetType: "http_endpoint",
        providerAcknowledgement: "provider_response",
        verificationState: "unverifiable",
        verificationReasonCode: "read_unavailable",
      },
    });
    const receipt = executed.record.effectReceipt;
    expect(receipt?.schemaVersion).toBe(2);
    if (!receipt || receipt.schemaVersion !== 2) {
      throw new Error("Expected a v2 HTTP effect receipt.");
    }
    expect(store.getToolExecutionEffectIntentV2(executed.record)).toMatchObject({
      executionId: pending.record.id,
      inputSha256: receipt.inputSha256,
      approvalBindingSha256: receipt.approvalBindingSha256,
      targetId: receipt.targetId,
    });
    expect(JSON.stringify(store.publicToolExecution(executed.record).output))
      .not.toContain("__effect");

    const events = await listStreamEvents(
      `tool_execution:${pending.record.id}`,
      { tenantId, actorId },
    );
    expect(events.map((event) => event.type).filter((type) =>
      type.startsWith("tool.effect_")
    )).toEqual([
      "tool.effect_intent.recorded",
      "tool.effect_receipt.recorded",
    ]);
  });

  it("leaves GET requests outside the mutation receipt path", async () => {
    const tenantId = "tenant-http-read";
    const actorId = "owner-http-read";
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "http-read-request",
      purpose: "tool.http.request",
    });
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const result = await executeGovernedTool({
      toolId: "http.request",
      input: { url: "https://example.com/status", method: "GET" },
      dryRun: true,
      context: {
        tenantId,
        actorId,
        role: "admin",
        source: "default",
      },
      executionScope: scope,
    });
    expect(result.record.status).toBe("dry_run");
    expect(result.record.effectReceipt).toBeUndefined();
    expect(network.fetchPublicHttpUrl).not.toHaveBeenCalled();
  });

  it("keeps an uncertain provider delivery intent-bound and unreplayed", async () => {
    const tenantId = "tenant-http-unknown";
    const actorId = "owner-http-unknown";
    const scope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "http-unknown-request",
      purpose: "tool.http.request",
    });
    const context = {
      tenantId,
      actorId,
      role: "admin" as const,
      source: "default" as const,
    };
    const input = {
      url: "https://example.com/hooks/unknown",
      method: "DELETE" as const,
    };
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executor.executeGovernedTool({
      toolId: "http.request",
      input,
      dryRun: false,
      context,
      executionScope: scope,
    });
    const claimToken = "http-unknown-execution-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "reviewer-http-unknown",
      approvedRole: "admin",
      claimToken,
    });
    network.fetchPublicHttpUrl.mockRejectedValueOnce(
      new Error("connection closed after request transmission"),
    );

    await expect(executor.executeGovernedTool({
      toolId: "http.request",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    })).rejects.toBeInstanceOf(executor.EffectReceiptFinalizationError);

    const retained = await store.getToolExecution(pending.record.id, {
      tenantId,
    });
    expect(retained).toMatchObject({ status: "executing" });
    expect(store.getToolExecutionEffectIntentV2(retained!)).toMatchObject({
      executionId: pending.record.id,
      toolId: "http.request",
      targetType: "http_endpoint",
    });
    expect(retained?.effectReceipt).toBeUndefined();
    expect(network.fetchPublicHttpUrl).toHaveBeenCalledTimes(1);
  });
});
