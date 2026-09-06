import { afterEach, describe, expect, it, vi } from "vitest";

import {
  advanceLoopV2Checkpoint,
  createInitialLoopV2Checkpoint,
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
    expect(isLoopV2ReadOnlyCanaryCandidate({
      ...candidate,
      message: "Show my runs",
    })).toBe(true);
    expect(isLoopV2ReadOnlyCanaryCandidate({
      ...candidate,
      message: "yes",
      route: "clarify",
      resumeRunId: "00000000-0000-4000-8000-000000000001",
    })).toBe(true);
    expect(isLoopV2ReadOnlyCanaryCandidate({
      ...candidate,
      message: "no",
      resumeRunId: "00000000-0000-4000-8000-000000000001",
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
        terminalRunContract: expect.objectContaining({
          envelope: expect.objectContaining({
            terminalReceipt: expect.objectContaining({
              disposition: "succeeded",
              verificationState: "verified",
              source: "outcome_evaluator",
            }),
          }),
        }),
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
        terminalRunContract: expect.objectContaining({
          envelope: expect.objectContaining({
            terminalReceipt: expect.objectContaining({
              disposition: "canceled",
            }),
          }),
        }),
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "canceled" });
  });

  it("pauses an ambiguous read at a durable clarification checkpoint", async () => {
    const harness = runtimeHarness();
    const events = await collect(runLoopV2ReadOnlyCanary(
      {
        ...canaryRequest(),
        message: "Show my runs",
        messages: [{ role: "user", content: "Show my runs" }],
      },
      undefined,
      harness.dependencies,
    ));

    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "clarify",
    ]);
    expect(harness.waitForClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        toState: "clarify",
        lifecycleState: "waiting",
      }),
      expect.anything(),
      expect.objectContaining({
        clarificationPrompt: expect.stringContaining("Reply “yes”"),
      }),
    );
    expect(harness.executeTool).not.toHaveBeenCalled();
    expect(harness.finalizeRun).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      type: "clarification",
      runId: "run-canary",
      threadId: "thread-a",
      reasonCode: "ambiguous_read_target",
    });
  });

  it("resumes the same run from clarification under its original scope", async () => {
    const harness = runtimeHarness();
    const events = await collect(runLoopV2ReadOnlyCanary(
      {
        ...canaryRequest(),
        message: "yes",
        messages: [{ role: "user", content: "yes" }],
        resumeRunId: "run-canary",
      },
      undefined,
      harness.dependencies,
    ));

    expect(harness.createRun).not.toHaveBeenCalled();
    expect(harness.bindRunScope).not.toHaveBeenCalled();
    expect(harness.resumeClarification).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        runId: "run-canary",
        threadId: "thread-a",
        ownerActorId: "actor-a",
        agentId: "atlas",
        clarificationReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(harness.executeTool).toHaveBeenCalledTimes(1);
    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "clarify",
      "plan",
      "act",
      "observe",
      "verify",
      "finish",
    ]);
    expect(events[0]).toMatchObject({
      type: "run",
      runId: "run-canary",
      threadId: "thread-a",
    });
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  it.each(["understand", "plan", "act", "observe", "verify"] as const)(
    "recovers an idempotent read from the fenced %s checkpoint",
    async (state) => {
      const harness = runtimeHarness();
      const checkpoint = recoveryCheckpointAt(state);
      const fence = recoveryFence(checkpoint);
      const events = await collect(runLoopV2ReadOnlyCanary(
        {
          ...canaryRequest(),
          recovery: {
            runId: "run-canary",
            checkpoint,
            fence,
          },
        },
        undefined,
        harness.dependencies,
      ));

      expect(harness.createRun).not.toHaveBeenCalled();
      expect(harness.bindRunScope).not.toHaveBeenCalled();
      expect(harness.executeTool).toHaveBeenCalledTimes(1);
      expect(harness.executeTool).toHaveBeenCalledWith(expect.objectContaining({
        toolId: "runs.list",
        idempotencyKey: "run-canary:runs.list:1",
      }));
      expect(harness.checkpoints.map((item) => item.toState)).toEqual(
        recoveryExpectedStates(state),
      );
      expect(harness.finalizeRun).toHaveBeenCalledWith(
        expect.objectContaining({ terminalDisposition: "succeeded" }),
        expect.anything(),
        expect.objectContaining({ response: expect.stringContaining("Prior run") }),
        fence,
      );
      for (const call of harness.persistCheckpoint.mock.calls) {
        expect(call[2]).toBe(fence);
      }
      expect(harness.failUncheckpointedRun).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({ type: "done" });
    },
  );

  it("defers a stale recovery fence without mutating the run generically", async () => {
    const harness = runtimeHarness();
    const checkpoint = recoveryCheckpointAt("act");
    const fence = recoveryFence(checkpoint);
    harness.persistCheckpoint.mockRejectedValue(
      new Error("Loop v2 recovery lease fence is stale or invalid."),
    );
    harness.finalizeRun.mockRejectedValue(
      new Error("Loop v2 recovery lease fence is stale or invalid."),
    );

    await expect(collect(runLoopV2ReadOnlyCanary(
      {
        ...canaryRequest(),
        recovery: { runId: "run-canary", checkpoint, fence },
      },
      undefined,
      harness.dependencies,
    ))).rejects.toThrow("stale or invalid");
    expect(harness.failUncheckpointedRun).not.toHaveBeenCalled();
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
  const waitForClarification = vi.fn().mockImplementation(
    async (checkpoint: LoopV2Checkpoint) => {
      checkpoints.push(checkpoint);
      return undefined as never;
    },
  );
  const resumeClarification = vi.fn().mockImplementation(
    async (input: { runId: string; clarificationReceiptSha256: string }) => {
      const originalScope = canaryRequest().executionScope;
      const root = createInitialLoopV2Checkpoint({
        tenantId: "tenant-a",
        runId: input.runId,
        ownerActorId: "actor-a",
        executionScope: originalScope,
        enginePin: enginePin(),
        transitionedAt: "2026-01-01T00:00:00.000Z",
      });
      const clarification = advanceLoopV2Checkpoint({
        current: root,
        executionScope: originalScope,
        trigger: "ambiguity_detected",
        outputReceiptSha256: "a".repeat(64),
        transitionedAt: "2026-01-01T00:00:01.000Z",
      });
      const plan = advanceLoopV2Checkpoint({
        current: clarification,
        executionScope: originalScope,
        trigger: "clarified",
        inputReceiptSha256: input.clarificationReceiptSha256,
        transitionedAt: "2026-01-01T00:00:02.000Z",
      });
      checkpoints.push(root, clarification, plan);
      return {
        checkpoint: plan,
        executionScope: originalScope,
        runId: input.runId,
        threadId: "thread-a",
        inserted: true,
      };
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
    waitForClarification,
    resumeClarification,
    finalizeRun,
    failUncheckpointedRun,
  } as unknown as LoopV2RuntimeDependencies;
  return {
    dependencies,
    checkpoints,
    createRun,
    bindRunScope,
    executeTool,
    persistCheckpoint,
    waitForClarification,
    resumeClarification,
    finalizeRun,
    appendAssistantTurn,
    failUncheckpointedRun,
  };
}

function recoveryCheckpointAt(
  target: "understand" | "plan" | "act" | "observe" | "verify",
) {
  const scope = canaryRequest().executionScope;
  let current = createInitialLoopV2Checkpoint({
    tenantId: "tenant-a",
    runId: "run-canary",
    ownerActorId: "actor-a",
    executionScope: scope,
    enginePin: enginePin(),
    transitionedAt: "2026-09-06T05:00:00.000Z",
  });
  for (const [state, trigger] of [
    ["plan", "plan_bound"],
    ["act", "action_started"],
    ["observe", "action_succeeded"],
    ["verify", "observation_recorded"],
  ] as const) {
    if (target === current.toState) break;
    current = advanceLoopV2Checkpoint({
      current,
      executionScope: scope,
      trigger,
      outputReceiptSha256: "b".repeat(64),
      transitionedAt: new Date(
        Date.parse("2026-09-06T05:00:00.000Z") + current.sequence * 1_000,
      ).toISOString(),
    });
    if (target === state) break;
  }
  return current;
}

function recoveryFence(checkpoint: LoopV2Checkpoint) {
  return {
    tenantId: "tenant-a",
    runId: "run-canary",
    claimedCheckpointSha256: checkpoint.checkpointSha256,
    leaseGeneration: 1,
    claimToken: "00000000-0000-4000-8000-000000000001",
    leaseExpiresAt: "2026-09-06T06:30:00.000Z",
  } as const;
}

function recoveryExpectedStates(
  state: "understand" | "plan" | "act" | "observe" | "verify",
) {
  const states = ["understand", "plan", "act", "observe", "verify"] as const;
  return [...states.slice(states.indexOf(state) + 1), "finish"];
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
