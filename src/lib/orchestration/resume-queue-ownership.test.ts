import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelComputerObservation } from "@/lib/models/computer-observation";
import type { AgentRunContinuation } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  toolReads: new Map<string, Array<ToolExecutionRecord | undefined>>(),
  resumeRun: vi.fn(),
}));

vi.mock("@/lib/orchestration/agent-runner", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestration/agent-runner")>()),
  resumeAgentRunAfterToolApproval: mocks.resumeRun,
}));

// Each read returns the next queued record; the last one repeats.
vi.mock("@/lib/tools/audit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/audit-store")>()),
  getToolExecution: vi.fn(async (id: string) => {
    const reads = mocks.toolReads.get(id);
    if (!reads?.length) return undefined;
    return reads.length > 1 ? reads.shift() : reads[0];
  }),
}));

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-resume-ownership-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  mocks.toolReads.clear();
  mocks.resumeRun.mockReset();
  mocks.resumeRun.mockResolvedValue({ resumed: true, status: "completed" });
});

const ACTOR_ID = "tester";

function continuationFor(
  executionId: string,
  tenantId: string,
): AgentRunContinuation {
  return {
    conversationItems: [{ role: "user", content: "use this mac" }],
    instructions: "test",
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call_1",
      toolId: "computer.local",
      toolName: "This Mac",
      riskLevel: 2,
      executionId,
    },
    context: { tenantId, actorId: ACTOR_ID, role: "operator" },
    createdAt: new Date().toISOString(),
  };
}

function toolRecord(
  id: string,
  tenantId: string,
  status: ToolExecutionRecord["status"],
): ToolExecutionRecord {
  return {
    id,
    tenantId,
    actorId: ACTOR_ID,
    toolId: "computer.local",
    toolName: "This Mac",
    riskLevel: 2,
    status,
    dryRun: false,
    approvalRequired: true,
    input: {},
    output: { stored: true },
    createdAt: new Date().toISOString(),
  };
}

function observationFor(executionId: string): ModelComputerObservation {
  return {
    schemaVersion: 1,
    source: "local_macos",
    trust: "untrusted_data",
    executionId,
    operation: "screenshot",
    snapshotRevision: "rev-1",
  };
}

async function parkRun(tenantId: string, executionId: string) {
  const store = await import("@/lib/runs/store");
  const run = await store.createAgentRun({
    tenantId,
    mode: "orchestrate",
    prompt: "use this mac",
    messages: [{ role: "user", content: "use this mac" }],
  });
  const parked = await store.markAgentRunWaitingForApproval(run.id, {
    response: "partial",
    continuation: continuationFor(executionId, tenantId),
  });
  expect(parked.parked).toBe(true);
  return run;
}

async function resumeJob(tenantId: string, executionId: string) {
  const queue = await import("@/lib/operations/job-queue");
  const jobs = await queue.listOperationJobs(500, { tenantId });
  return jobs.find(
    (job) =>
      job.dedupeKey === queue.getAgentResumeJobDedupeKey(executionId),
  );
}

describe("agent resume ownership (file mode)", () => {
  it("keeps the durable queue away from a live in-request resume", async () => {
    const tenantId = "own-live";
    const executionId = "exec-own-live";
    const store = await import("@/lib/runs/store");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    const run = await parkRun(tenantId, executionId);
    const executed = toolRecord(executionId, tenantId, "executed");
    mocks.toolReads.set(executionId, [executed]);

    let entered!: () => void;
    const resumeEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.resumeRun.mockImplementationOnce(async () => {
      await store.markAgentRunResuming(run.id, { tenantId });
      entered();
      await gate;
      await store.completeAgentRun(run.id, "done", undefined, { tenantId });
      return { resumed: true, status: "completed" };
    });

    const toolExecution = {
      record: executed,
      result: { fromRequest: true },
      computerObservation: observationFor(executionId),
    };
    const inRequest = resumeQueue.resumeAgentRunInApprovalRequest({
      executionId,
      tenantId,
      toolExecution,
    });
    await resumeEntered;

    // The job was due as soon as the run parked, so without the lease the
    // worker would take it here and fail the live run as interrupted.
    const tick = await resumeQueue.processAgentResumeQueue({
      tenantId,
      limit: 10,
    });
    expect(tick.leased).toBe(0);
    await expect(store.getAgentRun(run.id, { tenantId })).resolves.toMatchObject({
      status: "resuming",
    });

    release();
    await expect(inRequest).resolves.toMatchObject({
      status: "leased",
      result: { status: "completed", agentRunId: run.id, executionId },
    });
    expect(mocks.resumeRun).toHaveBeenCalledTimes(1);
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({ executionId, tenantId, toolExecution }),
    );
    await expect(store.getAgentRun(run.id, { tenantId })).resolves.toMatchObject({
      status: "completed",
    });
    await expect(resumeJob(tenantId, executionId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("leaves a run to the worker that already holds its resume lease", async () => {
    const tenantId = "own-busy";
    const executionId = "exec-own-busy";
    const queue = await import("@/lib/operations/job-queue");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    const [workerJob] = await queue.leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      owner: "worker:busy",
    });
    expect(workerJob?.payload.executionId).toBe(executionId);

    await expect(
      resumeQueue.resumeAgentRunInApprovalRequest({
        executionId,
        tenantId,
        toolExecution: {
          record: toolRecord(executionId, tenantId, "executed"),
          computerObservation: observationFor(executionId),
        },
        leaseRetry: { attempts: 3, delayMs: 1 },
      }),
    ).resolves.toEqual({ status: "busy" });
    expect(mocks.resumeRun).not.toHaveBeenCalled();
    await expect(resumeJob(tenantId, executionId)).resolves.toMatchObject({
      id: workerJob.id,
      status: "running",
      leaseOwner: "worker:busy",
      attempt: 1,
    });
  });

  it("claims the job once the worker defers it", async () => {
    const tenantId = "own-retry";
    const executionId = "exec-own-retry";
    const queue = await import("@/lib/operations/job-queue");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    const executed = toolRecord(executionId, tenantId, "executed");
    mocks.toolReads.set(executionId, [executed]);
    const [workerJob] = await queue.leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      owner: "worker:retry",
    });
    setTimeout(() => {
      void queue.deferOperationJob(workerJob.id, "worker:retry", {
        tenantId,
        delaySeconds: 30,
      });
    }, 20);

    await expect(
      resumeQueue.resumeAgentRunInApprovalRequest({
        executionId,
        tenantId,
        toolExecution: {
          record: executed,
          computerObservation: observationFor(executionId),
        },
        leaseRetry: { attempts: 200, delayMs: 5 },
      }),
    ).resolves.toMatchObject({
      status: "leased",
      result: { status: "completed" },
    });
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        toolExecution: expect.objectContaining({
          computerObservation: observationFor(executionId),
        }),
      }),
    );
  });

  it("claims a job deferred into the future", async () => {
    const tenantId = "own-deferred";
    const executionId = "exec-own-deferred";
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    mocks.toolReads.set(executionId, [
      toolRecord(executionId, tenantId, "approval_required"),
    ]);
    const tick = await resumeQueue.processAgentResumeQueue({ tenantId });
    expect(tick.deferred).toBe(1);
    const deferred = await resumeJob(tenantId, executionId);
    expect(Date.parse(deferred?.runAt || "")).toBeGreaterThan(Date.now());

    const executed = toolRecord(executionId, tenantId, "executed");
    mocks.toolReads.set(executionId, [executed]);
    await expect(
      resumeQueue.resumeAgentRunInApprovalRequest({
        executionId,
        tenantId,
        toolExecution: {
          record: executed,
          computerObservation: observationFor(executionId),
        },
      }),
    ).resolves.toMatchObject({
      status: "leased",
      result: { status: "completed" },
    });
    await expect(resumeJob(tenantId, executionId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it("resumes directly when the run has no live resume job", async () => {
    const tenantId = "own-absent";
    const executionId = "exec-own-absent";
    const queue = await import("@/lib/operations/job-queue");
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    await queue.cancelOperationJobByDedupeKey(
      queue.getAgentResumeJobDedupeKey(executionId),
      "Retired for the test.",
      { tenantId },
    );
    const toolExecution = {
      record: toolRecord(executionId, tenantId, "executed"),
      computerObservation: observationFor(executionId),
    };

    await expect(
      resumeQueue.resumeAgentRunInApprovalRequest({
        executionId,
        tenantId,
        toolExecution,
      }),
    ).resolves.toEqual({ status: "unqueued", resumed: true });
    expect(mocks.resumeRun).toHaveBeenCalledTimes(1);
    expect(mocks.resumeRun).toHaveBeenCalledWith({
      executionId,
      tenantId,
      toolExecution,
    });
    await expect(resumeJob(tenantId, executionId)).resolves.toMatchObject({
      status: "canceled",
    });
  });

  it("resumes from the stored record when the request's result is for another execution", async () => {
    const tenantId = "own-mismatch";
    const executionId = "exec-own-mismatch";
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    const stored = toolRecord(executionId, tenantId, "executed");
    mocks.toolReads.set(executionId, [stored]);

    await expect(
      resumeQueue.resumeAgentRunInApprovalRequest({
        executionId,
        tenantId,
        toolExecution: {
          record: toolRecord("exec-someone-else", tenantId, "executed"),
          computerObservation: observationFor("exec-someone-else"),
        },
      }),
    ).resolves.toMatchObject({ status: "leased" });
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        toolExecution: {
          record: stored,
          result: { stored: true },
          computerObservation: undefined,
        },
      }),
    );
  });

  it("resumes worker-leased jobs from the stored record without an observation", async () => {
    const tenantId = "own-worker";
    const executionId = "exec-own-worker";
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    const stored = toolRecord(executionId, tenantId, "executed");
    mocks.toolReads.set(executionId, [stored]);

    const tick = await resumeQueue.processAgentResumeQueue({ tenantId });
    expect(tick.completed).toBe(1);
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId,
        toolExecution: {
          record: stored,
          result: { stored: true },
          computerObservation: undefined,
        },
      }),
    );
  });

  it("polls a pending approval slowly and an executing tool quickly", async () => {
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    const pendingTenant = "own-poll-pending";
    const pendingExecution = "exec-own-poll-pending";
    await parkRun(pendingTenant, pendingExecution);
    mocks.toolReads.set(pendingExecution, [
      toolRecord(pendingExecution, pendingTenant, "approval_required"),
    ]);
    const executingTenant = "own-poll-executing";
    const executingExecution = "exec-own-poll-executing";
    await parkRun(executingTenant, executingExecution);
    mocks.toolReads.set(executingExecution, [
      toolRecord(executingExecution, executingTenant, "executing"),
    ]);

    const before = Date.now();
    const pending = await resumeQueue.processAgentResumeQueue({
      tenantId: pendingTenant,
    });
    const executing = await resumeQueue.processAgentResumeQueue({
      tenantId: executingTenant,
    });
    const after = Date.now();

    expect(pending.jobs[0]).toMatchObject({
      status: "deferred",
      message: "Waiting for the tool approval decision.",
    });
    expect(executing.jobs[0]).toMatchObject({
      status: "deferred",
      message: "Waiting for the approved tool execution to finish.",
    });
    const pendingJob = await resumeJob(pendingTenant, pendingExecution);
    const executingJob = await resumeJob(executingTenant, executingExecution);
    expect(pendingJob).toMatchObject({ status: "queued", attempt: 0 });
    expect(executingJob).toMatchObject({ status: "queued", attempt: 0 });
    const pendingRunAt = Date.parse(pendingJob?.runAt || "");
    const executingRunAt = Date.parse(executingJob?.runAt || "");
    expect(pendingRunAt).toBeGreaterThanOrEqual(
      before + resumeQueue.PENDING_APPROVAL_RESUME_POLL_SECONDS * 1000,
    );
    expect(pendingRunAt).toBeLessThanOrEqual(
      after + resumeQueue.PENDING_APPROVAL_RESUME_POLL_SECONDS * 1000,
    );
    expect(resumeQueue.PENDING_APPROVAL_RESUME_POLL_SECONDS).toBe(300);
    expect(executingRunAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(executingRunAt).toBeLessThanOrEqual(after + 30_000);
    expect(mocks.resumeRun).not.toHaveBeenCalled();
  });

  it("wakes a pending-approval job whose decision landed while it was leased", async () => {
    const tenantId = "own-decided";
    const executionId = "exec-own-decided";
    const resumeQueue = await import("@/lib/orchestration/resume-queue");
    await parkRun(tenantId, executionId);
    mocks.toolReads.set(executionId, [
      toolRecord(executionId, tenantId, "approval_required"),
      toolRecord(executionId, tenantId, "executed"),
    ]);

    const tick = await resumeQueue.processAgentResumeQueue({ tenantId });
    expect(tick.jobs[0]).toMatchObject({
      status: "deferred",
      message: expect.stringMatching(/decided while the job was leased/),
    });
    const job = await resumeJob(tenantId, executionId);
    expect(job).toMatchObject({ status: "queued", attempt: 0 });
    expect(Date.parse(job?.runAt || "")).toBeLessThanOrEqual(Date.now());

    const next = await resumeQueue.processAgentResumeQueue({ tenantId });
    expect(next.completed).toBe(1);
    expect(mocks.resumeRun).toHaveBeenCalledTimes(1);
  });
});
