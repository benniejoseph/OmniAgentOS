import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  checkSharedRateLimit: vi.fn(),
  createRunForkFromCheckpoint: vi.fn(),
  claimQueuedAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  runAgent: vi.fn(),
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: (error: unknown) =>
    Response.json({ error: String(error) }, { status: 403 }),
}));
vi.mock("@/lib/http/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/http/rate-limit")>(
    "@/lib/http/rate-limit",
  );
  return { ...actual, checkSharedRateLimit: mocks.checkSharedRateLimit };
});
vi.mock("@/lib/runs/fork-store", async () => {
  const actual = await vi.importActual<typeof import("@/lib/runs/fork-store")>(
    "@/lib/runs/fork-store",
  );
  return { ...actual, createRunForkFromCheckpoint: mocks.createRunForkFromCheckpoint };
});
vi.mock("@/lib/runs/store", () => ({
  claimQueuedAgentRun: mocks.claimQueuedAgentRun,
  getAgentRun: mocks.getAgentRun,
}));
vi.mock("@/lib/orchestration/agent-runner", () => ({
  runAgent: mocks.runAgent,
}));

const sourceRun = {
  id: "source-run",
  tenantId: "tenant-1",
  mode: "execute" as const,
  status: "completed" as const,
  prompt: "Original task",
  messages: [{ role: "user" as const, content: "Original task" }],
  model: "gpt-test",
  agentId: "atlas",
  specialistIds: ["atlas"],
  memoryContextCount: 0,
  response: "Original response",
  startedAt: "2026-09-06T10:00:00.000Z",
  completedAt: "2026-09-06T10:01:00.000Z",
};

const targetRun = {
  ...sourceRun,
  id: "target-run",
  status: "queued" as const,
  prompt: "Corrected task",
  messages: [{ role: "user" as const, content: "Corrected task" }],
  response: undefined,
  completedAt: undefined,
};

const lineage = {
  schemaVersion: 1,
  contractKind: "run_fork_lineage",
  forkId: "fork-test",
  tenantId: "tenant-1",
  initiatingActorId: "actor-1",
  source: { runId: sourceRun.id, checkpointId: "checkpoint-1" },
  target: { runId: targetRun.id },
};

describe("checkpoint correction fork route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-1",
      actorId: "actor-1",
      role: "admin",
    });
    mocks.checkSharedRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  });

  it("creates a fresh-scoped fork and executes the new trace", async () => {
    mocks.getAgentRun
      .mockResolvedValueOnce(sourceRun)
      .mockResolvedValueOnce({
        ...targetRun,
        status: "completed",
        response: "Corrected response",
        completedAt: "2026-09-06T10:02:00.000Z",
      });
    mocks.createRunForkFromCheckpoint.mockResolvedValue({
      lineage,
      run: targetRun,
      created: true,
    });
    mocks.claimQueuedAgentRun.mockResolvedValue({ ...targetRun, status: "running" });
    mocks.runAgent.mockImplementation(async function* () {
      yield { type: "done", response: "Corrected response" };
    });
    const { POST } = await import("@/app/api/runs/[id]/fork/route");
    const response = await POST(request(), {
      params: Promise.resolve({ id: sourceRun.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      created: true,
      run: { id: targetRun.id, status: "completed", response: "Corrected response" },
    });
    expect(mocks.createRunForkFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        actorId: "actor-1",
        sourceRunId: sourceRun.id,
        checkpointId: "checkpoint-1",
        correction: "Use the exact verified result.",
        idempotencyKey: "fork-request-1",
        executionScope: expect.objectContaining({
          tenantId: "tenant-1",
          initiatingActorId: "actor-1",
          causationId: "checkpoint-1",
          contextGrantIds: [],
          capabilityGrantIds: [],
          purpose: "agent.run.checkpoint_fork",
        }),
      }),
    );
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preclaimedRunId: targetRun.id }),
    );
  });

  it("returns an existing terminal fork without executing it twice", async () => {
    const terminal = {
      ...targetRun,
      status: "completed" as const,
      response: "Already corrected",
      completedAt: "2026-09-06T10:02:00.000Z",
    };
    mocks.getAgentRun.mockResolvedValueOnce(sourceRun);
    mocks.createRunForkFromCheckpoint.mockResolvedValue({
      lineage,
      run: terminal,
      created: false,
    });
    const { POST } = await import("@/app/api/runs/[id]/fork/route");
    const response = await POST(request(), {
      params: Promise.resolve({ id: sourceRun.id }),
    });

    expect(response.status).toBe(200);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });
});

function request() {
  return new Request(`http://asael.test/api/runs/${sourceRun.id}/fork`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "fork-request-1",
    },
    body: JSON.stringify({
      checkpointId: "checkpoint-1",
      correction: "Use the exact verified result.",
      requestId: "fork-request-1",
    }),
  });
}
