import { describe, expect, it, vi } from "vitest";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import { buildDelegationExecutionRecordV1 } from "@/lib/delegation/execution-record";
import {
  delegateAgentTask,
  executionScopeFromDelegationContract,
  type DelegateAgentTaskInput,
} from "@/lib/delegation/runtime";
import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  DYNAMIC_DELEGATION_READ_TOOL_IDS,
  dynamicDelegationParentToolReservation,
  dynamicDelegationRootReservation,
} from "@/lib/delegation/runtime-policy";
import { buildParentDelegationBudgetAuthorityV1 } from "@/lib/delegation/parent-budget-authority";
import type { enqueueOperationJob } from "@/lib/operations/job-queue";
import type {
  appendAgentRunIdentityPin,
  bindAgentRunExecutionScope,
  createQueuedAgentRun,
  getAgentRun,
  getAgentRunIdentityPin,
} from "@/lib/runs/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  createRunBudgetState,
  refreshRunBudgetWallTime,
  reserveRunBudget,
} from "@/lib/runs/budgets";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { resolveRuntimeModelAssignment } from "@/lib/settings/runtime-models";

describe("dynamic delegation runtime", () => {
  it("creates one deterministic child and makes retries idempotent", async () => {
    const harness = runtimeHarness();
    const request = harness.request({ mode: "isolated" });

    const first = await delegateAgentTask(request, harness.dependencies);
    const second = await delegateAgentTask(request, harness.dependencies);

    expect(second).toEqual(first);
    expect(harness.createRun).toHaveBeenCalledTimes(1);
    expect(harness.createExecution).toHaveBeenCalledTimes(1);
    expect(harness.enqueueJob).toHaveBeenCalledTimes(2);
    expect(first.executionId).toMatch(/^dar_[a-f0-9]{40}$/);
    expect(first.contract.idempotencyKeySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(harness.boundScope).toEqual(
      executionScopeFromDelegationContract(first.contract),
    );
    expect(harness.appendedPin?.runId).toBe(first.childRunId);
    expect(harness.scheduleDrain).toHaveBeenCalledTimes(2);
    expect(harness.createExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        rootBudgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS,
      }),
    );
    expect(first.contract.verifier.runtimeAssignment).toMatchObject({
      providerId: "openai",
      modelId: "configured-council-model",
      modelTier: "reasoning",
    });
  });

  it("attenuates grants, fan-out, and parent context before queueing", async () => {
    const harness = runtimeHarness({
      parentMessages: [
        { role: "user", content: "parent-private-context-marker" },
        { role: "assistant", content: "parent-private-response-marker" },
      ],
    });
    const execution = await delegateAgentTask(
      harness.request({ mode: "isolated" }),
      harness.dependencies,
    );

    expect(execution.contract.lineage).toMatchObject({
      depth: 1,
      maxDepth: 1,
      parentDelegationId: null,
    });
    expect(execution.contract.grants).toEqual({
      contextGrantIds: [],
      capabilityGrantIds: [],
      governedToolIds: [...DYNAMIC_DELEGATION_READ_TOOL_IDS],
      connectorTargets: [],
      skills: [],
      mcpServers: [],
      plugins: [],
    });
    expect(execution.contract.budgets).toMatchObject({
      browserActions: 0,
      agents: 1,
      fanOut: 0,
      retries: 0,
      replans: 0,
    });
    expect(execution.contract.contextCapsule.parentTranscript).toEqual({
      included: false,
      manifestId: null,
      manifestSha256: null,
      turns: [],
    });
    expect(harness.childPrompt).not.toContain("parent-private-context-marker");
    expect(harness.boundScope).toMatchObject({
      contextGrantIds: [],
      capabilityGrantIds: [],
      delegationId: execution.delegationId,
      correlationId: harness.parentRun.id,
    });
  });

  it("binds fork context by digest while marking prompt content untrusted", async () => {
    const harness = runtimeHarness({
      parentMessages: [
        { role: "user", content: "research marker from the parent" },
        { role: "assistant", content: "an earlier untrusted answer" },
      ],
    });
    const execution = await delegateAgentTask(
      harness.request({ mode: "fork" }),
      harness.dependencies,
    );

    expect(execution.contract.contextCapsule.parentTranscript?.turns).toHaveLength(2);
    expect(execution.contract.contextCapsule.parentTranscript?.turns[0]).toEqual(
      expect.objectContaining({
        role: "user",
        contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
    expect(JSON.stringify(execution.contract.contextCapsule)).not.toContain(
      "research marker from the parent",
    );
    expect(harness.childPrompt).toContain(
      "Untrusted parent transcript for context only",
    );
    expect(harness.childPrompt).toContain("research marker from the parent");
  });

  it("rejects reuse of an idempotency key for changed intent", async () => {
    const harness = runtimeHarness();
    await delegateAgentTask(harness.request(), harness.dependencies);

    await expect(delegateAgentTask(harness.request({
      objective: "A materially different bounded objective",
    }), harness.dependencies)).rejects.toThrow(/idempotency key/i);
    expect(harness.createRun).toHaveBeenCalledTimes(1);
  });

  it("fails before child creation when the live reservation differs from the harness", async () => {
    const harness = runtimeHarness();
    harness.dependencies.listParentEvents.mockResolvedValueOnce([{
      id: "event:parent:harness:changed",
      streamId: `run:${harness.parentRun.id}`,
      type: "run.harness",
      payload: {
        budgetLimits: {
          ...DEFAULT_AGENT_RUN_BUDGET_LIMITS,
          agents: DEFAULT_AGENT_RUN_BUDGET_LIMITS.agents - 1,
        },
      },
      createdAt: harness.parentRun.startedAt,
    }]);

    await expect(delegateAgentTask(
      harness.request(),
      harness.dependencies,
    )).rejects.toThrow(/persisted harness budget/i);
    expect(harness.createRun).not.toHaveBeenCalled();
    expect(harness.createExecution).not.toHaveBeenCalled();
  });

  it("rejects a call that bypasses the parent-loop reservation", async () => {
    const harness = runtimeHarness();
    const request = { ...harness.request(), parentBudgetAuthority: undefined };

    await expect(delegateAgentTask(request, harness.dependencies)).rejects
      .toThrow(/live parent-loop budget reservation/i);
    expect(harness.createRun).not.toHaveBeenCalled();
  });
});

function runtimeHarness(options: {
  parentMessages?: AgentRunRecord["messages"];
} = {}) {
  const tenantId = "tenant-runtime";
  const actorId = "actor-runtime";
  const parentRunId = "run-parent-runtime";
  const parentIdentity = buildBuiltInAgentIdentityV1({
    agentId: "atlas",
    tenantId,
    controllerActorId: actorId,
  });
  const parentPin = buildAgentRunIdentityPinV1({
    runId: parentRunId,
    identity: parentIdentity,
  });
  const startedAt = new Date(Date.now() - 1_000).toISOString();
  const parentRun: AgentRunRecord = {
    id: parentRunId,
    tenantId,
    ownerActorId: actorId,
    mode: "orchestrate",
    status: "running",
    prompt: "Coordinate one bounded child task.",
    messages: options.parentMessages || [{
      role: "user",
      content: "Coordinate one bounded child task.",
    }],
    model: "parent-model",
    agentId: "atlas",
    memoryContextCount: 0,
    startedAt,
  };
  const parentExecutionScope = createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: parentPin.principalId,
    delegationId: null,
    correlationId: parentRunId,
    contextGrantIds: ["context:parent-only"],
    capabilityGrantIds: ["capability:parent-only"],
    purpose: "agent.run",
  });
  const reservedAtMs = Date.now();
  const budgetBefore = refreshRunBudgetWallTime(createRunBudgetState(
    DEFAULT_AGENT_RUN_BUDGET_LIMITS,
    {
      startedAt,
      used: {
        modelTurns: 1,
        tokens: 4_000,
        costMicrousd: 50_000,
      },
    },
  ), reservedAtMs);
  const parentToolReservation = dynamicDelegationParentToolReservation(
    DYNAMIC_DELEGATION_CHILD_BUDGET,
  );
  const budgetAfter = reserveRunBudget(
    budgetBefore,
    parentToolReservation,
    reservedAtMs,
  );
  let existing: ReturnType<typeof buildDelegationExecutionRecordV1> | undefined;
  let boundScope: unknown;
  let appendedPin: AgentRunIdentityPinV1 | undefined;
  let childPrompt = "";

  const createRun = vi.fn(async (
    input: Parameters<typeof createQueuedAgentRun>[0],
  ): Promise<AgentRunRecord> => {
    childPrompt = input.prompt;
    return {
      id: input.id!,
      tenantId: input.tenantId,
      ownerActorId: input.actorId,
      mode: input.mode,
      status: "queued",
      prompt: input.prompt,
      messages: input.messages,
      model: input.model,
      agentId: input.agentId,
      memoryContextCount: 0,
      startedAt: new Date().toISOString(),
    };
  }) as typeof createQueuedAgentRun;
  const createExecution = vi.fn(async (input: {
    contract: Parameters<typeof buildDelegationExecutionRecordV1>[0]["contract"];
  }) => {
    existing = buildDelegationExecutionRecordV1({
      contract: input.contract,
      budgetLedgerRevision: 1,
    });
    return existing;
  });
  const enqueueJob = vi.fn(async (
    input: Parameters<typeof enqueueOperationJob>[0],
  ) => operationJob(input)) as typeof enqueueOperationJob;
  const bindRunScope = vi.fn(async (
    _runId: string,
    scope: Parameters<typeof bindAgentRunExecutionScope>[1],
  ) => {
    boundScope = scope;
  }) as unknown as typeof bindAgentRunExecutionScope;
  const appendRunIdentityPin = vi.fn(async (
    _runId: string,
    pin: AgentRunIdentityPinV1,
  ) => {
    appendedPin = pin;
  }) as unknown as typeof appendAgentRunIdentityPin;
  const scheduleDrain = vi.fn();

  const dependencies = {
    findExecution: vi.fn(async () => existing),
    listParentEvents: vi.fn(async () => [{
      id: "event:parent:harness",
      streamId: `run:${parentRunId}`,
      type: "run.harness",
      payload: { budgetLimits: DEFAULT_AGENT_RUN_BUDGET_LIMITS },
      createdAt: startedAt,
    }]),
    getRun: vi.fn(async () => parentRun) as typeof getAgentRun,
    getRunIdentityPin: vi.fn(async () => parentPin) as typeof getAgentRunIdentityPin,
    resolveIdentity: vi.fn(async (input: { agentId: string }) =>
      buildBuiltInAgentIdentityV1({
        agentId: input.agentId as "scout" | "sentinel",
        tenantId,
        controllerActorId: actorId,
      })),
    resolveRuntimeModel: vi.fn(async () => runtimeResolution()) as typeof resolveRuntimeModelAssignment,
    createRun,
    bindRunScope,
    appendRunIdentityPin,
    createExecution,
    enqueueJob,
    scheduleDrain,
  };

  return {
    parentRun,
    dependencies,
    createRun,
    createExecution,
    enqueueJob,
    scheduleDrain,
    get boundScope() {
      return boundScope;
    },
    get appendedPin() {
      return appendedPin;
    },
    get childPrompt() {
      return childPrompt;
    },
    request(overrides: Partial<DelegateAgentTaskInput> = {}) {
      const idempotencyKey = "delegate-once";
      return {
        tenantId,
        actorId,
        parentExecutionScope,
        idempotencyKey,
        parentBudgetAuthority: buildParentDelegationBudgetAuthorityV1({
          parentExecutionScope,
          idempotencyKey,
          before: budgetBefore,
          after: budgetAfter,
          childRootReservation: dynamicDelegationRootReservation(
            DYNAMIC_DELEGATION_CHILD_BUDGET,
          ),
          parentToolReservation,
          reservedAt: new Date(reservedAtMs).toISOString(),
        }),
        input: {
          objective: "Research the bounded evidence and return a concise finding.",
          taskKind: "research" as const,
          acceptanceCriteria: ["Cite evidence for the final finding."],
          mode: "isolated" as const,
          preferredAgentId: "scout" as const,
          ...overrides,
        },
      };
    },
  };
}

function runtimeResolution(): Awaited<
  ReturnType<typeof resolveRuntimeModelAssignment>
> {
  return {
    scope: "council",
    source: "tenant_assignment",
    configured: true,
    assignmentId: "assignment:council",
    assignmentRevision: 7,
    assignmentConfigurationSha256: "a".repeat(64),
    provider: "openai",
    model: "configured-council-model",
    allowCrossProviderFallback: false,
    warnings: [],
    reason: "Test route",
    usageReceipt: {
      assignmentScope: "council",
      assignmentId: "assignment:council",
      assignmentRevision: 7,
      assignmentConfigurationSha256: "a".repeat(64),
      credentialSource: "tenant_vault",
    },
    bind: <T>(request: T) => request,
    withProviderApiKey: async (_provider, operation) => operation("test-key"),
  } as Awaited<ReturnType<typeof resolveRuntimeModelAssignment>>;
}

function operationJob(input: Parameters<typeof enqueueOperationJob>[0]) {
  const now = new Date().toISOString();
  return {
    id: "job-delegation-runtime",
    tenantId: input.tenantId,
    type: input.type,
    status: "queued" as const,
    payload: input.payload,
    dedupeKey: input.dedupeKey,
    priority: input.priority || 0,
    attempt: 0,
    maxAttempts: input.maxAttempts || 1,
    runAt: now,
    createdAt: now,
    updatedAt: now,
  };
}
