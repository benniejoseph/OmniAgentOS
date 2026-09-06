import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  isLoopV2ModelTextCandidate,
  resolveLoopV2ModelTextEnrollment,
  runLoopV2ModelText,
  type LoopV2ModelTextDependencies,
  type LoopV2ModelTextEnrollment,
} from "@/lib/orchestration/loop-v2-model-text-runtime";
import type { AgentEvent } from "@/lib/orchestration/types";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Loop v2 model-text enrollment", () => {
  it("accepts only bounded, isolated summary requests with an active pin", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test.invalid/db");
    const candidate = modelCandidate("a".repeat(80));
    expect(isLoopV2ModelTextCandidate(candidate)).toBe(true);
    await expect(resolveLoopV2ModelTextEnrollment(
      candidate,
      vi.fn().mockResolvedValue(rollout()),
    )).resolves.toMatchObject({
      enginePin: {
        capabilityId: LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
        engineVersionId: LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
      },
    });

    expect(isLoopV2ModelTextCandidate(modelCandidate("a".repeat(79))))
      .toBe(false);
    expect(isLoopV2ModelTextCandidate(modelCandidate("a".repeat(4_001))))
      .toBe(false);
    expect(isLoopV2ModelTextCandidate({
      ...candidate,
      contextEvidenceIds: ["memory:private"],
    })).toBe(false);
    expect(isLoopV2ModelTextCandidate({
      ...candidate,
      missionId: "mission-a",
    })).toBe(false);
    expect(isLoopV2ModelTextCandidate({
      ...candidate,
      requestedAgentId: "forge",
    })).toBe(false);
    expect(isLoopV2ModelTextCandidate({
      ...candidate,
      resumeRunId: "run-a",
    })).toBe(false);
    expect(isLoopV2ModelTextCandidate({
      ...candidate,
      message: `Please summarize: ${"a".repeat(80)}`,
    })).toBe(false);
  });
});

describe("Loop v2 model-text runtime", () => {
  it("makes one metered model call and commits the verified chain", async () => {
    const harness = runtimeHarness();
    const events = await collect(runLoopV2ModelText(
      modelRequest(),
      undefined,
      harness.dependencies,
    ));

    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(harness.generateText).toHaveBeenCalledWith(expect.objectContaining({
      input: sourceText(),
      tier: "fast",
      maxOutputTokens: 256,
      usageScope: expect.objectContaining({
        tenantId: "tenant-a",
        actorId: "actor-a",
        sourceStreamId: "run:run-model-v2",
        operation: "text_generation",
        purpose: "agent.loop.v2.model_text",
        credentialSource: "tenant_vault",
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
    expect(events.find((event) => event.type === "model")).toMatchObject({
      type: "model",
      provider: "openai",
      model: "gpt-test",
      usageReceiptRecorded: true,
      credentialSource: "tenant_vault",
    });
    expect(events.at(-1)).toEqual({
      type: "done",
      response: "A concise factual summary.",
    });
    expect(harness.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminalDisposition: "succeeded" }),
      expect.anything(),
      expect.objectContaining({
        terminalRunContract: expect.objectContaining({
          envelope: expect.objectContaining({
            terminalReceipt: expect.objectContaining({
              disposition: "unverified",
              verificationState: "unverified",
              source: "outcome_evaluator",
            }),
          }),
        }),
      }),
    );
    expect(harness.appendAssistantTurn).toHaveBeenCalledTimes(1);
    expect(harness.failUncheckpointedRun).not.toHaveBeenCalled();
  });

  it("fails through replan without issuing a second logical model call", async () => {
    const harness = runtimeHarness();
    harness.generateText.mockRejectedValue(new Error("provider unavailable"));
    const events = await collect(runLoopV2ModelText(
      modelRequest(),
      undefined,
      harness.dependencies,
    ));

    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
      "act",
      "replan",
      "finish",
    ]);
    expect(harness.checkpoints.at(-1)).toMatchObject({
      terminalDisposition: "failed",
      replanCount: 1,
    });
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: "provider unavailable",
    });
  });

  it.each([
    ["empty output", { text: "" }],
    ["missing usage receipt", {
      usageReceiptRecorded: false,
      usageReceiptId: undefined,
    }],
  ])("fails closed on %s", async (_label, generatedOverride) => {
    const harness = runtimeHarness();
    harness.generateText.mockResolvedValue({
      ...modelResult(),
      ...generatedOverride,
    });
    const events = await collect(runLoopV2ModelText(
      modelRequest(),
      undefined,
      harness.dependencies,
    ));

    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
      "act",
      "observe",
      "verify",
      "replan",
      "finish",
    ]);
    expect(harness.checkpoints.at(-1)).toMatchObject({
      terminalDisposition: "failed",
      replanCount: 1,
    });
    expect(events.at(-1)).toMatchObject({ type: "error" });
  });

  it("records cancellation as the terminal disposition", async () => {
    const controller = new AbortController();
    const harness = runtimeHarness();
    harness.generateText.mockImplementation(async () => {
      controller.abort();
      throw new Error("request stopped");
    });
    const events = await collect(runLoopV2ModelText(
      modelRequest(),
      controller.signal,
      harness.dependencies,
    ));

    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(harness.checkpoints.at(-1)).toMatchObject({
      toState: "finish",
      terminalDisposition: "canceled",
    });
    expect(harness.finalizeRun).toHaveBeenCalledWith(
      expect.objectContaining({ terminalDisposition: "canceled" }),
      expect.anything(),
      expect.objectContaining({
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
});

function sourceText() {
  return "This project stores every observable decision as a typed event, keeps tenant and actor scope explicit, and routes all tool actions through governed execution.";
}

function modelCandidate(input: string) {
  return {
    tenantId: "tenant-a",
    message: `Summarize: ${input}`,
    mode: "orchestrate" as const,
    route: "direct" as const,
    requiresApproval: false,
    requestUsesMessageField: true,
    contextEvidenceIds: [] as string[],
  };
}

function modelRequest() {
  return {
    message: `Summarize this text: ${sourceText()}`,
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
      purpose: "agent.loop.v2.model_text_canary",
    }),
    enrollment: { enginePin: enginePin() } as LoopV2ModelTextEnrollment,
  };
}

function runtimeHarness() {
  const checkpoints: LoopV2Checkpoint[] = [];
  const createRun = vi.fn().mockResolvedValue({
    id: "run-model-v2",
    tenantId: "tenant-a",
    ownerActorId: "actor-a",
    threadId: "thread-a",
    status: "running",
  });
  const bindRunScope = vi.fn().mockResolvedValue(modelRequest().executionScope);
  const appendEvent = vi.fn().mockResolvedValue({ id: "event-a" });
  const appendAssistantTurn = vi.fn().mockResolvedValue({ id: "turn-a" });
  const resolveModelAssignment = vi.fn().mockResolvedValue({
    scope: "main_agent",
    source: "tenant_assignment",
    configured: true,
    assignmentId: "assignment-a",
    provider: "openai",
    model: "gpt-test",
    allowCrossProviderFallback: false,
    warnings: [],
    reason: "test assignment",
    bind: <T,>(request: T) => request,
    withProviderApiKey: async <T,>(
      _provider: string,
      operation: (apiKey: string | undefined) => Promise<T>,
    ) => operation(undefined),
  });
  const generateText = vi.fn().mockResolvedValue(modelResult());
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
    resolveModelAssignment,
    generateText,
    persistCheckpoint,
    finalizeRun,
    failUncheckpointedRun,
  } as unknown as LoopV2ModelTextDependencies;
  return {
    dependencies,
    checkpoints,
    generateText,
    finalizeRun,
    appendAssistantTurn,
    failUncheckpointedRun,
  };
}

function modelResult() {
  const usage = {
    inputTokens: 40,
    outputTokens: 12,
    cachedInputTokens: 0,
    totalTokens: 52,
  };
  return {
    text: "A concise factual summary.",
    provider: "openai" as const,
    model: "gpt-test",
    usage,
    latencyMs: 50,
    estimatedCostUsd: 0.0001,
    costKnown: true,
    attempts: [{
      provider: "openai" as const,
      model: "gpt-test",
      status: "completed" as const,
      latencyMs: 50,
      usage,
      estimatedCostUsd: 0.0001,
      providerRequestId: "provider-request-a",
    }],
    providerRequestId: "provider-request-a",
    usageReceiptRecorded: true,
    usageReceiptId: "usage-a",
  };
}

function enginePin() {
  return {
    capabilityId: LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
    engineVersionId: LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
    rolloutMode: "canary" as const,
    rolloutGeneration: 1,
    rolloutLifecycleRevision: 1,
  };
}

function rollout(): TenantCapabilityRollout {
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    capabilityId: LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
    rolloutGeneration: 1,
    engineVersion: LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
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

async function collect(iterable: AsyncIterable<AgentEvent>) {
  const values: AgentEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
