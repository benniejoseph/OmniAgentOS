import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getExecution: vi.fn(),
  transitionExecution: vi.fn(),
  resolveIdentity: vi.fn(),
  listStreamEvents: vi.fn(),
  selectAgentModel: vi.fn(),
  runAgent: vi.fn(),
  reviewCouncilResponse: vi.fn(),
  completeOperationJob: vi.fn(),
  failOperationJob: vi.fn(),
  heartbeatOperationJob: vi.fn(),
  claimQueuedAgentRun: vi.fn(),
  failAgentRun: vi.fn(),
  getAgentRun: vi.fn(),
  getAgentRunExecutionScope: vi.fn(),
  getAgentRunIdentityPin: vi.fn(),
  resolveRuntimeModel: vi.fn(),
  revalidateGrants: vi.fn(),
  appendGrantValidation: vi.fn(),
}));

vi.mock("@/lib/delegation/execution-store", () => ({
  createDelegationExecution: vi.fn(),
  findDelegationExecution: vi.fn(),
  getDelegationExecution: mocks.getExecution,
  transitionDelegationExecution: mocks.transitionExecution,
}));
vi.mock("@/lib/agents/identity-store", () => ({
  resolveAgentIdentityForExecution: mocks.resolveIdentity,
}));
vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
}));
vi.mock("@/lib/openai/model-router", () => ({
  selectAgentModel: mocks.selectAgentModel,
}));
vi.mock("@/lib/orchestration/agent-runner", () => ({
  runAgent: mocks.runAgent,
}));
vi.mock("@/lib/orchestration/council", () => ({
  reviewCouncilResponse: mocks.reviewCouncilResponse,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  completeOperationJob: mocks.completeOperationJob,
  enqueueOperationJob: vi.fn(),
  failOperationJob: mocks.failOperationJob,
  getAgentExecuteJobDedupeKey: (runId: string) => `agent.execute:${runId}`,
  heartbeatOperationJob: mocks.heartbeatOperationJob,
}));
vi.mock("@/lib/runs/store", () => ({
  appendAgentRunIdentityPin: vi.fn(),
  bindAgentRunExecutionScope: vi.fn(),
  createQueuedAgentRun: vi.fn(),
  claimQueuedAgentRun: mocks.claimQueuedAgentRun,
  failAgentRun: mocks.failAgentRun,
  getAgentRun: mocks.getAgentRun,
  getAgentRunExecutionScope: mocks.getAgentRunExecutionScope,
  getAgentRunIdentityPin: mocks.getAgentRunIdentityPin,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntimeModel,
}));
vi.mock("@/lib/delegation/grant-resolver", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/delegation/grant-resolver")>(),
  revalidateDelegationGrantsV1: mocks.revalidateGrants,
}));
vi.mock("@/lib/delegation/grant-validation-events", () => ({
  appendDelegationGrantValidation: mocks.appendGrantValidation,
}));

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { AGENT_REASONING_EFFORT } from "@/lib/config";
import {
  buildDelegationRuntimeAssignmentReceiptV1,
} from "@/lib/delegation/execution-contract";
import {
  buildDelegationExecutionRecordV1,
  transitionDelegationExecutionRecordV1,
  type DelegationExecutionRecordV1,
} from "@/lib/delegation/execution-record";
import {
  exactDelegationRuntime,
  executionScopeFromDelegationContract,
} from "@/lib/delegation/runtime";
import { DELEGATION_EXECUTION_JOB_KIND } from "@/lib/delegation/runtime-job";
import {
  buildExecutionContract,
  executionParentBudgets,
} from "@/lib/delegation/test-fixtures";
import { processDelegationExecutionJob } from "@/lib/delegation/worker";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import type { AgentRunRecord } from "@/lib/runs/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { RuntimeModelResolution } from "@/lib/settings/runtime-models";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const modelRoute = {
  provider: "openai" as const,
  model: "deployment-model",
  fallbackModel: undefined,
  tier: "reasoning" as const,
  reason: "Test model route",
};

describe("delegation execution worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectAgentModel.mockReturnValue(modelRoute);
    mocks.resolveRuntimeModel.mockResolvedValue(runtimeResolution());
    mocks.revalidateGrants.mockResolvedValue({
      skills: [],
      governedToolIds: [],
    });
    mocks.appendGrantValidation.mockResolvedValue(undefined);
    mocks.listStreamEvents.mockResolvedValue([{
      id: "event:model:one",
      streamId: "run:run-child",
      type: "run.model",
      payload: { model: "configured-council-model", usageReceiptId: "usage:one" },
      createdAt: new Date().toISOString(),
    }]);
    mocks.reviewCouncilResponse.mockImplementation(async (input) => {
      await input.checkpointHooks?.afterModel?.({
        sourceId: "verifier:sentinel",
        attempt: 1,
        status: "completed",
        generated: verifierGeneration(),
      });
      return {
        passed: true,
        score: 0.95,
        assessment: "The proposal satisfies the bounded acceptance contract.",
        requiredChanges: [],
      };
    });
  });

  it("moves queued work through proposal and verifier-gated completion", async () => {
    const harness = workerHarness();

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.transitions).toEqual([
      "running",
      "completed_proposed",
      "verified",
    ]);
    expect(harness.execution.state).toBe("verified");
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        preclaimedRunId: harness.run.id,
        runtimeModelPin: expect.objectContaining({
          provider: "openai",
          model: "configured-council-model",
        }),
        agentProfile: expect.objectContaining({
          approvalPolicy: "read_only",
          toolIds: [],
          skills: [],
        }),
        budgetLimits: harness.execution.contract.budgets,
      }),
      expect.any(AbortSignal),
    );
    expect(mocks.reviewCouncilResponse).toHaveBeenCalledTimes(1);
    expect(mocks.completeOperationJob).toHaveBeenCalledTimes(1);
    expect(mocks.failOperationJob).not.toHaveBeenCalled();
    expect(mocks.appendGrantValidation).toHaveBeenCalledWith({
      execution: expect.objectContaining({ executionId: "run-child" }),
      executionScope: expect.objectContaining({
        delegationId: "delegation:execution:one",
      }),
      status: "current",
    });
  });

  it("persists a verifier rejection instead of promoting a weak proposal", async () => {
    mocks.reviewCouncilResponse.mockImplementation(async (input) => {
      await input.checkpointHooks?.afterModel?.({
        sourceId: "verifier:sentinel",
        attempt: 1,
        status: "completed",
        generated: verifierGeneration(),
      });
      return {
        passed: false,
        score: 0.4,
        assessment: "Evidence is insufficient.",
        requiredChanges: ["Add an independent source."],
      };
    });
    const harness = workerHarness();

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.transitions).toEqual([
      "running",
      "completed_proposed",
      "rejected",
    ]);
    expect(harness.execution).toMatchObject({
      state: "rejected",
      verification: {
        verdict: "rejected",
        score: 0.4,
      },
    });
    expect(result.message).toMatch(/Evidence is insufficient/i);
  });

  it("fails closed before claiming the child when its runtime pin drifts", async () => {
    const harness = workerHarness();
    mocks.resolveRuntimeModel.mockResolvedValue(runtimeResolution({
      model: "changed-after-contract",
      assignmentRevision: 8,
      assignmentConfigurationSha256: "8".repeat(64),
    }));

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "runtime_assignment_changed",
    });
    expect(harness.transitions).toEqual(["failed"]);
    expect(harness.execution).toMatchObject({
      state: "failed",
      failureCode: "runtime_assignment_changed",
    });
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.failAgentRun).toHaveBeenCalledWith(
      harness.run.id,
      expect.stringMatching(/runtime_assignment_changed/),
      expect.any(Object),
    );
  });

  it("turns a child runtime failure into terminal execution and job receipts", async () => {
    const harness = workerHarness({ runFailure: new Error("provider unavailable") });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({ status: "failed", message: "child_run_failed" });
    expect(harness.transitions).toEqual(["running", "failed"]);
    expect(harness.execution).toMatchObject({
      state: "failed",
      failureCode: "child_run_failed",
    });
    expect(mocks.failAgentRun).toHaveBeenCalledWith(
      harness.run.id,
      "provider unavailable",
      expect.any(Object),
    );
    expect(mocks.failOperationJob).toHaveBeenCalledTimes(1);
    expect(mocks.completeOperationJob).not.toHaveBeenCalled();
  });

  it("fails closed before claiming when the pinned Sentinel runtime drifts", async () => {
    const harness = workerHarness();
    mocks.resolveRuntimeModel
      .mockResolvedValueOnce(runtimeResolution())
      .mockResolvedValueOnce(runtimeResolution({
        model: "changed-verifier-model",
        assignmentRevision: 9,
        assignmentConfigurationSha256: "9".repeat(64),
      }));

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "verifier_runtime_assignment_changed",
    });
    expect(harness.transitions).toEqual(["failed"]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
  });

  it("fails closed before claim when a delegated grant is revoked or drifts", async () => {
    const harness = workerHarness();
    mocks.revalidateGrants.mockRejectedValueOnce(
      new Error("The delegated MCP contract changed."),
    );

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "grant_assignment_changed",
    });
    expect(harness.transitions).toEqual(["failed"]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.appendGrantValidation).toHaveBeenCalledWith({
      execution: expect.objectContaining({ executionId: "run-child" }),
      executionScope: expect.any(Object),
      status: "changed",
    });
  });

  it("fails closed when the content-free grant-validation receipt cannot persist", async () => {
    const harness = workerHarness();
    mocks.appendGrantValidation.mockRejectedValueOnce(
      new Error("event ledger unavailable"),
    );

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "grant_validation_unavailable",
    });
    expect(harness.transitions).toEqual(["failed"]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("fails closed before claim when a persona-bound child prompt drifts", async () => {
    const harness = workerHarness({
      personaPrompt: "Expected persona-bound child prompt.",
      storedPrompt: "Tampered child prompt.",
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "persona_prompt_binding_mismatch",
    });
    expect(harness.transitions).toEqual(["failed"]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("runs an exact persona-bound prompt without changing the immutable Agent profile", async () => {
    const personaPrompt = "Exact bounded child prompt with untrusted style guidance.";
    const harness = workerHarness({ personaPrompt });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(mocks.runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [{ role: "user", content: personaPrompt }],
        agentProfile: expect.objectContaining({
          instructions: expect.not.stringContaining("untrusted style guidance"),
          approvalPolicy: "read_only",
          toolIds: [],
        }),
      }),
      expect.any(AbortSignal),
    );
  });

  it("rejects an evidence criterion without an observable evidence receipt", async () => {
    const harness = workerHarness({
      criterion: {
        statement: "Cite evidence for the bounded result.",
        verificationMethod: "evidence",
      },
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.execution).toMatchObject({
      state: "rejected",
      result: {
        status: "blocked",
        acceptanceChecks: [{
          passed: false,
          note: "evidence:evidence_receipt_missing",
        }],
      },
    });
  });

  it("projects governed tool execution IDs from durable run receipts", async () => {
    mocks.listStreamEvents.mockResolvedValue([
      {
        id: "event:model:one",
        streamId: "run:run-child",
        type: "run.model",
        payload: {
          model: "configured-council-model",
          usageReceiptId: "usage:one",
        },
        createdAt: new Date().toISOString(),
      },
      {
        id: "event:tool:one",
        streamId: "run:run-child",
        type: "run.tool",
        payload: {
          toolId: "knowledge.search",
          status: "executed",
          executionId: "tool-execution:one",
        },
        createdAt: new Date().toISOString(),
      },
    ]);
    const harness = workerHarness();

    await processDelegationExecutionJob(harness.job);

    expect(harness.execution.result?.toolExecutionIds).toEqual([
      "tool-execution:one",
    ]);
  });

  it("fails closed before claim when the parent owner and root scope diverge", async () => {
    const harness = workerHarness({ parentOwnerMismatch: true });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "identity_binding_mismatch",
    });
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the persisted parent scope is not an agent root run", async () => {
    const harness = workerHarness({ parentScopePurpose: "agent.tool.execute" });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "identity_binding_mismatch",
    });
    expect(mocks.revalidateGrants).not.toHaveBeenCalled();
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the child run owner diverges from its contract", async () => {
    const harness = workerHarness({ childOwnerMismatch: true });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "identity_binding_mismatch",
    });
    expect(mocks.revalidateGrants).not.toHaveBeenCalled();
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });

  it("fails closed when the child identity pin principal diverges", async () => {
    const harness = workerHarness({ childPinMismatch: true });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "identity_binding_mismatch",
    });
    expect(mocks.revalidateGrants).not.toHaveBeenCalled();
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
  });
});

function workerHarness(options: {
  runFailure?: Error;
  personaPrompt?: string;
  storedPrompt?: string;
  parentOwnerMismatch?: boolean;
  parentScopePurpose?: string;
  childOwnerMismatch?: boolean;
  childPinMismatch?: boolean;
  criterion?: {
    statement: string;
    verificationMethod: "schema" | "evidence" | "governed_receipt" | "parent_verifier";
  };
} = {}) {
  const tenantId = "tenant-one";
  const actorId = "actor-one";
  const now = Date.now();
  const createdAt = new Date(now - 1_000).toISOString();
  const parentCompleteBy = new Date(now + 10 * 60_000).toISOString();
  const runtimeModel = runtimeResolution();
  const exactRuntime = exactDelegationRuntime({
    runtimeModel,
    deploymentRoute: modelRoute,
    scope: "council",
  });
  const sentinelIdentity = buildBuiltInAgentIdentityV1({
    agentId: "sentinel",
    tenantId,
    controllerActorId: actorId,
  });
  const parentIdentityPin = buildAgentRunIdentityPinV1({
    runId: "run-root",
    identity: buildBuiltInAgentIdentityV1({
      agentId: "atlas",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const childIdentityPin = buildAgentRunIdentityPinV1({
    runId: "run-child",
    identity: buildBuiltInAgentIdentityV1({
      agentId: "scout",
      tenantId,
      controllerActorId: actorId,
    }),
  });
  const verifierIdentityPin = buildAgentRunIdentityPinV1({
    runId: "run-root",
    identity: sentinelIdentity,
  });
  const verifierExactRuntime = exactDelegationRuntime({
    runtimeModel,
    deploymentRoute: modelRoute,
    scope: "verifier",
  });
  const contract = buildExecutionContract({
    ...(options.criterion
      ? {
          acceptance: {
            acceptanceId: "acceptance:execution:worker-test",
            criteria: [{
              criterionId: "criterion:execution:one",
              statement: options.criterion.statement,
              criterionSha256: canonicalJsonSha256({
                statement: options.criterion.statement,
              }),
              verificationMethod: options.criterion.verificationMethod,
              required: true as const,
            }],
          },
        }
      : {}),
    ...(options.personaPrompt
      ? {
          personaBrief: {
            label: "Bounded specialist",
            guidance: "Use an investigative tone without changing authority.",
            promptSha256: createHash("sha256")
              .update(options.personaPrompt, "utf8")
              .digest("hex"),
          },
        }
      : {}),
    runtimeAssignment: buildDelegationRuntimeAssignmentReceiptV1({
      executionId: "run-child",
      providerId: exactRuntime.provider,
      modelId: exactRuntime.model,
      modelTier: exactRuntime.tier,
      reasoningProfileId: `agent-reasoning:${AGENT_REASONING_EFFORT}`,
      normalizedReasoningEffort: AGENT_REASONING_EFFORT,
      routingPolicyId: exactRuntime.routingPolicyId,
      routingPolicySha256: exactRuntime.routingPolicySha256,
      assignedAt: createdAt,
    }),
    verifier: {
      verifierContractId: "verifier-contract:execution:one",
      verifierPolicyId: "verifier-policy:execution:one",
      verifierPolicySha256: "e".repeat(64),
      identityPin: verifierIdentityPin,
      runtimeAssignment: buildDelegationRuntimeAssignmentReceiptV1({
        executionId: verifierIdentityPin.runId,
        providerId: verifierExactRuntime.provider,
        modelId: verifierExactRuntime.model,
        modelTier: verifierExactRuntime.tier,
        reasoningProfileId: `agent-reasoning:${AGENT_REASONING_EFFORT}`,
        normalizedReasoningEffort: AGENT_REASONING_EFFORT,
        routingPolicyId: verifierExactRuntime.routingPolicyId,
        routingPolicySha256: verifierExactRuntime.routingPolicySha256,
        assignedAt: createdAt,
      }),
      method: "agent_then_deterministic",
      requiredEvidenceKinds: [
        "artifact_digest",
        "acceptance_check",
        "model_receipt",
      ],
      acceptanceThreshold: 0.8,
      completionDisposition: "proposed_only",
      parentAcceptanceRequired: true,
    },
    parentAuthority: {
      grants: {
        contextGrantIds: [],
        capabilityGrantIds: [],
        governedToolIds: [],
        connectorTargets: [],
      },
      budgets: executionParentBudgets,
      completeBy: parentCompleteBy,
    },
    deadline: {
      createdAt,
      acceptBy: new Date(now + 30_000).toISOString(),
      completeBy: new Date(now + 5 * 60_000).toISOString(),
    },
  });
  let execution: DelegationExecutionRecordV1 = buildDelegationExecutionRecordV1({
    contract,
    budgetLedgerRevision: 1,
  });
  const storedPrompt = options.storedPrompt || options.personaPrompt || contract.objective;
  let run: AgentRunRecord = {
    id: contract.delegateIdentity.runId,
    tenantId,
    ownerActorId: options.childOwnerMismatch ? "actor-other" : actorId,
    mode: "research",
    status: "queued",
    prompt: storedPrompt,
    messages: [{ role: "user", content: storedPrompt }],
    model: contract.runtimeAssignment.modelId,
    agentId: contract.delegateIdentity.logicalAgentId,
    memoryContextCount: 0,
    startedAt: createdAt,
  };
  const childScope = executionScopeFromDelegationContract(contract);
  const parentRun: AgentRunRecord = {
    id: contract.lineage.parentExecutionId,
    tenantId,
    ownerActorId: options.parentOwnerMismatch ? "actor-other" : actorId,
    mode: "orchestrate",
    status: "completed",
    prompt: "Coordinate the bounded child.",
    messages: [{ role: "user", content: "Coordinate the bounded child." }],
    model: "configured-council-model",
    agentId: contract.delegatorIdentity.logicalAgentId,
    memoryContextCount: 0,
    startedAt: createdAt,
    completedAt: createdAt,
  };
  const parentScope = createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: parentIdentityPin.principalId,
    delegationId: null,
    correlationId: parentRun.id,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: options.parentScopePurpose || "agent.run",
  });
  const transitions: string[] = [];
  const job = delegationJob(execution, childScope);

  mocks.getExecution.mockImplementation(async () => execution);
  mocks.transitionExecution.mockImplementation(async (input: {
    transition: Parameters<typeof transitionDelegationExecutionRecordV1>[0]["transition"];
  }) => {
    execution = transitionDelegationExecutionRecordV1({
      record: execution,
      transition: input.transition,
      at: new Date().toISOString(),
    }).record;
    transitions.push(input.transition.to);
    return execution;
  });
  mocks.getAgentRun.mockImplementation(async (runId: string) =>
    runId === run.id ? run : runId === parentRun.id ? parentRun : undefined
  );
  mocks.getAgentRunExecutionScope.mockImplementation(async (runId: string) =>
    runId === run.id
      ? childScope
      : runId === parentRun.id
        ? parentScope
        : undefined
  );
  mocks.getAgentRunIdentityPin.mockImplementation(async (runId: string) =>
    runId === run.id
      ? options.childPinMismatch
        ? buildAgentRunIdentityPinV1({
            runId: "run-child",
            identity: buildBuiltInAgentIdentityV1({
              agentId: "scout",
              tenantId,
              controllerActorId: "actor-other",
            }),
          })
        : childIdentityPin
      : parentIdentityPin
  );
  mocks.claimQueuedAgentRun.mockImplementation(async () => {
    run = { ...run, status: "running" };
    return run;
  });
  mocks.failAgentRun.mockImplementation(async (_runId: string, message: string) => {
    run = { ...run, status: "failed", error: message };
    return true;
  });
  mocks.resolveIdentity.mockResolvedValue(sentinelIdentity);
  mocks.heartbeatOperationJob.mockResolvedValue(job);
  mocks.completeOperationJob.mockResolvedValue({
    ...job,
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  mocks.failOperationJob.mockResolvedValue({
    ...job,
    status: "failed",
    lastError: "failed",
  });
  mocks.runAgent.mockImplementation(async function* () {
    if (options.runFailure) throw options.runFailure;
    run = {
      ...run,
      status: "completed",
      response: JSON.stringify({
        summary: "Evidence-backed bounded result.",
        evidenceIds: [],
        toolExecutionIds: [],
        acceptanceChecks: execution.contract.acceptance.criteria.map(
          (criterion) => ({
            criterionId: criterion.criterionId,
            passed: true,
            note: "The bounded result satisfies the requested criterion.",
            evidenceIds: [],
            toolExecutionIds: [],
          }),
        ),
      }),
      completedAt: new Date().toISOString(),
    };
    yield { type: "done", response: run.response };
  });

  return {
    job,
    transitions,
    get execution() {
      return execution;
    },
    get run() {
      return run;
    },
  };
}

function verifierGeneration() {
  return {
    text: JSON.stringify({
      passed: true,
      score: 0.95,
      assessment: "Verified.",
      requiredChanges: [],
    }),
    provider: "openai" as const,
    model: "configured-council-model",
    usage: {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      totalTokens: 120,
    },
    latencyMs: 10,
    costKnown: true,
    estimatedCostUsd: 0.001,
    attempts: [{
      provider: "openai" as const,
      model: "configured-council-model",
      status: "completed" as const,
      latencyMs: 10,
    }],
    usageReceiptRecorded: true,
    usageReceiptId: "usage:verifier:one",
  };
}

function runtimeResolution(overrides: Partial<RuntimeModelResolution> = {}): RuntimeModelResolution {
  return {
    scope: "council",
    source: "tenant_assignment",
    configured: true,
    assignmentId: "assignment:council",
    assignmentRevision: 7,
    assignmentConfigurationSha256: "7".repeat(64),
    provider: "openai",
    model: "configured-council-model",
    allowCrossProviderFallback: false,
    warnings: [],
    reason: "Test tenant assignment",
    usageReceipt: {
      assignmentScope: "council",
      assignmentId: "assignment:council",
      assignmentRevision: 7,
      assignmentConfigurationSha256: "7".repeat(64),
      credentialSource: "tenant_vault",
    },
    bind: <T>(request: T) => request,
    withProviderApiKey: async (_provider, operation) => operation("test-key"),
    ...overrides,
  } as RuntimeModelResolution;
}

function delegationJob(
  execution: DelegationExecutionRecordV1,
  executionScope: ReturnType<typeof executionScopeFromDelegationContract>,
): OperationJobRecord {
  const now = new Date().toISOString();
  return {
    id: "job-delegation-worker",
    tenantId: execution.tenantId,
    type: "agent.execute",
    status: "running",
    payload: {
      schemaVersion: 1,
      kind: DELEGATION_EXECUTION_JOB_KIND,
      actorId: execution.ownerActorId,
      executionId: execution.executionId,
      runId: execution.childRunId,
      agentId: execution.delegateAgentId,
      contractSha256: execution.contractSha256,
      contextCapsuleSha256: execution.contextCapsuleSha256,
      runtimeAssignmentSha256: execution.runtimeAssignmentSha256,
      executionScope,
      queuedAt: execution.createdAt,
    },
    dedupeKey: `agent.execute:${execution.childRunId}`,
    priority: 20,
    attempt: 1,
    maxAttempts: 1,
    runAt: now,
    lockedAt: now,
    leaseOwner: "worker:test",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}
