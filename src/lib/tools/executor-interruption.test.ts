import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { governedToolExecutionId } from "@/lib/tools/execution-id";

const mocks = vi.hoisted(() => ({
  executeApp: vi.fn(),
  recordOutcome: vi.fn(),
}));

vi.mock("@/lib/app-services/tool-dispatcher", () => ({
  executeFirstPartyAppTool: mocks.executeApp,
}));
vi.mock("@/lib/trust/ledger", () => ({
  actionClassFor: (toolId: string) => toolId,
  recordActionOutcome: mocks.recordOutcome,
  resolveAutonomy: vi.fn(),
}));
vi.mock("@/lib/security/network", () => ({
  assertPublicHttpUrl: async (value: string) => new URL(value).toString(),
  fetchPublicHttpUrl: vi.fn(),
}));

const tenantId = "tenant-tool-interruption";
const actorId = "owner-tool-interruption";
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
  correlationId: "tool-interruption-request",
  purpose: "tool.interruption.test",
});
// A GET is a read, and HTTP is gated, so it earns trust outcomes.
const statusCheck = {
  toolId: "http.request",
  input: { url: "https://example.com/status", method: "GET" as const },
  dryRun: false,
  approved: true,
  context,
  executionScope: scope,
};
const note = {
  toolId: "memory.write",
  input: { title: "Standup", content: "Standup moved to 10am." },
  dryRun: false,
  context,
};

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-tool-interruption-"),
  );
  delete process.env.DATABASE_URL;
  mocks.executeApp.mockReset();
  mocks.executeApp.mockResolvedValue({ handled: true, result: { ok: true } });
  mocks.recordOutcome.mockReset();
});

/** A tool that the caller stops while it is running. */
function stoppedWhileRunning(call: AbortController) {
  return async () => {
    call.abort();
    throw call.signal.reason;
  };
}

function settle(promise: Promise<unknown>) {
  return promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function stored(id: string) {
  const { getToolExecution } = await import("@/lib/tools/audit-store");
  return getToolExecution(id, { tenantId });
}

describe("governed tool interruption", () => {
  it("records a read stopped mid-call as interrupted and runs it again on replay", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = { ...statusCheck, idempotencyKey: "run-1:status" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    const call = new AbortController();
    mocks.executeApp.mockImplementationOnce(stoppedWhileRunning(call));

    const outcome = await settle(executeGovernedTool({
      ...request,
      abortSignal: call.signal,
    }));
    expect(outcome).toEqual({ error: call.signal.reason });

    const interrupted = await stored(id);
    expect(interrupted).toMatchObject({
      status: "failed",
      output: { interrupted: "in_flight" },
      reason: "The tool call was interrupted while it was running.",
    });
    expect(mocks.recordOutcome).not.toHaveBeenCalled();

    mocks.executeApp.mockResolvedValueOnce({
      handled: true,
      result: { status: 200 },
    });
    const replay = await executeGovernedTool({
      ...request,
      abortSignal: new AbortController().signal,
    });

    expect(replay).toMatchObject({
      record: { id, status: "executed", createdAt: interrupted!.createdAt },
      result: { status: 200 },
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(2);
    expect(mocks.recordOutcome).toHaveBeenCalledTimes(1);
    expect(mocks.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "http.request", kind: "success" }),
    );

    // A completed call replays its result without a new policy decision.
    await expect(executeGovernedTool({ ...request, approved: false }))
      .resolves.toMatchObject({
        record: { id, status: "executed" },
        result: { status: 200 },
      });
    expect(mocks.executeApp).toHaveBeenCalledTimes(2);
  });

  it("runs a read that failed on its own error again on replay", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = { ...statusCheck, idempotencyKey: "run-2:status" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    mocks.executeApp.mockRejectedValueOnce(
      new Error("The status endpoint timed out."),
    );

    const failed = await executeGovernedTool(request);

    expect(failed).toMatchObject({
      record: {
        id,
        status: "failed",
        output: { error: "The status endpoint timed out." },
      },
      result: null,
    });
    expect(failed.record.output).not.toHaveProperty("interrupted");
    expect(mocks.recordOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ toolId: "http.request", kind: "failure" }),
    );

    const replay = await executeGovernedTool(request);

    expect(replay.record).toMatchObject({ id, status: "executed" });
    expect(mocks.executeApp).toHaveBeenCalledTimes(2);
  });

  it("returns a failed read to a replay under another role instead of running it", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = { ...statusCheck, idempotencyKey: "run-3:status" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    mocks.executeApp.mockRejectedValueOnce(
      new Error("The status endpoint timed out."),
    );
    await executeGovernedTool(request);

    // The execution is bound to the admin who asked; an operator's replay
    // may read that result but not run the call again under its own role.
    const replay = await executeGovernedTool({
      ...request,
      context: { ...context, role: "operator" },
    });

    expect(replay).toMatchObject({
      record: { id, status: "failed" },
      result: null,
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });

  it("runs a read whose claim went stale again instead of reporting an unknown outcome", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { saveToolExecution } = await import("@/lib/tools/audit-store");
    const idempotencyKey = "run-4:search";
    const id = governedToolExecutionId(tenantId, idempotencyKey);
    const input = { query: "standup notes", limit: 5 };
    const claimedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await saveToolExecution({
      id,
      tenantId,
      actorId,
      toolId: "memory.search",
      toolName: "Search Memory",
      riskLevel: 0,
      status: "executing",
      dryRun: false,
      approvalRequired: false,
      input,
      output: { __executionClaim: { token: "lost-worker", claimedAt } },
      reason: "A worker that stopped answering claimed this call.",
      createdAt: claimedAt,
    });

    const replay = await executeGovernedTool({
      toolId: "memory.search",
      input,
      dryRun: false,
      context,
      idempotencyKey,
    });

    expect(replay).toMatchObject({
      record: { id, status: "executed", createdAt: claimedAt },
      result: { ok: true },
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });

  it("keeps a write stopped mid-call open instead of running it again", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = { ...note, idempotencyKey: "run-5:note" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    const call = new AbortController();
    mocks.executeApp.mockImplementationOnce(stoppedWhileRunning(call));

    const outcome = await settle(executeGovernedTool({
      ...request,
      abortSignal: call.signal,
    }));
    expect(outcome).toEqual({ error: call.signal.reason });
    expect(await stored(id)).toMatchObject({ status: "executing" });

    const replay = await executeGovernedTool(request);

    expect(replay).toMatchObject({
      record: { id, status: "executing" },
      result: null,
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });

  it("runs a write interrupted before it started again on replay", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = {
      ...note,
      executionScope: scope,
      idempotencyKey: "run-6:note",
    };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    const call = new AbortController();

    const outcome = await settle(executeGovernedTool({
      ...request,
      abortSignal: call.signal,
      // The caller stops between the claim and the tool.
      checkpointBeforeEffect: async () => call.abort(),
    }));
    expect(outcome).toEqual({ error: call.signal.reason });

    expect(mocks.executeApp).not.toHaveBeenCalled();
    const interrupted = await stored(id);
    expect(interrupted).toMatchObject({
      status: "failed",
      output: { interrupted: "before_start" },
      reason: "The tool call was interrupted before it started.",
    });

    const replay = await executeGovernedTool(request);

    expect(replay.record).toMatchObject({
      id,
      status: "executed",
      createdAt: interrupted!.createdAt,
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });

  it("leaves a write that failed on its own error final on replay", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = { ...note, idempotencyKey: "run-7:note" };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    mocks.executeApp.mockRejectedValueOnce(new Error("Memory quota exceeded."));

    const failed = await executeGovernedTool(request);
    expect(failed.record).toMatchObject({
      id,
      status: "failed",
      output: { error: "Memory quota exceeded." },
    });

    const replay = await executeGovernedTool(request);

    expect(replay).toMatchObject({
      record: { id, status: "failed" },
      result: null,
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });

  it("records an unkeyed write stopped mid-call so the call is not lost", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { listToolExecutions } = await import("@/lib/tools/audit-store");
    const call = new AbortController();
    mocks.executeApp.mockImplementationOnce(stoppedWhileRunning(call));

    const outcome = await settle(executeGovernedTool({
      ...note,
      abortSignal: call.signal,
    }));
    expect(outcome).toEqual({ error: call.signal.reason });

    expect(await listToolExecutions(20, { tenantId })).toEqual([
      expect.objectContaining({
        toolId: "memory.write",
        status: "failed",
        output: expect.objectContaining({ interrupted: "in_flight" }),
      }),
    ]);
  });

  it("keeps an approved call stopped mid-call open for its approval flow", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executeGovernedTool({
      toolId: "http.request",
      input: statusCheck.input,
      dryRun: false,
      context,
    });
    expect(pending.record.status).toBe("approval_required");
    const claimToken = "tool-interruption-approval-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "reviewer-tool-interruption",
      approvedRole: "admin",
      claimToken,
    });
    expect(claim.outcome).toBe("claimed");
    const call = new AbortController();
    mocks.executeApp.mockImplementationOnce(stoppedWhileRunning(call));

    const outcome = await settle(executeGovernedTool({
      toolId: "http.request",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      abortSignal: call.signal,
    }));
    expect(outcome).toEqual({ error: call.signal.reason });

    expect(await stored(pending.record.id)).toMatchObject({ status: "executing" });
    expect(mocks.recordOutcome).not.toHaveBeenCalled();
  });

  it("keeps a provider effect interrupted before it started open for reconciliation", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const idempotencyKey = "run-8:webhook";
    const id = governedToolExecutionId(tenantId, idempotencyKey);
    const call = new AbortController();

    const outcome = await settle(executeGovernedTool({
      ...statusCheck,
      input: {
        url: "https://example.com/hooks/asael",
        method: "POST",
        body: JSON.stringify({ message: "standup moved" }),
      },
      idempotencyKey,
      abortSignal: call.signal,
      checkpointBeforeEffect: async () => call.abort(),
    }));
    expect(outcome).toEqual({ error: call.signal.reason });

    expect(mocks.executeApp).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ status: "executing" });
  });

  it("keeps a workflow memory effect interrupted before it started open for reconciliation", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const binding = {
      workflowRunId: "wf-tool-interruption",
      planId: "plan-tool-interruption",
      planSha256: "a".repeat(64),
      planNodeId: "node-tool-interruption",
    };
    const causationId = `workflow.tool:${createHash("sha256")
      .update([
        binding.workflowRunId,
        binding.planId,
        binding.planNodeId,
        "memory.write",
      ].join("\0"))
      .digest("hex")}`;
    const idempotencyKey = `${binding.workflowRunId}:${binding.planNodeId}`;
    const id = governedToolExecutionId(tenantId, idempotencyKey);
    const call = new AbortController();

    const outcome = await settle(executeGovernedTool({
      ...note,
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: `workflow:${binding.workflowRunId}`,
        correlationId: binding.workflowRunId,
        causationId,
        contextGrantIds: [],
        capabilityGrantIds: [],
        purpose: "Test an interrupted workflow memory effect.",
      }),
      effectBinding: binding,
      idempotencyKey,
      abortSignal: call.signal,
      checkpointBeforeEffect: async () => call.abort(),
    }));
    expect(outcome).toEqual({ error: call.signal.reason });

    expect(mocks.executeApp).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ status: "executing" });
  });

  it("never runs a failed This Mac call again", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { saveToolExecution } = await import("@/lib/tools/audit-store");
    const idempotencyKey = "run-9:list-apps";
    const id = governedToolExecutionId(tenantId, idempotencyKey);
    const now = new Date().toISOString();
    await saveToolExecution({
      id,
      tenantId,
      actorId,
      toolId: "local.macos.list_apps",
      toolName: "List Apps on This Mac",
      riskLevel: 0,
      status: "failed",
      dryRun: false,
      approvalRequired: false,
      input: {},
      output: { error: "The Mac did not answer." },
      reason: "The Mac did not answer.",
      createdAt: now,
      completedAt: now,
    });

    // The Mac keys each command by its execution ID and would hand back the
    // old command, so a replay returns the failure instead.
    const replay = await executeGovernedTool({
      toolId: "local.macos.list_apps",
      input: {},
      dryRun: false,
      context,
      idempotencyKey,
    });

    expect(replay).toMatchObject({
      record: { id, status: "failed" },
      result: null,
    });
    expect(mocks.executeApp).not.toHaveBeenCalled();
  });

  it("never runs a failed call again for a replay that carries a schedule's policy lease", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = {
      toolId: "memory.search",
      input: { query: "standup notes", limit: 5 },
      dryRun: false,
      context,
      idempotencyKey: "run-10:search",
    };
    const id = governedToolExecutionId(tenantId, request.idempotencyKey);
    mocks.executeApp.mockRejectedValueOnce(new Error("Search index unavailable."));
    await executeGovernedTool(request);

    // A lease is single-use; the replay refuses before it reads the lease.
    const replay = await executeGovernedTool({
      ...request,
      policyLeaseClaim: {} as never,
    });

    expect(replay).toMatchObject({
      record: { id, status: "failed" },
      result: null,
    });
    expect(mocks.executeApp).toHaveBeenCalledTimes(1);
  });
});
