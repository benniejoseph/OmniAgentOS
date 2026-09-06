import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  isLoopV2ReadOnlyCanaryCandidate,
  resolveLoopV2ReadOnlyCanaryEnrollment,
  runLoopV2ReadOnlyCanary,
  type LoopV2ReadOnlyCanaryEnrollment,
  type LoopV2RuntimeDependencies,
} from "@/lib/orchestration/loop-v2-runtime";
import type { AgentEvent } from "@/lib/orchestration/types";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Loop v2 read-only canary enrollment", () => {
  it("enrolls only an exact low-risk recent-runs request with an active pin", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test.invalid/db");
    const candidate = canaryCandidate();
    expect(isLoopV2ReadOnlyCanaryCandidate(candidate)).toBe(true);
    await expect(resolveLoopV2ReadOnlyCanaryEnrollment(
      candidate,
      vi.fn().mockResolvedValue(rollout()),
    )).resolves.toMatchObject({
      enginePin: {
        capabilityId: LOOP_V2_CAPABILITY_ID,
        engineVersionId: LOOP_V2_ENGINE_VERSION_ID,
      },
    });

    expect(isLoopV2ReadOnlyCanaryCandidate({
      ...candidate,
      contextEvidenceIds: ["memory:private"],
    })).toBe(false);
    expect(isLoopV2ReadOnlyCanaryCandidate({
      ...candidate,
      requestedAgentId: "forge",
    })).toBe(false);
    expect(isLoopV2ReadOnlyCanaryCandidate({
      ...candidate,
      message: "delete my recent runs",
    })).toBe(false);
    await expect(resolveLoopV2ReadOnlyCanaryEnrollment(
      candidate,
      vi.fn().mockResolvedValue({ ...rollout(), status: "paused" }),
    )).resolves.toBeNull();
  });
});

describe("Loop v2 read-only canary runtime", () => {
  it("executes only runs.list and commits the verified checkpoint chain", async () => {
    const harness = runtimeHarness();
    const events = await collect(runLoopV2ReadOnlyCanary(
      canaryRequest(),
      undefined,
      harness.dependencies,
    ));

    expect(harness.executeTool).toHaveBeenCalledTimes(1);
    expect(harness.executeTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "runs.list",
      input: { limit: 6 },
      dryRun: false,
      approved: false,
      executionScope: expect.objectContaining({
        tenantId: "tenant-a",
        initiatingActorId: "actor-a",
        purpose: "agent.tool.execute",
      }),
    }));
    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
      "act",
      "observe",
      "verify",
      "finish",
    ]);
    expect(harness.checkpoints.at(-1)).toMatchObject({
      terminalDisposition: "succeeded",
      retryCount: 0,
      replanCount: 0,
    });
    expect(harness.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminalDisposition: "succeeded" }),
      expect.anything(),
      expect.objectContaining({
        response: expect.stringContaining("Prior run"),
      }),
    );
    const done = events.find((event) => event.type === "done");
    expect(done).toMatchObject({ type: "done" });
    expect(done && "response" in done ? done.response : "").not.toContain(
      "Show my recent runs",
    );
    expect(harness.appendAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.failUncheckpointedRun).not.toHaveBeenCalled();
  });

  it("retries the safe read twice before recording a failed replan", async () => {
    const harness = runtimeHarness();
    harness.executeTool.mockRejectedValue(new Error("temporary read failure"));
    const events = await collect(runLoopV2ReadOnlyCanary(
      canaryRequest(),
      undefined,
      harness.dependencies,
    ));

    expect(harness.executeTool).toHaveBeenCalledTimes(3);
    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
      "act",
      "act",
      "act",
      "replan",
      "finish",
    ]);
    expect(harness.checkpoints.at(-1)).toMatchObject({
      terminalDisposition: "failed",
      retryCount: 2,
      replanCount: 1,
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "temporary read failure",
    });
    expect(harness.failUncheckpointedRun).not.toHaveBeenCalled();
  });

  it("records cancellation before terminating the run", async () => {
    const controller = new AbortController();
    const harness = runtimeHarness();
    harness.executeTool.mockImplementation(async () => {
      controller.abort();
      throw new Error("request stopped");
    });
    const events = await collect(runLoopV2ReadOnlyCanary(
      canaryRequest(),
      controller.signal,
      harness.dependencies,
    ));

    expect(harness.checkpoints.at(-1)).toMatchObject({
      toState: "finish",
      terminalDisposition: "canceled",
    });
    expect(harness.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminalDisposition: "canceled" }),
      expect.anything(),
      expect.objectContaining({
        error: expect.stringContaining("client stopped"),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "canceled" });
  });
});

function canaryCandidate() {
  return {
    tenantId: "tenant-a",
    message: "Show me my recent runs.",
    mode: "orchestrate" as const,
    route: "direct" as const,
    requiresApproval: false,
    requestUsesMessageField: true,
    contextEvidenceIds: [] as string[],
  };
}

function canaryRequest() {
  return {
    message: "Show my recent runs",
    messages: [{ role: "user" as const, content: "Show my recent runs" }],
    mode: "orchestrate" as const,
    threadId: "thread-a",
    agentId: "atlas",
    securityContext: {
      tenantId: "tenant-a",
      actorId: "actor-a",
      role: "admin" as const,
      source: "session" as const,
    },
    executionScope: createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-a",
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "request-a",
      purpose: "agent.loop.v2.read_only_canary",
    }),
    enrollment: { enginePin: enginePin() } as LoopV2ReadOnlyCanaryEnrollment,
  };
}

function runtimeHarness() {
  const checkpoints: LoopV2Checkpoint[] = [];
  const createRun = vi.fn().mockResolvedValue({
    id: "run-canary",
    tenantId: "tenant-a",
    ownerActorId: "actor-a",
    threadId: "thread-a",
    mode: "orchestrate",
    status: "running",
    prompt: "Show my recent runs",
    messages: [{ role: "user", content: "Show my recent runs" }],
    model: LOOP_V2_ENGINE_VERSION_ID,
    agentId: "atlas",
    specialistIds: ["atlas"],
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: "2026-09-06T06:00:00.000Z",
  });
  const bindRunScope = vi.fn().mockResolvedValue(canaryRequest().executionScope);
  const appendEvent = vi.fn().mockResolvedValue({
    id: "event-a",
    runId: "run-canary",
    type: "status",
    payload: {},
    createdAt: "2026-09-06T06:00:00.000Z",
  });
  const appendAssistantTurn = vi.fn().mockResolvedValue({ id: "turn-a" });
  const executeTool = vi.fn().mockResolvedValue({
    record: {
      id: "execution-a",
      tenantId: "tenant-a",
      actorId: "actor-a",
      toolId: "runs.list",
      toolName: "List Runs",
      riskLevel: 0,
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      input: { limit: 6 },
      output: {},
      createdAt: "2026-09-06T06:00:00.000Z",
      completedAt: "2026-09-06T06:00:01.000Z",
    },
    result: {
      runs: [
        {
          id: "run-canary",
          status: "running",
          prompt: "Show my recent runs",
          agentId: "atlas",
          startedAt: "2026-09-06T06:00:00.000Z",
        },
        {
          id: "run-prior",
          status: "completed",
          prompt: "Prior run",
          agentId: "forge",
          grounding: undefined,
          waitingApproval: undefined,
          startedAt: "2026-09-06T05:00:00.000Z",
          completedAt: "2026-09-06T05:01:00.000Z",
        },
      ],
    },
  });
  const persistCheckpoint = vi.fn().mockImplementation(
    async (checkpoint: LoopV2Checkpoint) => {
      checkpoints.push(checkpoint);
      return undefined as never;
    },
  );
  const finalizeRun = vi.fn().mockImplementation(
    async (checkpoint: LoopV2Checkpoint) => {
      checkpoints.push(checkpoint);
      return undefined as never;
    },
  );
  const failUncheckpointedRun = vi.fn().mockResolvedValue(true);
  const dependencies = {
    createRun,
    bindRunScope,
    appendEvent,
    appendAssistantTurn,
    executeTool,
    persistCheckpoint,
    finalizeRun,
    failUncheckpointedRun,
  } as unknown as LoopV2RuntimeDependencies;
  return {
    dependencies,
    checkpoints,
    executeTool,
    finalizeRun,
    appendAssistantTurn,
    failUncheckpointedRun,
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>) {
  const values: AgentEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function enginePin() {
  return {
    capabilityId: LOOP_V2_CAPABILITY_ID,
    engineVersionId: LOOP_V2_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_CONFIGURATION_SHA256,
    rolloutMode: "canary" as const,
    rolloutGeneration: 1,
    rolloutLifecycleRevision: 1,
  };
}

function rollout(): TenantCapabilityRollout {
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    capabilityId: LOOP_V2_CAPABILITY_ID,
    rolloutGeneration: 1,
    engineVersion: LOOP_V2_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_CONFIGURATION_SHA256,
    mode: "canary",
    status: "active",
    lifecycleRevision: 1,
    createdByActorId: "actor-a",
    activatedByActorId: "actor-a",
    activatedAt: "2026-09-06T06:00:00.000Z",
    createdAt: "2026-09-06T06:00:00.000Z",
    updatedAt: "2026-09-06T06:00:00.000Z",
  };
}
