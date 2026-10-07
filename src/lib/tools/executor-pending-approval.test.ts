import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { governedToolExecutionId } from "@/lib/tools/execution-id";

const mocks = vi.hoisted(() => ({
  executeApp: vi.fn(),
}));
const lookups = vi.hoisted(() => ({ hidden: new Set<string>() }));

// Plays a request that looked for its key before a concurrent request stored
// the record there.
vi.mock("@/lib/tools/audit-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tools/audit-store")>();
  return {
    ...actual,
    getToolExecution: (id: string, options?: { tenantId?: string }) =>
      lookups.hidden.has(id)
        ? Promise.resolve(undefined)
        : actual.getToolExecution(id, options),
  };
});

vi.mock("@/lib/app-services/tool-dispatcher", () => ({
  executeFirstPartyAppTool: mocks.executeApp,
}));
vi.mock("@/lib/trust/ledger", () => ({
  actionClassFor: (toolId: string) => toolId,
  recordActionOutcome: vi.fn(),
  resolveAutonomy: vi.fn(),
}));
vi.mock("@/lib/security/network", () => ({
  assertPublicHttpUrl: async (value: string) => new URL(value).toString(),
  fetchPublicHttpUrl: vi.fn(),
}));

const tenantId = "tenant-pending-approval";
const actorId = "owner-pending-approval";
const context = {
  tenantId,
  actorId,
  role: "admin" as const,
  source: "default" as const,
};
const scope = createExecutionScope({
  tenantId,
  initiatingActorId: actorId,
  executingPrincipalType: "user",
  executingPrincipalId: actorId,
  correlationId: "pending-approval-request",
  purpose: "tool.pending_approval.test",
});
// HTTP is gated, so a GET that is not approved waits for approval.
const statusCheck = {
  toolId: "http.request",
  input: { url: "https://example.com/status", method: "GET" as const },
  dryRun: false,
  context,
  executionScope: scope,
};

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-pending-approval-"),
  );
  delete process.env.DATABASE_URL;
  mocks.executeApp.mockReset();
  mocks.executeApp.mockResolvedValue({ handled: true, result: { status: 200 } });
  lookups.hidden.clear();
});

/** The approvals waiting in the tenant, and the ids announced as waiting. */
async function queue() {
  const { listToolExecutions } = await import("@/lib/tools/audit-store");
  const { listObservabilityEvents } = await import("@/lib/observability/store");
  const records = await listToolExecutions(50, { tenantId });
  const announced = await listObservabilityEvents({
    action: "tool.approval_pending",
    tenantId,
    limit: 50,
  });
  return {
    waiting: records
      .filter((record) => record.status === "approval_required")
      .map((record) => record.id)
      .sort(),
    announced: announced.map((event) => event.resourceId).sort(),
  };
}

describe("keyed tool approvals", () => {
  it("cannot restore a retired CRM operation with an old approval", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { saveToolExecution } = await import("@/lib/tools/audit-store");
    const oldApproval = {
      id: "retired-crm-approval",
      tenantId,
      actorId,
      toolId: "app.customer_accounts.salesforce.contact.create",
      toolName: "Create Salesforce contact",
      riskLevel: 2 as const,
      status: "approval_required" as const,
      dryRun: false,
      approvalRequired: true,
      input: { accountId: `customer-account:${"a".repeat(64)}` },
      reason: "Awaiting review before retirement.",
      createdAt: new Date().toISOString(),
    };
    await saveToolExecution(oldApproval);

    const outcome = await executeGovernedTool({
      toolId: oldApproval.toolId,
      input: oldApproval.input,
      dryRun: false,
      approved: true,
      context,
      existingRecord: oldApproval,
    });

    expect(outcome.record).toMatchObject({
      status: "blocked",
      reason: "Unknown tools are blocked by default.",
    });
    expect(outcome.result).toBeNull();
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });

  it("queues one approval for a key however often the request is sent", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const retried = { ...statusCheck, idempotencyKey: "run-1:status" };
    const raced = { ...statusCheck, idempotencyKey: "run-2:status" };
    const retriedId = governedToolExecutionId(tenantId, retried.idempotencyKey);
    const racedId = governedToolExecutionId(tenantId, raced.idempotencyKey);

    const first = await executeGovernedTool(retried);
    const again = await executeGovernedTool(retried);
    const racing = await Promise.all(
      [1, 2, 3].map(() => executeGovernedTool(raced)),
    );

    expect(first).toMatchObject({
      record: { id: retriedId, status: "approval_required" },
      result: null,
    });
    expect(again).toMatchObject({
      record: { id: retriedId, createdAt: first.record.createdAt },
      result: null,
    });
    for (const outcome of racing) {
      expect(outcome).toMatchObject({
        record: {
          id: racedId,
          status: "approval_required",
          createdAt: racing[0].record.createdAt,
        },
        result: null,
      });
    }
    expect(await queue()).toEqual({
      waiting: [retriedId, racedId].sort(),
      announced: [retriedId, racedId].sort(),
    });
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });

  it("offers a read that failed for approval again under its key", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = { ...statusCheck, idempotencyKey: "run-3:status" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    mocks.executeApp.mockRejectedValueOnce(
      new Error("The status endpoint timed out."),
    );
    const failed = await executeGovernedTool({ ...request, approved: true });
    expect(failed.record).toMatchObject({ id, status: "failed" });

    const retry = await executeGovernedTool(request);

    expect(retry).toMatchObject({
      record: { id, status: "approval_required" },
      result: null,
    });
    expect(await queue()).toEqual({ waiting: [id], announced: [id] });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });

  it("checks what a concurrent request stored under the key before returning it", async () => {
    const { EffectReceiptFinalizationError, executeGovernedTool } = await import(
      "@/lib/tools/executor"
    );
    const { saveToolExecution } = await import("@/lib/tools/audit-store");
    const request = { ...statusCheck, idempotencyKey: "run-4:status" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    const unscoped = (idempotencyKey: string) => ({
      toolId: statusCheck.toolId,
      input: statusCheck.input,
      dryRun: false,
      context,
      idempotencyKey,
    });
    const first = await executeGovernedTool(request);
    lookups.hidden.add(id);

    await expect(executeGovernedTool(request)).resolves.toMatchObject({
      record: { id, status: "approval_required", createdAt: first.record.createdAt },
      result: null,
    });
    // The approval is bound to the scope that queued it.
    await expect(executeGovernedTool(unscoped(request.idempotencyKey)))
      .rejects.toBeInstanceOf(EffectReceiptFinalizationError);
    expect(await queue()).toEqual({ waiting: [id], announced: [id] });

    const doneKey = "run-5:status";
    const doneId = governedToolExecutionId(tenantId, doneKey);
    const completedAt = new Date().toISOString();
    await saveToolExecution({
      id: doneId,
      tenantId,
      actorId,
      toolId: statusCheck.toolId,
      toolName: "HTTP request",
      riskLevel: 2,
      status: "executed",
      dryRun: false,
      approvalRequired: true,
      input: statusCheck.input,
      output: { status: 200 },
      reason: "Approved and run.",
      createdAt: completedAt,
      completedAt,
    });
    lookups.hidden.add(doneId);

    await expect(executeGovernedTool(unscoped(doneKey))).resolves.toMatchObject({
      record: { id: doneId, status: "executed" },
      result: { status: 200 },
    });
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });
});
