import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  processAllTenantAgentResumeQueues: vi.fn(),
  processAllTenantDurableSpecialistQueues: vi.fn(),
  processAllTenantWorkflowQueues: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
  recordWorkerHeartbeat: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  runWithDatabaseTenantScope: async (
    _tenantId: string,
    operation: () => Promise<unknown>,
  ) => operation(),
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/observability/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/store")>()),
  createRequestTelemetry: () => ({
    requestId: "request-test",
    correlationId: "correlation-test",
  }),
  recordRuntimeEventSafely: routeMocks.recordRuntimeEventSafely,
}));

vi.mock("@/lib/orchestration/resume-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestration/resume-queue")>()),
  processAllTenantAgentResumeQueues:
    routeMocks.processAllTenantAgentResumeQueues,
}));

vi.mock("@/lib/subagents/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/subagents/worker")>()),
  processAllTenantDurableSpecialistQueues:
    routeMocks.processAllTenantDurableSpecialistQueues,
}));

vi.mock("@/lib/workflows/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/queue")>()),
  processAllTenantWorkflowQueues: routeMocks.processAllTenantWorkflowQueues,
}));

vi.mock("@/lib/operations/worker-heartbeat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/worker-heartbeat")>()),
  recordWorkerHeartbeat: routeMocks.recordWorkerHeartbeat,
}));

import { POST } from "@/app/api/workflows/tick/route";

const emptyWorkflowQueue = {
  requested: 0,
  leased: 0,
  completed: 0,
  failed: 0,
  stale: 0,
  requeued: 0,
  jobs: [],
  tenantIds: [],
  tenantResults: [],
};

const emptyResumeQueue = {
  tenantIds: [],
  tenantResults: [],
  leased: 0,
  completed: 0,
  deferred: 0,
  failed: 0,
};

const emptySpecialistQueue = {
  tenantIds: [],
  tenantResults: [],
  leased: 0,
  completed: 0,
  failed: 0,
  stale: 0,
};

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_WORKER_PROTOCOL_VERSION", "1");
  routeMocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "system",
    actorId: "dedicated-worker",
    role: "system",
  });
  routeMocks.processAllTenantWorkflowQueues
    .mockReset()
    .mockResolvedValue(emptyWorkflowQueue);
  routeMocks.processAllTenantAgentResumeQueues
    .mockReset()
    .mockResolvedValue(emptyResumeQueue);
  routeMocks.processAllTenantDurableSpecialistQueues
    .mockReset()
    .mockResolvedValue(emptySpecialistQueue);
  routeMocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
  routeMocks.recordWorkerHeartbeat.mockReset().mockImplementation(async (input) => ({
    ...input,
    recordedAt: "2026-08-26T12:00:00.000Z",
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dedicated worker heartbeat timing", () => {
  it("persists startup registration before responding without beginning scheduled work", async () => {
    const heartbeatGate = createGate();
    const order: string[] = [];
    routeMocks.recordWorkerHeartbeat.mockImplementation(async (input) => {
      order.push("heartbeat-started");
      await heartbeatGate.promise;
      order.push("heartbeat-recorded");
      return {
        ...input,
        recordedAt: "2026-08-26T12:00:00.000Z",
      };
    });
    routeMocks.processAllTenantWorkflowQueues.mockImplementation(async () => {
      order.push("scheduled-work");
      return emptyWorkflowQueue;
    });

    const responsePromise = POST(workerRequest({ startup: true }));

    await vi.waitFor(() => {
      expect(routeMocks.recordWorkerHeartbeat).toHaveBeenCalledOnce();
    });
    expect(routeMocks.processAllTenantWorkflowQueues).not.toHaveBeenCalled();

    heartbeatGate.release();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      startup: true,
      lane: "fast",
      count: 0,
    });
    expect(order).toEqual(["heartbeat-started", "heartbeat-recorded"]);
    expect(routeMocks.processAllTenantWorkflowQueues).not.toHaveBeenCalled();
    expect(routeMocks.recordWorkerHeartbeat).toHaveBeenCalledWith({
      instanceId: "worker-test",
      lane: "fast",
      phase: "startup",
      protocol: "1",
      revision: "release-test",
      target: "http://localhost",
    });
  });

  it("records an ordinary heartbeat only after scheduled work succeeds", async () => {
    const workGate = createGate();
    const order: string[] = [];
    routeMocks.processAllTenantWorkflowQueues.mockImplementation(async () => {
      order.push("scheduled-work-started");
      await workGate.promise;
      order.push("scheduled-work-completed");
      return emptyWorkflowQueue;
    });
    routeMocks.recordWorkerHeartbeat.mockImplementation(async (input) => {
      order.push("heartbeat-recorded");
      return {
        ...input,
        recordedAt: "2026-08-26T12:00:00.000Z",
      };
    });

    const responsePromise = POST(workerRequest({ startup: false }));

    await vi.waitFor(() => {
      expect(routeMocks.processAllTenantWorkflowQueues).toHaveBeenCalledOnce();
    });
    expect(routeMocks.recordWorkerHeartbeat).not.toHaveBeenCalled();

    workGate.release();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(order).toEqual([
      "scheduled-work-started",
      "scheduled-work-completed",
      "heartbeat-recorded",
    ]);
    expect(routeMocks.recordWorkerHeartbeat).toHaveBeenCalledWith({
      instanceId: "worker-test",
      lane: "fast",
      phase: "active",
      protocol: "1",
      revision: "release-test",
      target: "http://localhost",
    });
  });

  it("does not publish an ordinary heartbeat when scheduled work fails", async () => {
    routeMocks.processAllTenantWorkflowQueues.mockRejectedValue(
      new Error("scheduled work failed"),
    );

    const response = await POST(workerRequest({ startup: false }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "scheduled work failed",
    });
    expect(routeMocks.recordWorkerHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects a worker pinned to another origin before heartbeat or work", async () => {
    const response = await POST(workerRequest({
      startup: true,
      target: "https://staged.example.test",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Worker target mismatch",
    });
    expect(routeMocks.recordWorkerHeartbeat).not.toHaveBeenCalled();
    expect(routeMocks.processAllTenantWorkflowQueues).not.toHaveBeenCalled();
  });
});

function workerRequest({
  startup,
  target = "http://localhost",
}: {
  startup: boolean;
  target?: string;
}) {
  return new Request("http://localhost/api/workflows/tick", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omni-worker-instance": "worker-test",
      "x-omni-worker-protocol": "1",
      "x-omni-worker-revision": "release-test",
      "x-omni-worker-target": target,
    },
    body: JSON.stringify({
      scope: "all_tenants",
      lane: "fast",
      startup,
      timeBudgetMs: 1_000,
    }),
  });
}

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
