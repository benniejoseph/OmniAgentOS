import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import {
  AgentRunNotActiveError,
  assertAgentRunAcceptsToolEffect,
  readAgentRunStatus,
} from "@/lib/runs/active-run-fence";
import { AgentRunTerminatedError } from "@/lib/runs/cancellation";
import type {
  AgentRunContinuation,
  RunLedger,
  RunStatus,
} from "@/lib/runs/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const TENANT_ID = "tenant-run-fence";
const OWNER_ID = "owner-run-fence";
const WITHDRAWN_REASON =
  "Withdrawn: the agent run was canceled before this action was approved.";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-run-fence-"),
  );
  delete process.env.DATABASE_URL;
});

describe("active agent run fence (file mode)", () => {
  it.each(["running", "waiting_approval", "resuming"] as const)(
    "accepts a tool effect for a %s run",
    async (runStatus) => {
      const run = await startRun();
      await writeStoredRunStatus(run.id, runStatus);

      await expect(assertAgentRunAcceptsToolEffect({
        runId: run.id,
        tenantId: TENANT_ID,
      })).resolves.toBeUndefined();
    },
  );

  it.each(["completed", "failed", "canceled"] as const)(
    "refuses a tool effect for a %s run",
    async (runStatus) => {
      const run = await startRun();
      await writeStoredRunStatus(run.id, runStatus);

      const refusal = assertAgentRunAcceptsToolEffect({
        runId: run.id,
        tenantId: TENANT_ID,
      });
      await expect(refusal).rejects.toBeInstanceOf(AgentRunNotActiveError);
      await expect(refusal).rejects.toMatchObject({
        code: "agent_run_not_active",
        runId: run.id,
        runStatus,
      });
    },
  );

  it("reads a run's status only in the run's tenant", async () => {
    const run = await startRun();
    await writeStoredRunStatus(run.id, "canceled");

    await expect(readAgentRunStatus({ runId: run.id, tenantId: TENANT_ID }))
      .resolves.toBe("canceled");
    await expect(readAgentRunStatus({
      runId: run.id,
      tenantId: "tenant-run-fence-other",
    })).resolves.toBeUndefined();
  });

  it("accepts a run the trimmed file ledger no longer holds", async () => {
    await expect(assertAgentRunAcceptsToolEffect({
      runId: "run-fence-trimmed",
      tenantId: TENANT_ID,
    })).resolves.toBeUndefined();
  });

  it("refuses to check outside the claiming transaction in database mode", async () => {
    process.env.DATABASE_URL = "postgres://fence:fence@127.0.0.1:1/fence";
    try {
      await expect(assertAgentRunAcceptsToolEffect({
        runId: "run-fence-database",
        tenantId: TENANT_ID,
      })).rejects.toThrow(
        "The active-run check must run inside the claiming transaction.",
      );
    } finally {
      delete process.env.DATABASE_URL;
    }
  });

  it.each(["completed", "failed", "canceled"] as const)(
    "records no tool effect for a %s run",
    async (runStatus) => {
      const store = await import("@/lib/tools/audit-store");
      const run = await startRun();
      await writeStoredRunStatus(run.id, runStatus);
      const pending = pendingRecord(`save-${runStatus}`);
      const claim = executingRecord(`claim-${runStatus}`);

      await expect(store.saveToolExecution(pending, {
        activeAgentRun: { runId: run.id },
      })).rejects.toBeInstanceOf(AgentRunNotActiveError);
      await expect(store.claimIdempotentToolExecution(claim, {
        idempotencyKey: `${run.id}:claim`,
        activeAgentRun: { runId: run.id },
      })).rejects.toBeInstanceOf(AgentRunNotActiveError);

      await expect(store.getToolExecution(pending.id, { tenantId: TENANT_ID }))
        .resolves.toBeUndefined();
      await expect(store.getToolExecution(claim.id, { tenantId: TENANT_ID }))
        .resolves.toBeUndefined();
    },
  );

  it("records tool effects for an active run", async () => {
    const store = await import("@/lib/tools/audit-store");
    const run = await startRun();

    await expect(store.saveToolExecution(pendingRecord("save-running"), {
      activeAgentRun: { runId: run.id },
    })).resolves.toMatchObject({ status: "approval_required" });
    await expect(store.claimIdempotentToolExecution(
      executingRecord("claim-running"),
      {
        idempotencyKey: `${run.id}:claim`,
        activeAgentRun: { runId: run.id },
      },
    )).resolves.toMatchObject({ outcome: "claimed" });
  });

  it("binds a sealed approval to its run without exposing the binding", async () => {
    const store = await import("@/lib/tools/audit-store");
    const record = await boundPending("sealed-binding", "run-fence-sealed");

    expect(record.output).toMatchObject({ __agentRunId: "run-fence-sealed" });
    expect(store.publicToolExecution(record).output).not.toHaveProperty(
      "__agentRunId",
    );
    const unbound = pendingRecord("sealed-unbound");
    expect(
      store.sealToolExecutionInput(unbound.input, unbound, "fence-fingerprint"),
    ).not.toHaveProperty("__agentRunId");
  });
});

describe("canceling an agent run (file mode)", () => {
  it("withdraws the run's pending approvals and leaves every other record alone", async () => {
    const store = await import("@/lib/tools/audit-store");
    const runs = await import("@/lib/runs/store");
    const run = await startRun();
    const otherRun = await startRun();
    const bound = await store.saveToolExecution(
      await boundPending("withdraw-bound", run.id),
    );
    const legacy = await store.saveToolExecution(
      pendingRecord("withdraw-legacy"),
    );
    const claimed = await store.saveToolExecution(
      await boundPending("withdraw-claimed", run.id),
    );
    await expect(store.approveAndClaimToolExecution({
      id: claimed.id,
      tenantId: TENANT_ID,
      approvedBy: OWNER_ID,
      approvedRole: "admin",
      claimToken: "withdraw-claimed-token",
    })).resolves.toMatchObject({ outcome: "claimed" });
    const otherRunRecord = await store.saveToolExecution(
      await boundPending("withdraw-other-run", otherRun.id),
    );
    const unbound = await store.saveToolExecution(
      pendingRecord("withdraw-unbound"),
    );
    const foreignTenant = await store.saveToolExecution({
      ...(await boundPending("withdraw-foreign-tenant", run.id)),
      tenantId: "tenant-run-fence-other",
    });
    await runs.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor(legacy.id),
    });

    await expect(runs.cancelAgentRun(run.id, "Stop this run.", {
      tenantId: TENANT_ID,
    })).resolves.toBe(true);

    for (const withdrawn of [bound, legacy]) {
      const stored = await store.getToolExecution(withdrawn.id, {
        tenantId: TENANT_ID,
      });
      expect(stored).toMatchObject({
        status: "rejected",
        approvalDecision: "rejected",
        approvalReason: WITHDRAWN_REASON,
        reason: WITHDRAWN_REASON,
        completedAt: expect.any(String),
      });
      expect(stored?.output).toBeUndefined();
      expect(stored?.input).toEqual(withdrawn.input);
      const events = await listStreamEvents(
        `tool_execution:${withdrawn.id}`,
        { tenantId: TENANT_ID },
      );
      expect(events.filter(
        (event) => event.payload.operation === "withdrawn",
      )).toEqual([
        expect.objectContaining({
          type: "tool.execution.upserted",
          payload: expect.objectContaining({
            executionId: withdrawn.id,
            status: "rejected",
            approvalDecision: "rejected",
          }),
        }),
      ]);
    }
    await expect(store.getToolExecution(claimed.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "executing" });
    for (const untouched of [otherRunRecord, unbound]) {
      await expect(store.getToolExecution(untouched.id, { tenantId: TENANT_ID }))
        .resolves.toMatchObject({ status: "approval_required" });
    }
    await expect(store.getToolExecution(foreignTenant.id, {
      tenantId: "tenant-run-fence-other",
    })).resolves.toMatchObject({ status: "approval_required" });

    await expect(store.approveAndClaimToolExecution({
      id: bound.id,
      tenantId: TENANT_ID,
      approvedBy: OWNER_ID,
      approvedRole: "admin",
      claimToken: "withdraw-late-token",
    })).resolves.toMatchObject({ outcome: "conflict" });
  });
});

describe("canceling an agent run while its approved action runs (file mode)", () => {
  it("leaves the action's execution claim alone", async () => {
    const store = await import("@/lib/tools/audit-store");
    const runs = await import("@/lib/runs/store");
    const run = await startRun();
    const approved = await store.saveToolExecution(
      await boundPending("withdraw-approved-running", run.id),
    );
    await expect(store.approveAndClaimToolExecution({
      id: approved.id,
      tenantId: TENANT_ID,
      approvedBy: OWNER_ID,
      approvedRole: "admin",
      claimToken: "withdraw-approved-running-token",
    })).resolves.toMatchObject({ outcome: "claimed" });
    await runs.markAgentRunWaitingForApproval(run.id, {
      response: "partial",
      continuation: continuationFor(approved.id),
    });

    await expect(runs.cancelAgentRun(run.id, "Stop this run.", {
      tenantId: TENANT_ID,
    })).resolves.toBe(true);

    await expect(store.getToolExecution(approved.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({
        status: "executing",
        output: {
          __executionClaim: { token: "withdraw-approved-running-token" },
        },
      });
  });
});

describe("approving an action of a stopped agent run (file mode)", () => {
  it("withdraws the approval of a run canceled without withdrawing it", async () => {
    const store = await import("@/lib/tools/audit-store");
    const run = await startRun();
    const pending = await store.saveToolExecution(
      await boundPending("approve-canceled", run.id),
    );
    // A direct status write stands in for a cancel that could not withdraw.
    await writeStoredRunStatus(run.id, "canceled");

    const claim = await store.approveAndClaimToolExecution({
      id: pending.id,
      tenantId: TENANT_ID,
      approvedBy: OWNER_ID,
      approvedRole: "admin",
      claimToken: "approve-canceled-token",
    });

    expect(claim).toMatchObject({
      outcome: "conflict",
      record: {
        id: pending.id,
        status: "rejected",
        approvalDecision: "rejected",
        reason: WITHDRAWN_REASON,
      },
    });
    expect(claim.record?.output).toBeUndefined();
    await expect(store.getToolExecution(pending.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "rejected", reason: WITHDRAWN_REASON });
    const events = await listStreamEvents(`tool_execution:${pending.id}`, {
      tenantId: TENANT_ID,
    });
    expect(events.map((event) => event.payload.operation)).toContain(
      "withdrawn",
    );
  });

  it.each(["running", "waiting_approval", "completed", "failed"] as const)(
    "still claims the approval of a %s run",
    async (runStatus) => {
      const store = await import("@/lib/tools/audit-store");
      const run = await startRun();
      const pending = await store.saveToolExecution(
        await boundPending(`approve-${runStatus}`, run.id),
      );
      await writeStoredRunStatus(run.id, runStatus);

      await expect(store.approveAndClaimToolExecution({
        id: pending.id,
        tenantId: TENANT_ID,
        approvedBy: OWNER_ID,
        approvedRole: "admin",
        claimToken: `approve-${runStatus}-token`,
      })).resolves.toMatchObject({
        outcome: "claimed",
        record: { status: "executing" },
      });
    },
  );
});

describe("governed tool execution for a stopped agent run (file mode)", () => {
  it.each([
    ["without an idempotency key", {}],
    ["under an idempotency key", { idempotencyKey: "fence-call:list" }],
  ])("opens no approval for a canceled run %s", async (_label, keyed) => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const run = await startRun();
    await writeStoredRunStatus(run.id, "canceled");

    await expect(executeGovernedTool({
      toolId: "runs.list",
      input: { limit: 1 },
      dryRun: false,
      forceApproval: true,
      context: executorContext(),
      executionScope: executorScope(run.id),
      agentRunId: run.id,
      ...keyed,
    })).rejects.toBeInstanceOf(AgentRunNotActiveError);

    expect(await recordsBoundTo(run.id)).toEqual([]);
  });

  it("binds an approval opened for an active run to that run", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const run = await startRun();

    const pending = await executeGovernedTool({
      toolId: "runs.list",
      input: { limit: 1 },
      dryRun: false,
      forceApproval: true,
      context: executorContext(),
      executionScope: executorScope(run.id),
      agentRunId: run.id,
    });

    expect(pending.record.status).toBe("approval_required");
    expect((await recordsBoundTo(run.id)).map((record) => record.id)).toEqual([
      pending.record.id,
    ]);
    expect(store.publicToolExecution(pending.record).output).not.toHaveProperty(
      "__agentRunId",
    );
  });

  it.each([
    ["an idempotent", "completed"],
    ["an idempotent", "failed"],
    ["a non-idempotent", "completed"],
    ["a non-idempotent", "canceled"],
  ] as const)(
    "starts %s effect for no %s run",
    async (kind, runStatus) => {
      const { executeGovernedTool } = await import("@/lib/tools/executor");
      const run = await startRun();
      await writeStoredRunStatus(run.id, runStatus);
      const before = await toolLedgerSize();

      await expect(executeGovernedTool({
        toolId: "runs.list",
        input: { limit: 1 },
        dryRun: false,
        context: executorContext(),
        executionScope: executorScope(run.id),
        agentRunId: run.id,
        ...(kind === "an idempotent"
          ? { idempotencyKey: `${run.id}:call-1` }
          : {}),
      })).rejects.toBeInstanceOf(AgentRunNotActiveError);

      expect(await toolLedgerSize()).toBe(before);
    },
  );

  it.each(["an idempotent", "a non-idempotent"] as const)(
    "runs %s effect for an active run",
    async (kind) => {
      const { executeGovernedTool } = await import("@/lib/tools/executor");
      const run = await startRun();
      const before = await toolLedgerSize();

      await expect(executeGovernedTool({
        toolId: "runs.list",
        input: { limit: 1 },
        dryRun: false,
        context: executorContext(),
        executionScope: executorScope(run.id),
        agentRunId: run.id,
        ...(kind === "an idempotent"
          ? { idempotencyKey: `${run.id}:call-1` }
          : {}),
      })).resolves.toMatchObject({ record: { status: "executed" } });

      expect(await toolLedgerSize()).toBe(before + 1);
    },
  );

  it("starts nothing once the run's stop signal fired", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const run = await startRun();
    const stop = new AbortController();
    stop.abort(new AgentRunTerminatedError(run.id, "canceled"));
    const before = await toolLedgerSize();

    for (const forceApproval of [false, true]) {
      await expect(executeGovernedTool({
        toolId: "runs.list",
        input: { limit: 1 },
        dryRun: false,
        forceApproval,
        context: executorContext(),
        executionScope: executorScope(run.id),
        agentRunId: run.id,
        abortSignal: stop.signal,
      })).rejects.toBeInstanceOf(AgentRunTerminatedError);
    }

    expect(await toolLedgerSize()).toBe(before);
  });

  it("reports a refused workflow memory effect as a stopped run", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const run = await startRun();
    await writeStoredRunStatus(run.id, "completed");
    const binding = {
      workflowRunId: "wf-run-fence",
      planId: "plan-run-fence",
      planSha256: "a".repeat(64),
      planNodeId: "node-run-fence",
    };
    const causationId = `workflow.tool:${createHash("sha256")
      .update([
        binding.workflowRunId,
        binding.planId,
        binding.planNodeId,
        "memory.write",
      ].join("\0"))
      .digest("hex")}`;
    const before = await toolLedgerSize();

    await expect(executeGovernedTool({
      toolId: "memory.write",
      input: { title: "Fence", content: "Refused" },
      dryRun: false,
      context: executorContext(),
      executionScope: createExecutionScope({
        tenantId: TENANT_ID,
        initiatingActorId: OWNER_ID,
        executingPrincipalType: "system",
        executingPrincipalId: `workflow:${binding.workflowRunId}`,
        correlationId: run.id,
        causationId,
        contextGrantIds: [],
        capabilityGrantIds: [],
        purpose: "Test the active agent run fence.",
      }),
      effectBinding: binding,
      agentRunId: run.id,
      idempotencyKey: `${run.id}:memory-effect`,
    })).rejects.toBeInstanceOf(AgentRunNotActiveError);

    expect(await toolLedgerSize()).toBe(before);
  });
});

let runSequence = 0;

async function startRun() {
  const { createAgentRun } = await import("@/lib/runs/store");
  runSequence += 1;
  return createAgentRun({
    id: `run-fence-${runSequence}`,
    tenantId: TENANT_ID,
    actorId: OWNER_ID,
    mode: "orchestrate",
    prompt: "Fence test",
    messages: [{ role: "user", content: "Fence test" }],
  });
}

/** Writes a run status directly, without the store's cancel side effects. */
async function writeStoredRunStatus(runId: string, runStatus: RunStatus) {
  await updateJsonFile<RunLedger>(
    getDataPath("runs.json"),
    { runs: [], events: [] },
    (ledger) => ({
      ...ledger,
      runs: ledger.runs.map((run) =>
        run.id === runId ? { ...run, status: runStatus } : run,
      ),
    }),
  );
}

async function toolLedger() {
  return readJsonFile<{ records: ToolExecutionRecord[] }>(
    getDataPath("tools.json"),
    { records: [] },
  );
}

async function toolLedgerSize() {
  return (await toolLedger()).records.length;
}

async function recordsBoundTo(runId: string) {
  return (await toolLedger()).records.filter(
    (record) =>
      (record.output as Record<string, unknown> | undefined)?.__agentRunId ===
        runId,
  );
}

function pendingRecord(id: string): ToolExecutionRecord {
  return {
    id,
    tenantId: TENANT_ID,
    actorId: OWNER_ID,
    toolId: "http.request",
    toolName: "HTTP request",
    riskLevel: 2,
    status: "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: { url: "https://8.8.8.8/example", method: "POST" },
    createdAt: new Date().toISOString(),
  };
}

function executingRecord(id: string): ToolExecutionRecord {
  return {
    ...pendingRecord(id),
    status: "executing",
    approvalRequired: false,
    output: {
      __executionClaim: {
        token: `${id}-token`,
        claimedAt: new Date().toISOString(),
      },
    },
  };
}

async function boundPending(
  id: string,
  runId: string,
): Promise<ToolExecutionRecord> {
  const { sealToolExecutionInput } = await import("@/lib/tools/audit-store");
  const record = pendingRecord(id);
  return {
    ...record,
    output: sealToolExecutionInput(record.input, record, "fence-fingerprint", {
      agentRunId: runId,
    }),
  };
}

function continuationFor(executionId: string): AgentRunContinuation {
  return {
    conversationItems: [{ role: "user", content: "Fence test" }],
    instructions: "test",
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call-fence",
      toolId: "http.request",
      toolName: "HTTP request",
      riskLevel: 2,
      executionId,
    },
    context: { tenantId: TENANT_ID, actorId: OWNER_ID, role: "admin" },
    createdAt: new Date().toISOString(),
  };
}

function executorContext() {
  return {
    tenantId: TENANT_ID,
    actorId: OWNER_ID,
    role: "admin" as const,
    source: "default" as const,
  };
}

function executorScope(runId: string) {
  return createExecutionScope({
    tenantId: TENANT_ID,
    initiatingActorId: OWNER_ID,
    executingPrincipalType: "user",
    executingPrincipalId: OWNER_ID,
    correlationId: runId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "Test the active agent run fence.",
  });
}
