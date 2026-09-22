import { createHash } from "node:crypto";

import { arsenalAgents } from "@/lib/agents/arsenal";
import { buildAgentRunIdentityPinV1 } from "@/lib/agents/identity-contracts";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
import {
  AGENT_REASONING_EFFORT,
  OPERATION_QUEUE_LEASE_SECONDS,
  hasAnthropicKey,
  hasGeminiKey,
  hasOpenAIKey,
} from "@/lib/config";
import {
  getDelegationExecution,
  transitionDelegationExecution,
} from "@/lib/delegation/execution-store";
import type {
  DelegationExecutionRecordV1,
  DelegationExecutionTransition,
} from "@/lib/delegation/execution-record";
import {
  exactDelegationRuntime,
  executionScopeFromDelegationContract,
} from "@/lib/delegation/runtime";
import { DYNAMIC_DELEGATION_READ_TOOL_IDS } from "@/lib/delegation/runtime-policy";
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
  try {
    assertJobEnvelope(job, payload, execution);
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
  const [boundScope, childIdentityPin, parentIdentityPin] = await Promise.all([
    getAgentRunExecutionScope(payload.runId, { tenantId: job.tenantId }),
    getAgentRunIdentityPin(payload.runId, { tenantId: job.tenantId }),
    getAgentRunIdentityPin(execution.parentExecutionId, {
      tenantId: job.tenantId,
    }),
  ]);
  if (
    !run ||
    run.agentId !== execution.delegateAgentId ||
    !boundScope ||
    !executionScopesEqual(boundScope, childScope) ||
    childIdentityPin?.pinSha256 !==
      execution.contract.delegateIdentity.identityPinSha256 ||
    parentIdentityPin?.pinSha256 !==
      execution.contract.delegatorIdentity.identityPinSha256
  ) {
    return failBeforeExecution(job, execution, childScope, "identity_binding_mismatch", run);
  }

  try {
    await assertRuntimeAssignmentCurrent(execution);
  } catch {
    return failBeforeExecution(job, execution, childScope, "runtime_assignment_changed", run);
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
        toolIds: [...DYNAMIC_DELEGATION_READ_TOOL_IDS],
        skills: [],
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
  const groundingValid = !run.grounding ||
    !["invalid", "missing"].includes(run.grounding.status);
  const acceptanceChecks = execution.contract.acceptance.criteria.map((criterion) => ({
    criterionId: criterion.criterionId,
    passed: groundingValid,
    evidenceIds,
    note: groundingValid
      ? "The child proposed a non-empty result; independent acceptance is pending."
      : "The child result did not satisfy its grounding boundary.",
  }));
  let proposed = await transitionDelegationExecution({
    tenantId: job.tenantId,
    executionId: execution.executionId,
    expectedRevision: execution.lifecycleRevision,
    transition: {
      to: "completed_proposed",
      result: {
        status: groundingValid ? "completed" : "blocked",
        summary: response.slice(0, 4_000),
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
        toolExecutionIds: [],
        modelReceiptSha256s,
        usageReceiptSha256s,
      },
    },
    executionScope: childScope,
  });

  const parentScope = parentVerificationScope(proposed);
  try {
    const verifierIdentity = await resolveAgentIdentityForExecution({
      tenantId: job.tenantId,
      actorId: execution.ownerActorId,
      agentId: "sentinel",
    });
    const verifierPin = buildAgentRunIdentityPinV1({
      runId: proposed.parentExecutionId,
      identity: verifierIdentity,
    });
    if (
      verifierPin.pinSha256 !==
      proposed.contract.verifier.identity.identityPinSha256
    ) {
      throw new Error("Verifier identity changed after contracting.");
    }
    const deterministicPass = groundingValid &&
      proposed.result!.artifacts.length > 0 &&
      modelReceiptSha256s.length > 0 &&
      acceptanceChecks.every((check) => check.passed);
    const verdict = await reviewCouncilResponse({
      goal: run.prompt
        .split("Untrusted parent transcript for context only:")[0]
        .slice(0, 12_000),
      response,
      contributions: [],
      contextBlock:
        "Judge only the candidate result and its immutable acceptance/evidence receipts. Missing evidence must fail.",
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
        credentialSource: "deployment_environment",
      },
    });
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

function assertJobEnvelope(
  job: OperationJobRecord,
  payload: ReturnType<typeof parseDelegationExecutionJobPayload>,
  execution: DelegationExecutionRecordV1,
) {
  if (
    job.type !== "agent.execute" ||
    execution.tenantId !== job.tenantId ||
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

async function failBeforeExecution(
  job: OperationJobRecord,
  execution: DelegationExecutionRecordV1,
  childScope: ExecutionScope,
  code: string,
  run?: AgentRunRecord,
): Promise<DelegationExecutionJobResult> {
  if (run && !["completed", "failed", "canceled"].includes(run.status)) {
    await failAgentRun(run.id, `Delegation failed closed: ${code}.`, {
      tenantId: job.tenantId,
      executionScope: childScope,
    }).catch(() => false);
  }
  let terminal = execution;
  if (!isTerminal(execution.state)) {
    const expired = Date.now() >= Date.parse(execution.completeBy);
    const transition: DelegationExecutionTransition = expired
      ? { to: "expired" }
      : { to: "failed", code: safeFailureCode(code) };
    terminal = await transitionDelegationExecution({
      tenantId: job.tenantId,
      executionId: execution.executionId,
      expectedRevision: execution.lifecycleRevision,
      transition,
      executionScope: expired ? parentVerificationScope(execution) : childScope,
    }).catch(() => execution);
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
