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
  buildClaimGroundingReport: vi.fn(),
  databaseActorScopes: [] as string[][],
}));

vi.mock("@/lib/db/client", () => ({
  runWithDatabaseActorScope: async (
    _tenantId: string,
    actorIds: readonly string[],
    operation: () => unknown,
  ) => {
    mocks.databaseActorScopes.push([...actorIds]);
    return operation();
  },
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
vi.mock("@/lib/rag/citations", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rag/citations")>(),
  buildClaimGroundingReport: mocks.buildClaimGroundingReport,
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
import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
  DYNAMIC_DELEGATION_VERIFIER_MAX_OUTPUT_TOKENS,
} from "@/lib/delegation/runtime-policy";
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
    mocks.databaseActorScopes.length = 0;
    mocks.selectAgentModel.mockReturnValue(modelRoute);
    mocks.resolveRuntimeModel.mockResolvedValue(runtimeResolution());
    mocks.revalidateGrants.mockResolvedValue({
      skills: [],
      governedToolIds: [],
    });
    mocks.appendGrantValidation.mockResolvedValue(undefined);
    mocks.buildClaimGroundingReport.mockResolvedValue({
      status: "verified",
      citedIds: [],
      invalidIds: [],
      sources: [],
    });
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
        liveWebPolicy: "disabled",
        runtimeModelPin: expect.objectContaining({
          provider: "openai",
          model: "configured-council-model",
        }),
        agentProfile: expect.objectContaining({
          approvalPolicy: "read_only",
          memoryScope: "session",
          toolIds: [],
          skills: [],
        }),
        budgetLimits: DYNAMIC_DELEGATION_CHILD_BUDGET,
        // Two required read rounds plus one provider tool-call repair round;
        // the fixed child budget keeps one separate turn for final synthesis.
        maxToolSteps: 3,
      }),
      expect.any(AbortSignal),
    );
    expect(mocks.reviewCouncilResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        maxOutputTokens: DYNAMIC_DELEGATION_VERIFIER_MAX_OUTPUT_TOKENS,
      }),
    );
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

  it("fails closed when Sentinel returns without a durable usage receipt", async () => {
    mocks.reviewCouncilResponse.mockImplementation(async (input) => {
      await input.checkpointHooks?.afterModel?.({
        sourceId: "verifier:sentinel",
        attempt: 1,
        status: "completed",
        generated: verifierGeneration({
          usageReceiptRecorded: false,
          usageReceiptId: undefined,
        }),
      });
      return {
        passed: true,
        score: 0.95,
        assessment: "Unreceipted verdict.",
        requiredChanges: [],
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
        score: 0,
        note: expect.stringMatching(/usage receipt was missing/i),
      },
    });
  });

  it("rechecks the parsed child summary against canonical knowledge sources", async () => {
    const evidenceId = "knowledge:chunk-launch";
    const harness = workerHarness({
      criterion: {
        statement: "Ground the launch date in canonical evidence.",
        verificationMethod: "evidence",
      },
      childSummary: `The launch date is 12 October 2026. [${evidenceId}]`,
      childEvidenceIds: [evidenceId],
      childGrounding: {
        status: "missing",
        citedIds: [evidenceId],
        invalidIds: [],
        sources: [{
          citationId: evidenceId,
          evidenceId: "chunk-launch",
          kind: "knowledge",
          title: "Launch plan",
        }],
      },
    });
    mocks.buildClaimGroundingReport.mockResolvedValue({
      status: "verified",
      citedIds: [evidenceId],
      invalidIds: [],
      sources: harness.run.grounding!.sources,
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.execution.state).toBe("verified");
    expect(mocks.buildClaimGroundingReport).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-child",
        response: `The launch date is 12 October 2026. [${evidenceId}]`,
        sources: harness.run.grounding!.sources,
      }),
    );
    expect(harness.execution.result?.evidenceIds).toEqual([evidenceId]);
  });

  it("rejects a citation without an exact canonical source sentence", async () => {
    const evidenceId = "knowledge:chunk-launch";
    const harness = workerHarness({
      criterion: {
        statement: "Ground the launch date in canonical evidence.",
        verificationMethod: "evidence",
      },
      childSummary: `[${evidenceId}]`,
      childEvidenceIds: [evidenceId],
      childGrounding: {
        status: "not_required",
        citedIds: [evidenceId],
        invalidIds: [],
        sources: [{
          citationId: evidenceId,
          evidenceId: "chunk-launch",
          kind: "knowledge",
          title: "Launch plan",
        }],
      },
    });
    mocks.buildClaimGroundingReport.mockResolvedValue({
      status: "not_required",
      citedIds: [evidenceId],
      invalidIds: [],
      sources: harness.run.grounding!.sources,
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

  it("rejects a run ID as evidence despite a valid required-tool receipt", async () => {
    const receipt = { toolId: "runs.list", executionId: "execution-runs" };
    const harness = workerHarness({
      criterion: {
        statement: "Use the required runs read tool.",
        verificationMethod: "governed_receipt",
        requiredGovernedToolIds: [receipt.toolId],
      },
      governedToolReceipts: [receipt],
      childSummary: "The run completed. [runs:run-child]",
      childEvidenceIds: ["runs:run-child"],
      childToolExecutionIds: [receipt.executionId],
      childGrounding: {
        status: "not_required",
        citedIds: [],
        invalidIds: [],
        sources: [],
      },
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.execution).toMatchObject({
      state: "rejected",
      result: {
        status: "blocked",
        evidenceIds: [],
        toolExecutionIds: [receipt.executionId],
        acceptanceChecks: [{
          passed: false,
          evidenceIds: [],
          note: "governed_receipt:unbound_receipt_claim",
        }],
      },
    });
  });

  it("verifies an exact canonical source sentence with every required-tool receipt", async () => {
    const evidenceId = "knowledge:chunk-launch";
    const receipts = [
      { toolId: "knowledge.search", executionId: "execution-knowledge" },
      { toolId: "runs.list", executionId: "execution-runs" },
    ];
    const harness = workerHarness({
      criteria: [
        {
          statement: "Ground the launch date in canonical evidence.",
          verificationMethod: "evidence",
        },
        {
          statement: "Use both required read tools.",
          verificationMethod: "governed_receipt",
          requiredGovernedToolIds: receipts.map((receipt) => receipt.toolId),
        },
      ],
      governedToolReceipts: receipts,
      childSummary: `The launch date is 12 October 2026. [${evidenceId}]`,
      childEvidenceIds: [evidenceId],
      childToolExecutionIds: receipts.map((receipt) => receipt.executionId),
      childGrounding: {
        status: "missing",
        citedIds: [evidenceId],
        invalidIds: [],
        sources: [{
          citationId: evidenceId,
          evidenceId: "chunk-launch",
          kind: "knowledge",
          title: "Launch plan",
        }],
      },
    });
    mocks.buildClaimGroundingReport.mockResolvedValue({
      status: "verified",
      citedIds: [evidenceId],
      invalidIds: [],
      sources: harness.run.grounding!.sources,
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.execution).toMatchObject({
      state: "verified",
      result: {
        status: "completed",
        evidenceIds: [evidenceId],
        toolExecutionIds: receipts.map((receipt) => receipt.executionId),
        acceptanceChecks: [
          { passed: true, note: "evidence:deterministic_receipts_satisfied" },
          { passed: true, note: "governed_receipt:deterministic_receipts_satisfied" },
        ],
      },
    });
  });

  it("rejects a required governed-tool criterion when one exact receipt is missing", async () => {
    const harness = workerHarness({
      criterion: {
        statement: "Use both required read tools.",
        verificationMethod: "governed_receipt",
        requiredGovernedToolIds: ["knowledge.search", "runs.list"],
      },
      optionalGrantedToolIds: ["memory.search"],
      governedToolReceipts: [{
        toolId: "knowledge.search",
        executionId: "execution-knowledge",
      }],
      childToolExecutionIds: ["execution-knowledge"],
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.execution.state).toBe("rejected");
    expect(harness.execution.result?.acceptanceChecks).toEqual([
      expect.objectContaining({
        passed: false,
        note: "governed_receipt:required_tool_receipt_missing",
      }),
    ]);
  });

  it("verifies every exact required tool receipt while leaving extra grants optional", async () => {
    const receipts = [
      { toolId: "knowledge.search", executionId: "execution-knowledge" },
      { toolId: "runs.list", executionId: "execution-runs" },
    ];
    const harness = workerHarness({
      criterion: {
        statement: "Use both required read tools.",
        verificationMethod: "governed_receipt",
        requiredGovernedToolIds: receipts.map((receipt) => receipt.toolId),
      },
      optionalGrantedToolIds: ["memory.search"],
      governedToolReceipts: receipts,
      childToolExecutionIds: receipts.map((receipt) => receipt.executionId),
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(harness.execution.state).toBe("verified");
    expect(harness.execution.result?.toolExecutionIds).toEqual([
      "execution-knowledge",
      "execution-runs",
    ]);
  });

  it("fails closed before claim when the lifecycle budget cannot be partitioned", async () => {
    const harness = workerHarness({ invalidLifecycleBudget: true });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "lifecycle_budget_mismatch",
    });
    expect(harness.transitions).toEqual(["failed"]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.reviewCouncilResponse).not.toHaveBeenCalled();
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

  it("reads an exact legacy-owned parent only through the contract-bound bridge", async () => {
    const harness = workerHarness({ legacyParentOwner: true });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result.status).toBe("completed");
    expect(mocks.databaseActorScopes).toEqual([
      ["actor-one", "owner@example.test"],
      ["actor-one", "owner@example.test"],
    ]);
    expect(mocks.claimQueuedAgentRun).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered parent owner before opening a broadened read scope", async () => {
    const harness = workerHarness({
      legacyParentOwner: true,
      tamperedJobParentOwner: "attacker@example.test",
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "job_envelope_mismatch",
    });
    expect(mocks.databaseActorScopes).toEqual([]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(harness.run.status).toBe("failed");
    expect(harness.execution.state).toBe("failed");
  });

  it("rejects a missing owner binding on a newly bound contract", async () => {
    const harness = workerHarness({
      legacyParentOwner: true,
      omitJobParentOwner: true,
    });

    const result = await processDelegationExecutionJob(harness.job);

    expect(result).toMatchObject({
      status: "failed",
      message: "job_envelope_mismatch",
    });
    expect(mocks.databaseActorScopes).toEqual([]);
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(harness.run.status).toBe("failed");
    expect(harness.execution.state).toBe("failed");
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
  legacyParentOwner?: boolean;
  tamperedJobParentOwner?: string;
  omitJobParentOwner?: boolean;
  invalidLifecycleBudget?: boolean;
  childSummary?: string;
  childEvidenceIds?: string[];
  childGrounding?: AgentRunRecord["grounding"];
  criterion?: {
    statement: string;
    verificationMethod: "schema" | "evidence" | "governed_receipt" | "parent_verifier";
    requiredGovernedToolIds?: string[];
  };
  criteria?: Array<{
    statement: string;
    verificationMethod: "schema" | "evidence" | "governed_receipt" | "parent_verifier";
    requiredGovernedToolIds?: string[];
  }>;
  optionalGrantedToolIds?: string[];
  governedToolReceipts?: Array<{ toolId: string; executionId: string }>;
  childToolExecutionIds?: string[];
} = {}) {
  const tenantId = "tenant-one";
  const actorId = "actor-one";
  const parentOwnerActorId = options.legacyParentOwner
    ? "owner@example.test"
    : actorId;
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
  const criteria = options.criteria || (options.criterion ? [options.criterion] : []);
  const governedToolIds = [...new Set([
    ...criteria.flatMap((criterion) => criterion.requiredGovernedToolIds || []),
    ...(options.optionalGrantedToolIds || []),
  ])];
  const executionGrants = {
    grantRequestSha256: canonicalJsonSha256({
      governedReadToolIds: governedToolIds,
      skillIds: [],
      plugins: [],
      mcpServers: [],
    }),
    contextGrantIds: [],
    capabilityGrantIds: [],
    governedToolIds,
    connectorTargets: [],
    skills: [],
    mcpServers: [],
    plugins: [],
  };
  const contract = buildExecutionContract({
    budgets: options.invalidLifecycleBudget
      ? {
          ...DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
          modelTurns: DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.modelTurns - 1,
        }
      : DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
    lineage: {
      tenantId,
      initiatingActorId: actorId,
      rootExecutionId: "run-root",
      rootPrincipalId: parentIdentityPin.principalId,
      parentExecutionId: "run-root",
      parentPrincipalId: parentIdentityPin.principalId,
      parentDelegationId: null,
      depth: 1,
      maxDepth: 1,
      workspaceId: null,
      projectId: null,
      workItemId: null,
      correlationSha256: "a".repeat(64),
      parentOwnerActorIdSha256: createHash("sha256")
        .update(parentOwnerActorId, "utf8")
        .digest("hex"),
    },
    ...(criteria.length
      ? {
          acceptance: {
            acceptanceId: "acceptance:execution:worker-test",
            criteria: criteria.map((criterion, index) => ({
              criterionId: index === 0
                ? "criterion:execution:one"
                : `criterion:execution:${index + 1}`,
              statement: criterion.statement,
              criterionSha256: canonicalJsonSha256({
                statement: criterion.statement,
                ...(criterion.requiredGovernedToolIds
                  ? {
                      requiredGovernedToolIds:
                        criterion.requiredGovernedToolIds,
                    }
                  : {}),
              }),
              verificationMethod: criterion.verificationMethod,
              required: true as const,
              ...(criterion.requiredGovernedToolIds
                ? {
                    requiredGovernedToolIds:
                      criterion.requiredGovernedToolIds,
                  }
                : {}),
            })),
          },
        }
      : {}),
    grants: executionGrants,
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
        governedToolIds,
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
    grounding: options.childGrounding,
    startedAt: createdAt,
  };
  const childScope = executionScopeFromDelegationContract(contract);
  const parentRun: AgentRunRecord = {
    id: contract.lineage.parentExecutionId,
    tenantId,
    ownerActorId: options.parentOwnerMismatch
      ? "actor-other"
      : parentOwnerActorId,
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
    initiatingActorId: parentOwnerActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: parentIdentityPin.principalId,
    delegationId: null,
    correlationId: parentRun.id,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: options.parentScopePurpose || "agent.run",
  });
  const transitions: string[] = [];
  const job = delegationJob(
    execution,
    childScope,
    options.omitJobParentOwner
      ? undefined
      : options.tamperedJobParentOwner || parentOwnerActorId,
  );

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
  mocks.revalidateGrants.mockResolvedValue({
    skills: [],
    governedToolIds,
  });
  if (options.governedToolReceipts) {
    mocks.listStreamEvents.mockResolvedValue([
      {
        id: "event:model:one",
        streamId: "run:run-child",
        type: "run.model",
        payload: {
          model: "configured-council-model",
          usageReceiptId: "usage:one",
        },
        createdAt,
      },
      ...options.governedToolReceipts.map((receipt, index) => ({
        id: `event:tool:${index}`,
        streamId: "run:run-child",
        type: "run.tool",
        payload: { ...receipt, status: "executed" },
        createdAt,
      })),
    ]);
  }
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
        summary: options.childSummary || "Evidence-backed bounded result.",
        evidenceIds: options.childEvidenceIds || [],
        toolExecutionIds: options.childToolExecutionIds || [],
        acceptanceChecks: execution.contract.acceptance.criteria.map(
          (criterion) => ({
            criterionId: criterion.criterionId,
            passed: true,
            note: "The bounded result satisfies the requested criterion.",
            evidenceIds: options.childEvidenceIds || [],
            toolExecutionIds: options.childToolExecutionIds || [],
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

function verifierGeneration(
  overrides: Partial<ReturnType<typeof verifierGenerationBase>> = {},
) {
  return { ...verifierGenerationBase(), ...overrides };
}

function verifierGenerationBase() {
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
  parentOwnerActorId: string | undefined,
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
      ...(parentOwnerActorId ? { parentOwnerActorId } : {}),
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
