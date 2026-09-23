import { afterEach, describe, expect, it, vi } from "vitest";

import {
  LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID,
  LOOP_V2_CONTEXT_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  isLoopV2ContextTextCandidate,
  isLoopV2ModelTextCandidate,
  resolveLoopV2ContextTextEnrollment,
  resolveLoopV2ModelTextEnrollment,
  runLoopV2ModelText,
  type LoopV2ModelTextDependencies,
  type LoopV2ModelTextEnrollment,
} from "@/lib/orchestration/loop-v2-model-text-runtime";
import { buildBuiltInAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { buildLoopV2ContextBindingV1 } from "@/lib/orchestration/loop-v2-context-contract";
import {
  buildLoopV2ContextManifest,
  loopV2ContextManifestSha256,
} from "@/lib/orchestration/loop-v2-outcome";
import type { AgentEvent } from "@/lib/orchestration/types";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

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

  it("uses a separate context engine only for an explicit bounded scope", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://test.invalid/db");
    const candidate = {
      ...modelCandidate("a".repeat(80)),
      contextScope: "session" as const,
    };
    expect(isLoopV2ModelTextCandidate(candidate)).toBe(false);
    expect(isLoopV2ContextTextCandidate(candidate)).toBe(true);
    await expect(resolveLoopV2ContextTextEnrollment(
      candidate,
      vi.fn().mockResolvedValue(contextRollout()),
    )).resolves.toMatchObject({
      enginePin: {
        capabilityId: LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID,
        engineVersionId: LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID,
      },
    });
    expect(isLoopV2ContextTextCandidate({
      ...candidate,
      contextScope: "explicit_selection",
      contextEvidenceIds: [],
    })).toBe(false);
    expect(isLoopV2ContextTextCandidate({
      ...candidate,
      contextScope: "explicit_selection",
      contextEvidenceIds: Array.from({ length: 9 }, (_, index) =>
        `memory:${index}`
      ),
    })).toBe(false);
    expect(isLoopV2ContextTextCandidate({
      ...candidate,
      contextScope: "mission",
    })).toBe(false);
    expect(isLoopV2ContextTextCandidate({
      ...candidate,
      contextScope: "mission",
      missionId: "mission-a",
    })).toBe(true);
    expect(isLoopV2ContextTextCandidate({
      ...candidate,
      contextScope: "personal",
    })).toBe(true);
  });
});

describe("Loop v2 model-text root identity", () => {
  it("rejects a server run id outside its execution-scope correlation", async () => {
    const harness = runtimeHarness();
    await expect(collect(runLoopV2ModelText(
      { ...modelRequest(), runId: "run-other" },
      undefined,
      harness.dependencies,
    ))).rejects.toThrow(/root run ID.*execution scope/i);

    expect(harness.createRun).not.toHaveBeenCalled();
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
    expect(harness.appendIdentityPin).toHaveBeenCalledWith(
      "run-model-v2",
      expect.objectContaining({
        logicalAgentId: "atlas",
        definitionVersionId: "definition:built-in:atlas:v2",
      }),
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
    expect(harness.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "run-model-v2" }),
    );
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

  it("forwards the exact request actor binding to the identity pin write", async () => {
    const harness = runtimeHarness();
    const requestActorBinding = {
      version: 1 as const,
      kind: "auth_user" as const,
      authUserId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      canonicalActorId: "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      legacyOwnerActorIds: ["owner@example.test"],
      readableOwnerActorIds: [
        "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        "owner@example.test",
      ],
    };

    await collect(runLoopV2ModelText(
      { ...modelRequest(), requestActorBinding },
      undefined,
      harness.dependencies,
    ));

    expect(harness.appendIdentityPin).toHaveBeenCalledWith(
      "run-model-v2",
      expect.anything(),
      expect.objectContaining({ requestActorBinding }),
    );
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

  it("binds reviewed context before the context-text model call", async () => {
    const harness = runtimeHarness();
    const request = contextModelRequest();
    const prepared = preparedContext(request);
    harness.prepareContext.mockResolvedValue(prepared);
    const events = await collect(runLoopV2ModelText(
      request,
      undefined,
      harness.dependencies,
    ));

    expect(harness.prepareContext).toHaveBeenCalledTimes(1);
    expect(harness.generateText).toHaveBeenCalledTimes(1);
    expect(harness.generateText).toHaveBeenCalledWith(expect.objectContaining({
      input: "context-bound model input",
      usageScope: expect.objectContaining({
        purpose: "agent.loop.v2.context_text",
      }),
    }));
    expect(harness.checkpoints[0]).toMatchObject({
      contextScope: "session",
      contextBindingSha256: prepared.contextBinding.bindingSha256,
      enginePin: {
        capabilityId: LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID,
      },
    });
    expect(harness.checkpoints.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
      "act",
      "observe",
      "verify",
      "finish",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "done" });
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
    runId: "run-model-v2",
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
      correlationId: "run-model-v2",
      purpose: "agent.loop.v2.model_text_canary",
    }),
    enrollment: { enginePin: enginePin() } as LoopV2ModelTextEnrollment,
  };
}

function contextModelRequest() {
  const agentIdentity = buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId: "tenant-a",
    controllerActorId: "actor-a",
  });
  return {
    ...modelRequest(),
    messages: [
      { role: "user" as const, content: "Earlier context." },
      { role: "user" as const, content: `Summarize this text: ${sourceText()}` },
    ],
    contextScope: "session" as const,
    agentIdentity,
    executionScope: createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-a",
      executingPrincipalType: "agent",
      executingPrincipalId: agentIdentity.principal.principalId,
      correlationId: "run-model-v2",
      contextGrantIds: agentIdentity.principal.contextGrantIds,
      capabilityGrantIds: agentIdentity.principal.capabilityGrantIds,
      purpose: "agent.loop.v2.context_text_canary",
    }),
    enrollment: {
      enginePin: contextEnginePin(),
    } as LoopV2ModelTextEnrollment,
  };
}

function preparedContext(request: ReturnType<typeof contextModelRequest>) {
  const contextManifest = buildLoopV2ContextManifest({
    runId: "run-model-v2",
    querySha256: sourceContractSha256(sourceText()),
    contextScope: "session",
    selectedContext: [],
    userInclusionIds: [],
    userExclusionIds: [],
    compiledContextSha256: sourceContractSha256("Earlier context."),
    contextTokenCount: 16,
    providerId: "openai",
    compilerVersionId: "context-compiler-authorized:1",
  });
  const contextBinding = buildLoopV2ContextBindingV1({
    tenantId: "tenant-a",
    runId: "run-model-v2",
    ownerActorId: "actor-a",
    agentPrincipalId: request.agentIdentity.principal.principalId,
    contextScope: "session",
    authoritySha256: sourceContractSha256("session"),
    executionScope: request.executionScope,
    querySha256: sourceContractSha256(sourceText()),
    conversationSha256: sourceContractSha256("Earlier context."),
    contextManifestSha256: loopV2ContextManifestSha256(contextManifest),
    compiledContextSha256: sourceContractSha256("Earlier context."),
    selectedEvidenceIds: [],
    boundAt: "2026-09-08T00:00:00.000Z",
  });
  return {
    modelInput: "context-bound model input",
    contextManifest,
    contextBinding,
    selectedEvidenceCount: 0,
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
  const appendIdentityPin = vi.fn().mockResolvedValue(undefined);
  const prepareContext = vi.fn();
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
    appendIdentityPin,
    prepareContext,
  } as unknown as LoopV2ModelTextDependencies;
  return {
    dependencies,
    checkpoints,
    createRun,
    generateText,
    finalizeRun,
    appendAssistantTurn,
    failUncheckpointedRun,
    appendIdentityPin,
    prepareContext,
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

function contextEnginePin() {
  return {
    capabilityId: LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID,
    engineVersionId: LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_CONTEXT_TEXT_CONFIGURATION_SHA256,
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

function contextRollout(): TenantCapabilityRollout {
  return {
    ...rollout(),
    capabilityId: LOOP_V2_CONTEXT_TEXT_CAPABILITY_ID,
    engineVersion: LOOP_V2_CONTEXT_TEXT_ENGINE_VERSION_ID,
    configurationSha256: LOOP_V2_CONTEXT_TEXT_CONFIGURATION_SHA256,
  };
}

async function collect(iterable: AsyncIterable<AgentEvent>) {
  const values: AgentEvent[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}
