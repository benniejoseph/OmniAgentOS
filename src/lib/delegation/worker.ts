import { createHash } from "node:crypto";
import { z } from "zod";

import { arsenalAgents } from "@/lib/agents/arsenal";
import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityForVersionV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";
import {
  AGENT_REASONING_EFFORT,
  OPERATION_QUEUE_LEASE_SECONDS,
  hasAnthropicKey,
  hasGeminiKey,
  hasOpenAIKey,
} from "@/lib/config";
import { runWithDatabaseActorScope } from "@/lib/db/client";
import {
  getDelegationExecution,
  transitionDelegationExecution,
} from "@/lib/delegation/execution-store";
import type {
  DelegationExecutionRecordV1,
  DelegationExecutionTransition,
} from "@/lib/delegation/execution-record";
import {
  revalidateDelegationGrantsV1,
  type DelegationGrantRuntimeV1,
} from "@/lib/delegation/grant-resolver";
import {
  appendDelegationGrantValidation,
} from "@/lib/delegation/grant-validation-events";
import {
  exactDelegationRuntime,
  executionScopeFromDelegationContract,
} from "@/lib/delegation/runtime";
import {
  parseDelegationExecutionJobPayload,
} from "@/lib/delegation/runtime-job";
import { listStreamEvents } from "@/lib/events/store";
import { selectAgentModel } from "@/lib/openai/model-router";
import { runAgent } from "@/lib/orchestration/agent-runner";
import { modelAssignmentScopeForAgent } from "@/lib/orchestration/computer-use-routing";
import { reviewCouncilResponse } from "@/lib/orchestration/council";
import {
  completeOperationJob,
  failOperationJob,
  heartbeatOperationJob,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  claimQueuedAgentRun,
  failAgentRun,
  getAgentRun,
  getAgentRunExecutionScope,
  getAgentRunIdentityPin,
} from "@/lib/runs/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import {
  createExecutionScope,
  executionScopesEqual,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { resolveRuntimeModelAssignment } from "@/lib/settings/runtime-models";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export type DelegationExecutionJobResult = Readonly<{
  job: OperationJobRecord;
  runId?: string;
  status: "completed" | "failed" | "stale";
  message?: string;
}>;

/** Executes an already-contracted child and never broadens its authority. */
export async function processDelegationExecutionJob(
  job: OperationJobRecord,
  deadline?: number,
): Promise<DelegationExecutionJobResult> {
  const payload = parseDelegationExecutionJobPayload(job.payload);
  let execution = await getDelegationExecution({
    tenantId: job.tenantId,
    ownerActorId: payload.actorId,
    executionId: payload.executionId,
  });
  const childScope = executionScopeFromDelegationContract(execution.contract);
  let parentOwnerActorId: string;
  try {
    assertJobEnvelope(job, payload, execution);
    parentOwnerActorId = boundParentOwnerActorId(payload, execution);
  } catch {
    return failBeforeExecution(job, execution, childScope, "job_envelope_mismatch");
  }
  if (!executionScopesEqual(childScope, payload.executionScope)) {
    return failBeforeExecution(job, execution, childScope, "job_scope_mismatch");
  }

  if (isTerminal(execution.state)) {
    return completeTerminalJob(job, execution);
  }
  if (execution.state === "queued" && Date.now() >= Date.parse(execution.acceptBy)) {
    return failBeforeExecution(job, execution, childScope, "acceptance_deadline_expired");
  }

  let run = await getAgentRun(payload.runId, { tenantId: job.tenantId });
  const [boundScope, childIdentityPin] = await Promise.all([
    getAgentRunExecutionScope(payload.runId, { tenantId: job.tenantId }),
    getAgentRunIdentityPin(payload.runId, { tenantId: job.tenantId }),
  ]);
  const [parentRun, parentScope, parentIdentityPin] =
    await runWithDatabaseActorScope(
      job.tenantId,
      exactParentReadActorIds(execution.ownerActorId, parentOwnerActorId),
      () => Promise.all([
        getAgentRun(execution.parentExecutionId, { tenantId: job.tenantId }),
        getAgentRunExecutionScope(execution.parentExecutionId, {
          tenantId: job.tenantId,
        }),
        getAgentRunIdentityPin(execution.parentExecutionId, {
          tenantId: job.tenantId,
        }),
      ]),
    );
  if (
    !run ||
    run.agentId !== execution.delegateAgentId ||
    run.ownerActorId !== execution.ownerActorId ||
    !boundScope ||
    !executionScopesEqual(boundScope, childScope) ||
    !childIdentityPin ||
    childIdentityPin.pinSha256 !==
      execution.contract.delegateIdentity.identityPinSha256 ||
    childIdentityPin.runId !== run.id ||
    childIdentityPin.tenantId !== execution.tenantId ||
    childIdentityPin.actorId !== execution.ownerActorId ||
    childIdentityPin.logicalAgentId !== run.agentId ||
    childIdentityPin.principalId !== boundScope.executingPrincipalId ||
    boundScope.initiatingActorId !== execution.ownerActorId ||
    !parentRun ||
    !parentScope ||
    !parentIdentityPin ||
    parentIdentityPin.pinSha256 !==
      execution.contract.delegatorIdentity.identityPinSha256 ||
    parentIdentityPin.actorId !== execution.ownerActorId ||
    parentIdentityPin.tenantId !== execution.tenantId ||
    parentIdentityPin.runId !== parentRun.id ||
    parentIdentityPin.logicalAgentId !== parentRun.agentId ||
    parentIdentityPin.principalId !== parentScope.executingPrincipalId ||
    parentRun.id !== execution.parentExecutionId ||
    parentRun.ownerActorId !== parentOwnerActorId ||
    parentRun.ownerActorId !== parentScope.initiatingActorId ||
    parentScope.tenantId !== execution.tenantId ||
    parentScope.correlationId !== execution.parentExecutionId ||
    parentScope.executingPrincipalType !== "agent" ||
    parentScope.delegationId !== null ||
    parentScope.purpose !== "agent.run"
  ) {
    return failBeforeExecution(job, execution, childScope, "identity_binding_mismatch", run);
  }
  if (!personaPromptBindingMatches(execution, run)) {
    return failBeforeExecution(
      job,
      execution,
      childScope,
      "persona_prompt_binding_mismatch",
      run,
    );
  }

  try {
    await assertRuntimeAssignmentCurrent(execution);
  } catch {
    return failBeforeExecution(job, execution, childScope, "runtime_assignment_changed", run);
  }
  try {
    await assertVerifierRuntimeAssignmentCurrent(execution);
  } catch {
    return failBeforeExecution(
      job,
      execution,
      childScope,
      "verifier_runtime_assignment_changed",
      run,
    );
  }
  let grantRuntime: DelegationGrantRuntimeV1;
  try {
    const parentEvents = await runWithDatabaseActorScope(
      job.tenantId,
      exactParentReadActorIds(execution.ownerActorId, parentOwnerActorId),
      () => listStreamEvents(
        `run:${execution.parentExecutionId}`,
        {
          tenantId: job.tenantId,
          actorId: parentOwnerActorId,
          limit: 200,
          order: "asc",
        },
      ),
    );
    grantRuntime = await revalidateDelegationGrantsV1({
      contract: execution.contract,
      parentIdentityPin: parentIdentityPin!,
      delegateIdentityPin: childIdentityPin!,
      parentEvents,
    });
  } catch {
    try {
      await appendDelegationGrantValidation({
        execution,
        executionScope: childScope,
        status: "changed",
      });
    } catch {
      return failBeforeExecution(
        job,
        execution,
        childScope,
        "grant_validation_unavailable",
        run,
      );
    }
    return failBeforeExecution(
      job,
      execution,
      childScope,
      "grant_assignment_changed",
      run,
    );
  }
  try {
    await appendDelegationGrantValidation({
      execution,
      executionScope: childScope,
      status: "current",
    });
  } catch {
    return failBeforeExecution(
      job,
      execution,
      childScope,
      "grant_validation_unavailable",
      run,
    );
  }

  if (execution.state === "queued") {
    execution = await transitionDelegationExecution({
      tenantId: job.tenantId,
      executionId: execution.executionId,
      expectedRevision: execution.lifecycleRevision,
      transition: { to: "running" },
      executionScope: childScope,
    });
  }

  if (run.status === "queued") {
    const claimed = await claimQueuedAgentRun(run.id, { tenantId: job.tenantId });
    if (!claimed) {
      const current = await getAgentRun(run.id, { tenantId: job.tenantId });
      if (!current) {
        return failBeforeExecution(job, execution, childScope, "child_run_missing");
      }
      run = current;
    } else {
      run = claimed;
    }
  }
  if (["completed", "failed", "canceled"].includes(run.status)) {
    return finalizeChildRun(job, execution, childScope, run);
  }
  if (run.status !== "running") {
    return failBeforeExecution(job, execution, childScope, "child_run_not_claimable", run);
  }

  const controller = new AbortController();
  const executionDeadline = Math.min(
    deadline ?? Number.POSITIVE_INFINITY,
    Date.parse(execution.completeBy) - 25_000,
    Date.now() + execution.budgetLimits.wallTimeMs,
  );
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error("Delegation execution exceeded its deadline.")),
    Math.max(1, executionDeadline - Date.now() - 1_000),
  );
  let leaseLost = false;
  let heartbeatChain = Promise.resolve();
  const heartbeat = async () => {
    try {
      const [renewed, current] = await Promise.all([
        heartbeatOperationJob(job.id, job.leaseOwner || "", {
          tenantId: job.tenantId,
          leaseSeconds: Math.max(OPERATION_QUEUE_LEASE_SECONDS, 180),
        }),
        getAgentRun(run!.id, { tenantId: job.tenantId }),
      ]);
      if (renewed && current && current.status !== "canceled") return;
      leaseLost = true;
      controller.abort(new Error("Delegation lease or child run was canceled."));
    } catch (error) {
      leaseLost = true;
      controller.abort(
        error instanceof Error ? error : new Error("Delegation heartbeat failed."),
      );
    }
  };
  await heartbeat();
  if (leaseLost) {
    clearTimeout(deadlineTimer);
    return { job, runId: run.id, status: "stale", message: "Delegation lease was stale." };
  }
  const heartbeatTimer = setInterval(() => {
    heartbeatChain = heartbeatChain.then(heartbeat, heartbeat);
  }, 5_000);

  try {
    const agent = arsenalAgents.find((candidate) => candidate.id === run!.agentId);
    if (!agent) throw new Error("The contracted child Agent is unavailable.");
    for await (const event of runAgent({
      preclaimedRunId: run.id,
      executionScope: childScope,
      mode: run.mode,
      messages: run.messages,
      tenantId: job.tenantId,
      actorId: execution.ownerActorId,
      role: "operator",
      agentId: execution.delegateAgentId,
      agentIdentity: exactBuiltInIdentityForPin(childIdentityPin!),
      specialistIds: [],
      runtimeModelPin: {
        provider: runtimeProvider(execution.contract.runtimeAssignment.providerId),
        model: execution.contract.runtimeAssignment.modelId,
        tier: execution.contract.runtimeAssignment.modelTier,
        routingPolicySha256:
          execution.contract.runtimeAssignment.routingPolicySha256,
      },
      agentProfile: {
        name: agent.name,
        role: agent.role,
        description: agent.description,
        instructions: agent.persona.operatingStyle,
        persona: agent.persona,
        modelPolicy: "auto",
        autonomy: "assist",
        approvalPolicy: "read_only",
        memoryScope: "all",
        toolIds: [...grantRuntime.governedToolIds],
        skills: grantRuntime.skills.map((skill) => ({
          ...skill,
          toolIds: [...skill.toolIds],
        })),
      },
      budgetLimits: execution.budgetLimits,
    }, controller.signal)) {
      void event;
    }
  } catch (error) {
    if (!leaseLost) {
      await failAgentRun(
        run.id,
        error instanceof Error ? error.message : "Delegation execution failed.",
        { tenantId: job.tenantId, executionScope: childScope },
      );
    }
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(heartbeatTimer);
    await heartbeatChain;
  }
  if (leaseLost) {
    return { job, runId: run.id, status: "stale", message: "Delegation lease was lost." };
  }
  const terminal = await getAgentRun(run.id, { tenantId: job.tenantId });
  if (!terminal) {
    return failBeforeExecution(job, execution, childScope, "child_run_missing");
  }
  if (!["completed", "failed", "canceled"].includes(terminal.status)) {
    await failAgentRun(
      terminal.id,
      "Delegation ended without a terminal child-run receipt and was not replayed.",
      { tenantId: job.tenantId, executionScope: childScope },
    );
    const failed = await getAgentRun(terminal.id, { tenantId: job.tenantId });
    return finalizeChildRun(job, execution, childScope, failed || terminal);
  }
  return finalizeChildRun(job, execution, childScope, terminal);
}

async function finalizeChildRun(
  job: OperationJobRecord,
  execution: DelegationExecutionRecordV1,
  childScope: ExecutionScope,
  run: AgentRunRecord,
): Promise<DelegationExecutionJobResult> {
  if (run.status !== "completed") {
    return failBeforeExecution(
      job,
      execution,
      childScope,
      run.status === "canceled" ? "child_canceled" : "child_run_failed",
      run,
    );
  }
  const response = (run.response || "").trim();
  const responseBytes = Buffer.byteLength(response, "utf8");
  if (!response || responseBytes > execution.contract.output.maxBytes) {
    return failBeforeExecution(job, execution, childScope, "invalid_child_output", run);
  }
  const runEvents = await listStreamEvents(`run:${run.id}`, {
    tenantId: job.tenantId,
    actorId: execution.ownerActorId,
    limit: 2_000,
    order: "asc",
  });
  const modelReceiptSha256s = unique(runEvents
    .filter((event) => event.type === "run.model")
    .map((event) => canonicalJsonSha256(event.payload)));
  const usageReceiptSha256s = unique(runEvents
    .filter((event) =>
      event.type === "run.model" &&
      Boolean((event.payload as Record<string, unknown>)?.usageReceiptId)
    )
    .map((event) => canonicalJsonSha256({
      usageReceiptId: (event.payload as Record<string, unknown>).usageReceiptId,
    })));
  const evidenceIds = unique(run.grounding?.citedIds || []).filter(safeId);
  const toolExecutionIds = unique(runEvents
    .filter((event) => {
      if (event.type !== "run.tool") return false;
      const payload = event.payload as Record<string, unknown>;
      return payload.status === "executed" &&
        typeof payload.executionId === "string" &&
        safeId(payload.executionId);
    })
    .map((event) =>
      String((event.payload as Record<string, unknown>).executionId)
    ));
  const groundingValid = !run.grounding ||
    !["invalid", "missing"].includes(run.grounding.status);
  const candidate = parseDelegationCandidate(response);
  const acceptanceChecks = evaluateAcceptanceCriteria({
    execution,
    candidate,
    groundingValid,
    evidenceIds,
    toolExecutionIds,
    modelReceiptSha256s,
    usageReceiptSha256s,
  });
  const deterministicPass = Boolean(candidate) &&
    acceptanceChecks.every((check) => check.passed);
  let proposed = await transitionDelegationExecution({
    tenantId: job.tenantId,
    executionId: execution.executionId,
    expectedRevision: execution.lifecycleRevision,
    transition: {
      to: "completed_proposed",
      result: {
        status: deterministicPass ? "completed" : "blocked",
        summary: (candidate?.summary || "The child result failed its closed output contract.")
          .slice(0, 4_000),
        artifacts: [{
          artifactId: `delegation-result:${sha256(response).slice(0, 40)}`,
          artifactSha256: sha256(response),
          kind: "result",
          mediaType: "text/plain",
          byteCount: responseBytes,
          evidenceIds,
        }],
        acceptanceChecks,
        evidenceIds,
        toolExecutionIds,
        modelReceiptSha256s,
        usageReceiptSha256s,
      },
    },
    executionScope: childScope,
  });

  const parentScope = parentVerificationScope(proposed);
  try {
    const verifierIdentity = buildBuiltInAgentIdentityForVersionV1({
      agentId: "sentinel",
      tenantId: proposed.contract.lineage.tenantId,
      controllerActorId: proposed.contract.lineage.initiatingActorId,
      definitionVersion: exactBuiltInDefinitionVersion(
        proposed.contract.verifier.identity.definitionVersion,
      ),
    });
    const verifierPin = buildAgentRunIdentityPinV1({
      runId: proposed.contract.verifier.identity.runId,
      identity: verifierIdentity,
    });
    if (
      verifierPin.pinSha256 !==
      proposed.contract.verifier.identity.identityPinSha256
    ) {
      throw new Error("Verifier identity changed after contracting.");
    }
    let verifierModelReceiptSha256: string | undefined;
    const verdict = await reviewCouncilResponse({
      goal: proposed.contract.objective,
      response: candidate?.summary || response.slice(0, 16_000),
      contributions: [],
      contextBlock:
        JSON.stringify({
          instruction:
            "Judge only the candidate result and these immutable content-free acceptance/evidence receipts. Missing evidence must fail.",
          acceptanceChecks,
          artifactSha256: proposed.result!.artifacts[0]?.artifactSha256 || null,
          evidenceIds,
          toolExecutionIds,
          modelReceiptSha256s,
          usageReceiptSha256s,
        }).slice(0, 8_000),
      abortSignal: AbortSignal.timeout(Math.max(
        1,
        Date.parse(proposed.completeBy) - Date.now() - 1_000,
      )),
      usageAttribution: {
        tenantId: job.tenantId,
        actorId: execution.ownerActorId,
        sourceStreamId: `delegation-execution:${execution.delegationId}`,
        correlationId: execution.rootExecutionId,
        causationId: execution.executionId,
        executionScope: parentScope,
        credentialSource:
          proposed.contract.verifier.runtimeAssignment.routingPolicyId
              .endsWith(":tenant_assignment")
            ? "tenant_vault"
            : "deployment_environment",
      },
      checkpointHooks: {
        afterModel: async (input) => {
          if (input.status !== "completed" || !input.generated) return;
          const assigned = proposed.contract.verifier.runtimeAssignment;
          if (
            input.generated.provider !== assigned.providerId ||
            input.generated.model !== assigned.modelId ||
            assigned.modelTier !== "reasoning"
          ) {
            throw new Error(
              "Sentinel executed on a runtime other than its immutable assignment.",
            );
          }
          verifierModelReceiptSha256 = canonicalJsonSha256({
            runtimeAssignmentSha256: assigned.assignmentSha256,
            providerId: input.generated.provider,
            modelId: input.generated.model,
            modelTier: assigned.modelTier,
            usageReceiptId: input.generated.usageReceiptId || null,
            attemptCount: input.generated.attempts.length,
          });
        },
      },
    });
    if (!verifierModelReceiptSha256) {
      throw new Error("Sentinel did not return an exact model execution receipt.");
    }
    const accepted = deterministicPass &&
      verdict.passed &&
      verdict.score >= proposed.contract.verifier.acceptanceThreshold;
    proposed = await transitionDelegationExecution({
      tenantId: job.tenantId,
      executionId: proposed.executionId,
      expectedRevision: proposed.lifecycleRevision,
      transition: {
        to: accepted ? "verified" : "rejected",
        verification: {
          verifierAgentId: verifierPin.logicalAgentId,
          verifierDefinitionVersion: verifierPin.definitionVersion,
          verifierPrincipalId: verifierPin.principalId,
          verifierRuntimeAssignmentId:
            proposed.contract.verifier.runtimeAssignment.assignmentId,
          verifierRuntimeAssignmentSha256:
            proposed.contract.verifier.runtimeAssignment.assignmentSha256,
          verifierProviderId:
            proposed.contract.verifier.runtimeAssignment.providerId,
          verifierModelId:
            proposed.contract.verifier.runtimeAssignment.modelId,
          verifierModelTier:
            proposed.contract.verifier.runtimeAssignment.modelTier,
          verifierModelReceiptSha256,
          score: deterministicPass ? verdict.score : 0,
          acceptanceChecksSha256: canonicalJsonSha256(
            proposed.result!.acceptanceChecks,
          ),
          evidenceIds,
          note: [
            deterministicPass
              ? "Deterministic schema, artifact, model-receipt, and grounding checks passed."
              : "Deterministic acceptance checks failed.",
            verdict.assessment,
            verdict.requiredChanges.length
              ? `Required changes: ${verdict.requiredChanges.join("; ")}`
              : "",
          ].filter(Boolean).join(" ").slice(0, 2_000),
        },
      },
      executionScope: parentScope,
    });
  } catch {
    return failBeforeExecution(
      job,
      proposed,
      childScope,
      "verifier_unavailable",
      run,
    );
  }
  return completeTerminalJob(job, proposed);
}

async function assertRuntimeAssignmentCurrent(
  execution: DelegationExecutionRecordV1,
) {
  const mode = execution.delegateAgentId === "forge"
    ? "execute" as const
    : execution.delegateAgentId === "mnemosyne"
      ? "learn" as const
      : "research" as const;
  const deploymentRoute = selectAgentModel({
    message: execution.contract.objective,
    mode,
    specialistCount: 0,
    modelPolicy: "auto",
  });
  const scope = modelAssignmentScopeForAgent(execution.delegateAgentId);
  const runtimeModel = await resolveRuntimeModelAssignment({
    tenantId: execution.tenantId,
    actorId: execution.ownerActorId,
    scope,
    tier: deploymentRoute.tier,
    requiredFeature: "tools",
    deploymentFallback: {
      provider: deploymentRoute.provider,
      model: deploymentRoute.model,
      fallbackModel: deploymentRoute.fallbackModel,
      reason: deploymentRoute.reason,
      configured: hasOpenAIKey() || hasGeminiKey() || hasAnthropicKey(),
    },
  });
  if (!runtimeModel.configured) throw new Error("Delegation model is unavailable.");
  const exact = exactDelegationRuntime({ runtimeModel, deploymentRoute, scope });
  const assigned = execution.contract.runtimeAssignment;
  if (
    exact.provider !== assigned.providerId ||
    exact.model !== assigned.modelId ||
    exact.tier !== assigned.modelTier ||
    exact.routingPolicyId !== assigned.routingPolicyId ||
    exact.routingPolicySha256 !== assigned.routingPolicySha256 ||
    assigned.normalizedReasoningEffort !== AGENT_REASONING_EFFORT
  ) {
    throw new Error("Delegation runtime assignment changed.");
  }
}

async function assertVerifierRuntimeAssignmentCurrent(
  execution: DelegationExecutionRecordV1,
) {
  const deploymentRoute = selectAgentModel({
    message: `Verify this bounded delegated result: ${execution.contract.objective}`,
    mode: "research",
    specialistCount: 1,
    modelPolicy: "auto",
  });
  const scope = modelAssignmentScopeForAgent("sentinel");
  const runtimeModel = await resolveRuntimeModelAssignment({
    tenantId: execution.tenantId,
    actorId: execution.ownerActorId,
    scope,
    tier: deploymentRoute.tier,
    requiredFeature: "json_schema",
    deploymentFallback: {
      provider: deploymentRoute.provider,
      model: deploymentRoute.model,
      fallbackModel: deploymentRoute.fallbackModel,
      reason: deploymentRoute.reason,
      configured: hasOpenAIKey() || hasGeminiKey() || hasAnthropicKey(),
    },
  });
  if (!runtimeModel.configured) throw new Error("Verifier model is unavailable.");
  const exact = exactDelegationRuntime({ runtimeModel, deploymentRoute, scope });
  const assigned = execution.contract.verifier.runtimeAssignment;
  if (
    exact.provider !== assigned.providerId ||
    exact.model !== assigned.modelId ||
    exact.tier !== assigned.modelTier ||
    exact.routingPolicyId !== assigned.routingPolicyId ||
    exact.routingPolicySha256 !== assigned.routingPolicySha256 ||
    assigned.normalizedReasoningEffort !== AGENT_REASONING_EFFORT
  ) {
    throw new Error("Verifier runtime assignment changed.");
  }
}

const delegationCandidateSchema = z.object({
  summary: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(z.string().trim().min(1).max(240))
    .max(64).refine(uniqueStrings),
  toolExecutionIds: z.array(z.string().trim().min(1).max(240))
    .max(64).refine(uniqueStrings),
  acceptanceChecks: z.array(z.object({
    criterionId: z.string().trim().min(1).max(240),
    passed: z.boolean(),
    note: z.string().trim().max(2_000),
    evidenceIds: z.array(z.string().trim().min(1).max(240))
      .max(64).refine(uniqueStrings),
    toolExecutionIds: z.array(z.string().trim().min(1).max(240))
      .max(64).refine(uniqueStrings),
  }).strict()).min(1).max(24).refine(
    (checks) => uniqueStrings(checks.map((check) => check.criterionId)),
  ),
}).strict();

type DelegationCandidate = z.infer<typeof delegationCandidateSchema>;

function parseDelegationCandidate(response: string): DelegationCandidate | undefined {
  try {
    return delegationCandidateSchema.parse(JSON.parse(response));
  } catch {
    return undefined;
  }
}

function evaluateAcceptanceCriteria(input: {
  execution: DelegationExecutionRecordV1;
  candidate?: DelegationCandidate;
  groundingValid: boolean;
  evidenceIds: readonly string[];
  toolExecutionIds: readonly string[];
  modelReceiptSha256s: readonly string[];
  usageReceiptSha256s: readonly string[];
}) {
  const evidence = new Set(input.evidenceIds);
  const toolExecutions = new Set(input.toolExecutionIds);
  const candidate = input.candidate;
  const candidateClaimsValid = Boolean(candidate) &&
    candidate!.evidenceIds.every((id) => evidence.has(id)) &&
    candidate!.toolExecutionIds.every((id) => toolExecutions.has(id));
  const candidateChecks = new Map(
    (candidate?.acceptanceChecks || []).map((check) => [check.criterionId, check]),
  );
  const hasArtifactReceipt = Boolean(input.execution.contract.output.maxArtifacts > 0);
  const hasModelReceipt = input.modelReceiptSha256s.length > 0;
  const hasUsageReceipt = input.usageReceiptSha256s.length > 0;

  return input.execution.contract.acceptance.criteria.map((criterion) => {
    const claimed = candidateChecks.get(criterion.criterionId);
    const claimedEvidence = unique([
      ...(candidate?.evidenceIds || []),
      ...(claimed?.evidenceIds || []),
    ]);
    const claimedTools = unique([
      ...(candidate?.toolExecutionIds || []),
      ...(claimed?.toolExecutionIds || []),
    ]);
    const evidenceClaimsValid = claimedEvidence.every((id) => evidence.has(id));
    const toolClaimsValid = claimedTools.every((id) => toolExecutions.has(id));
    const structural = Boolean(
      candidate &&
      claimed &&
      claimed.passed &&
      candidateClaimsValid &&
      evidenceClaimsValid &&
      toolClaimsValid &&
      hasArtifactReceipt &&
      hasModelReceipt &&
      hasUsageReceipt,
    );
    const receiptSatisfied = criterion.verificationMethod === "evidence"
      ? input.groundingValid && claimedEvidence.length > 0
      : criterion.verificationMethod === "governed_receipt"
        ? claimedTools.length > 0
        : true;
    const passed = structural && receiptSatisfied;
    const reason = !candidate
      ? "closed_output_missing"
      : !claimed
        ? "criterion_check_missing"
        : !claimed.passed
          ? "child_declared_unsatisfied"
          : !candidateClaimsValid || !evidenceClaimsValid || !toolClaimsValid
            ? "unbound_receipt_claim"
            : !hasModelReceipt || !hasUsageReceipt
              ? "model_usage_receipt_missing"
              : criterion.verificationMethod === "evidence" &&
                  (!input.groundingValid || claimedEvidence.length === 0)
                ? "evidence_receipt_missing"
                : criterion.verificationMethod === "governed_receipt" &&
                    claimedTools.length === 0
                  ? "governed_tool_receipt_missing"
                  : "deterministic_receipts_satisfied";
    return {
      criterionId: criterion.criterionId,
      passed,
      evidenceIds: claimedEvidence.filter((id) => evidence.has(id)),
      note: `${criterion.verificationMethod}:${reason}`,
    };
  });
}

function uniqueStrings(values: readonly string[]) {
  return new Set(values).size === values.length;
}

function assertJobEnvelope(
  job: OperationJobRecord,
  payload: ReturnType<typeof parseDelegationExecutionJobPayload>,
  execution: DelegationExecutionRecordV1,
) {
  if (
    job.type !== "agent.execute" ||
    execution.tenantId !== job.tenantId ||
    payload.actorId !== execution.ownerActorId ||
    payload.executionId !== execution.executionId ||
    payload.runId !== execution.childRunId ||
    payload.agentId !== execution.delegateAgentId ||
    payload.contractSha256 !== execution.contractSha256 ||
    payload.contextCapsuleSha256 !== execution.contextCapsuleSha256 ||
    payload.runtimeAssignmentSha256 !== execution.runtimeAssignmentSha256
  ) {
    throw new Error("Delegation job does not match its immutable execution.");
  }
}

function boundParentOwnerActorId(
  payload: ReturnType<typeof parseDelegationExecutionJobPayload>,
  execution: DelegationExecutionRecordV1,
) {
  const ownerDigest = execution.contract.lineage.parentOwnerActorIdSha256;
  if (!ownerDigest) {
    if (
      payload.parentOwnerActorId &&
      payload.parentOwnerActorId !== execution.ownerActorId
    ) {
      throw new Error("Legacy delegation jobs cannot broaden parent ownership.");
    }
    return execution.ownerActorId;
  }
  if (
    !payload.parentOwnerActorId ||
    sha256(payload.parentOwnerActorId) !== ownerDigest
  ) {
    throw new Error("Delegation parent ownership is not contract-bound.");
  }
  return payload.parentOwnerActorId;
}

function exactParentReadActorIds(
  canonicalActorId: string,
  parentOwnerActorId: string,
) {
  return canonicalActorId === parentOwnerActorId
    ? [canonicalActorId]
    : [canonicalActorId, parentOwnerActorId];
}

function personaPromptBindingMatches(
  execution: DelegationExecutionRecordV1,
  run: AgentRunRecord,
) {
  const brief = execution.contract.personaBrief;
  if (!brief) return true;
  return sha256(run.prompt) === brief.promptSha256 &&
    run.messages.length === 1 &&
    run.messages[0]?.role === "user" &&
    run.messages[0]?.content === run.prompt;
}

async function failBeforeExecution(
  job: OperationJobRecord,
  execution: DelegationExecutionRecordV1,
  childScope: ExecutionScope,
  code: string,
  run?: AgentRunRecord,
): Promise<DelegationExecutionJobResult> {
  const childRunTerminal = await failActiveChildRun(
    job,
    execution,
    childScope,
    code,
    run,
  );
  if (!childRunTerminal) {
    return {
      job,
      runId: execution.childRunId,
      status: "stale",
      message: "child_run_terminalization_unavailable",
    };
  }
  let terminal = execution;
  if (!isTerminal(execution.state)) {
    const expired = Date.now() >= Date.parse(execution.completeBy);
    const transition: DelegationExecutionTransition = expired
      ? { to: "expired" }
      : { to: "failed", code: safeFailureCode(code) };
    try {
      terminal = await transitionDelegationExecution({
        tenantId: job.tenantId,
        executionId: execution.executionId,
        expectedRevision: execution.lifecycleRevision,
        transition,
        executionScope: expired ? parentVerificationScope(execution) : childScope,
      });
    } catch {
      const current = await getDelegationExecution({
        tenantId: job.tenantId,
        ownerActorId: execution.ownerActorId,
        executionId: execution.executionId,
      }).catch(() => undefined);
      if (!current || !isTerminal(current.state)) {
        return {
          job,
          runId: execution.childRunId,
          status: "stale",
          message: "execution_terminalization_unavailable",
        };
      }
      terminal = current;
    }
  }
  const failed = await failOperationJob(
    job.id,
    `Delegation execution failed: ${code}.`,
    job.leaseOwner,
    job.tenantId,
  );
  return {
    job: failed || job,
    runId: execution.childRunId,
    status: failed?.status === "failed" ? "failed" : "stale",
    message: terminal.failureCode || code,
  };
}

async function failActiveChildRun(
  job: OperationJobRecord,
  execution: DelegationExecutionRecordV1,
  childScope: ExecutionScope,
  code: string,
  knownRun?: AgentRunRecord,
) {
  const run = knownRun || await getAgentRun(execution.childRunId, {
    tenantId: job.tenantId,
  }).catch(() => undefined);
  if (!run) return false;
  if (["completed", "failed", "canceled"].includes(run.status)) return true;
  const changed = await failAgentRun(
    execution.childRunId,
    `Delegation failed closed: ${code}.`,
    {
      tenantId: job.tenantId,
      executionScope: childScope,
    },
  ).catch(() => false);
  if (changed) return true;
  const current = await getAgentRun(execution.childRunId, {
    tenantId: job.tenantId,
  }).catch(() => undefined);
  return Boolean(
    current && ["completed", "failed", "canceled"].includes(current.status),
  );
}

async function completeTerminalJob(
  job: OperationJobRecord,
  execution: DelegationExecutionRecordV1,
): Promise<DelegationExecutionJobResult> {
  const completed = await completeOperationJob(
    job.id,
    job.leaseOwner,
    job.tenantId,
  );
  return {
    job: completed || job,
    runId: execution.childRunId,
    status: completed ? "completed" : "stale",
    ...(execution.state === "rejected"
      ? { message: execution.verification?.note || "Verifier rejected the proposal." }
      : {}),
  };
}

function parentVerificationScope(execution: DelegationExecutionRecordV1) {
  return createExecutionScope({
    tenantId: execution.tenantId,
    initiatingActorId: execution.ownerActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: execution.contract.lineage.parentPrincipalId,
    workspaceId: execution.contract.lineage.workspaceId,
    projectId: execution.contract.lineage.projectId,
    missionId: execution.contract.lineage.workItemId,
    delegationId: null,
    correlationId: execution.rootExecutionId,
    causationId: execution.executionId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "delegation.verification.v2",
  });
}

function exactBuiltInIdentityForPin(pin: AgentRunIdentityPinV1) {
  if (![
    "atlas",
    "scout",
    "meridian",
    "forge",
    "sentinel",
    "mnemosyne",
  ].includes(pin.logicalAgentId)) {
    throw new Error("The contracted child identity is not built in.");
  }
  return buildBuiltInAgentIdentityForVersionV1({
    agentId: pin.logicalAgentId as Parameters<
      typeof buildBuiltInAgentIdentityForVersionV1
    >[0]["agentId"],
    tenantId: pin.tenantId,
    controllerActorId: pin.actorId,
    definitionVersion: exactBuiltInDefinitionVersion(pin.definitionVersion),
  });
}

function exactBuiltInDefinitionVersion(value: number): 1 | 2 {
  if (value !== 1 && value !== 2) {
    throw new Error("The built-in Agent definition version is unsupported.");
  }
  return value;
}

function runtimeProvider(value: string) {
  if (["openai", "google", "anthropic", "aws_bedrock"].includes(value)) {
    return value as "openai" | "google" | "anthropic" | "aws_bedrock";
  }
  throw new Error("Delegation runtime provider is unsupported.");
}

function safeFailureCode(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._:@/+~-]+/g, "_").slice(0, 120);
}

function safeId(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(value);
}

function unique(values: readonly string[]) {
  return [...new Set(values)];
}

function isTerminal(state: DelegationExecutionRecordV1["state"]) {
  return ["verified", "rejected", "failed", "canceled", "expired"].includes(state);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
