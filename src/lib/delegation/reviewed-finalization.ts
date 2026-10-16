import { createHash } from "node:crypto";

import {
  buildAgentRunIdentityPinV1,
  buildBuiltInAgentIdentityForVersionV1,
} from "@/lib/agents/identity-contracts";
import {
  parseDelegationExecutionRecordV1,
  type DelegationExecutionRecordV1,
} from "@/lib/delegation/execution-record";
import { transitionDelegationExecution } from "@/lib/delegation/execution-store";
import {
  getDelegationReviewStages,
  type DelegationReviewStageCompletion,
  type DelegationReviewStages,
} from "@/lib/delegation/review-stage-store";
import { executionScopeFromDelegationContract } from "@/lib/delegation/runtime";
import { getSql, runWithDatabaseActorScope } from "@/lib/db/client";
import { listStreamEvents } from "@/lib/events/store";
import {
  createExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

/**
 * Consumes sealed review receipts after the child closes. It performs no model
 * calls and never revives a rejected execution or repeats an ambiguous stage.
 */
export async function finalizeReviewedDelegationProposal(input: {
  execution: DelegationExecutionRecordV1;
  childScope: ExecutionScope;
  parentScope: ExecutionScope;
  response: string;
  deterministicPass: boolean;
}): Promise<DelegationExecutionRecordV1> {
  const execution = parseDelegationExecutionRecordV1(input.execution);
  if (execution.state !== "completed_proposed" || !execution.result) {
    throw new Error("Reviewed finalization requires the one final completion proposal.");
  }
  const contract = execution.contract;
  const expectedParentScope = createExecutionScope({
    tenantId: execution.tenantId,
    initiatingActorId: execution.ownerActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: contract.lineage.parentPrincipalId,
    workspaceId: contract.lineage.workspaceId,
    projectId: contract.lineage.projectId,
    missionId: contract.lineage.workItemId,
    delegationId: null,
    correlationId: execution.rootExecutionId,
    causationId: execution.executionId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "delegation.verification.v2",
  });
  if (!executionScopesEqual(input.childScope, executionScopeFromDelegationContract(contract)) ||
      !executionScopesEqual(input.parentScope, expectedParentScope)) {
    throw new Error("Reviewed finalization is outside its exact child and parent authority.");
  }
  const stages = await getDelegationReviewStages({ contract, executionScope: input.childScope });
  const selected = selectFinalReview(stages);
  const receipt = selected.reviewReceipt!;
  const response = input.response.trim();
  const proposalSha256 = createHash("sha256").update(response).digest("hex");
  const result = execution.result;
  const artifact = result.artifacts[0];
  if (!response || result.artifacts.length !== 1 || !artifact ||
      artifact.kind !== "result" || artifact.artifactSha256 !== proposalSha256 ||
      artifact.artifactId !== `delegation-result:${proposalSha256.slice(0, 40)}` ||
      artifact.mediaType !== "text/plain" || artifact.byteCount !== Buffer.byteLength(response, "utf8") ||
      receipt.proposalSha256 !== proposalSha256 ||
      receipt.acceptanceChecksSha256 !== canonicalJsonSha256(result.acceptanceChecks) ||
      !result.modelReceiptSha256s.length || !result.usageReceiptSha256s.length) {
    throw new Error("The sealed final review does not describe the exact proposed artifact and checks.");
  }
  const criteria = new Set(contract.acceptance.criteria.map((criterion) => criterion.criterionId));
  if (result.acceptanceChecks.length !== criteria.size ||
      result.acceptanceChecks.some((check) => !criteria.has(check.criterionId))) {
    throw new Error("The proposed checks do not cover the immutable acceptance criteria.");
  }
  const structurallyPassed = result.status === "completed" &&
    result.acceptanceChecks.every((check) => check.passed);
  if (input.deterministicPass !== structurallyPassed) {
    throw new Error("Final deterministic acceptance does not match the persisted proposal.");
  }
  const verifierVersion = contract.verifier.identity.definitionVersion;
  if (verifierVersion !== 1 && verifierVersion !== 2) {
    throw new Error("The contracted Sentinel definition version is unsupported.");
  }
  const verifierPin = buildAgentRunIdentityPinV1({
    runId: contract.verifier.identity.runId,
    identity: buildBuiltInAgentIdentityForVersionV1({
      agentId: "sentinel",
      tenantId: execution.tenantId,
      controllerActorId: execution.ownerActorId,
      definitionVersion: verifierVersion,
    }),
  });
  if (verifierPin.pinSha256 !== contract.verifier.identity.identityPinSha256 ||
      verifierPin.logicalAgentId !== contract.verifier.identity.logicalAgentId ||
      verifierPin.principalId !== contract.verifier.identity.principalId ||
      contract.verifier.runtimeAssignment.modelTier !== "reasoning") {
    throw new Error("The Sentinel identity no longer matches its immutable assignment.");
  }

  await validateStageUsage({ execution, stages, childScope: input.childScope, parentScope: input.parentScope });

  const accepted = input.deterministicPass && receipt.passed &&
    receipt.score >= contract.verifier.acceptanceThreshold;
  return transitionDelegationExecution({
    tenantId: execution.tenantId,
    executionId: execution.executionId,
    expectedRevision: execution.lifecycleRevision,
    transition: {
      to: accepted ? "verified" : "rejected",
      verification: {
        verifierAgentId: verifierPin.logicalAgentId,
        verifierDefinitionVersion: verifierPin.definitionVersion,
        verifierPrincipalId: verifierPin.principalId,
        verifierRuntimeAssignmentId: contract.verifier.runtimeAssignment.assignmentId,
        verifierRuntimeAssignmentSha256: contract.verifier.runtimeAssignment.assignmentSha256,
        verifierProviderId: contract.verifier.runtimeAssignment.providerId,
        verifierModelId: contract.verifier.runtimeAssignment.modelId,
        verifierModelTier: contract.verifier.runtimeAssignment.modelTier,
        verifierModelReceiptSha256: receipt.modelReceiptSha256,
        score: receipt.score,
        acceptanceChecksSha256: receipt.acceptanceChecksSha256,
        evidenceIds: result.evidenceIds,
        note: receipt.note,
      },
    },
    executionScope: input.parentScope,
  });
}

function selectFinalReview(stages: DelegationReviewStages): DelegationReviewStageCompletion {
  for (const entry of Object.values(stages)) {
    if (!entry.completion || entry.completion.exceededDimensions.length || entry.completion.outcome === "failed") {
      throw new Error("A review stage is ambiguous, failed, or exceeded its reserved budget.");
    }
  }
  const initial = stages.review_initial?.completion;
  if (!initial?.reviewReceipt) throw new Error("The initial independent review receipt is missing.");
  if (initial.outcome === "passed") {
    if (stages.correction || stages.review_final) {
      throw new Error("A passed proposal cannot create a correction or another review.");
    }
    return initial;
  }
  const correction = stages.correction?.completion;
  const final = stages.review_final?.completion;
  if (initial.outcome !== "changes_required" || !correction?.correctionReceipt ||
      correction.outcome !== "revised" || !final?.reviewReceipt ||
      !["passed", "changes_required"].includes(final.outcome) ||
      correction.correctionReceipt.previousProposalSha256 !== initial.reviewReceipt.proposalSha256 ||
      final.reviewReceipt.proposalSha256 !== correction.correctionReceipt.proposalSha256 ||
      stages.correction!.claim.predecessorReceiptSha256 !== initial.receiptSha256 ||
      stages.review_final!.claim.predecessorReceiptSha256 !== correction.receiptSha256) {
    throw new Error("The final review lacks its exact rejected-proposal and correction chain.");
  }
  return final;
}

async function validateStageUsage(input: {
  execution: DelegationExecutionRecordV1;
  stages: DelegationReviewStages;
  childScope: ExecutionScope;
  parentScope: ExecutionScope;
}) {
  const { execution, stages } = input;
  const childStream = `run:${execution.childRunId}`;
  const reviewStream = `delegation-execution:${execution.delegationId}`;
  const [usageRows, childEvents] = await runWithDatabaseActorScope(execution.tenantId, [execution.ownerActorId],
    () => Promise.all([
      getSql()`
        SELECT id, source_stream_id, status, provider, model, purpose, attempt_count,
          failed_attempt_count, provider_call_count, execution_scope, usage, estimated_cost_microusd
        FROM omni_ai_usage
        WHERE tenant_id = ${execution.tenantId} AND actor_id = ${execution.ownerActorId}
          AND source_stream_id IN (${childStream}, ${reviewStream})
        ORDER BY recorded_at ASC LIMIT 33
      `,
      listStreamEvents(childStream, { tenantId: execution.tenantId, actorId: execution.ownerActorId,
        limit: 2_000, order: "asc" }),
    ]));
  if (usageRows.length > 32 || childEvents.length >= 2_000) {
    throw new Error("The bounded finalization receipt read cannot establish complete coverage.");
  }
  const usedReceiptIds = new Set<string>();
  for (const [stage, entry] of Object.entries(stages)) {
    const completion = entry.completion!;
    const receipt = completion.reviewReceipt || completion.correctionReceipt;
    if (!receipt) throw new Error("A successful review stage has no sealed model usage receipt.");
    const matching = usageRows.filter((row) => canonicalJsonSha256({ usageReceiptId: String(row.id) }) === receipt.usageReceiptSha256);
    if (matching.length !== 1) throw new Error("The sealed stage usage receipt could not be resolved exactly.");
    const row = matching[0];
    const receiptId = String(row.id);
    const correction = stage === "correction";
    const assignment = correction ? execution.contract.runtimeAssignment : execution.contract.verifier.runtimeAssignment;
    const expectedScope = correction ? input.childScope : input.parentScope;
    const scope = parsePersistedExecutionScope(row.execution_scope);
    const usage = row.usage as Record<string, unknown> | undefined;
    if (usedReceiptIds.has(receiptId) || row.status !== "completed" ||
        row.provider !== assignment.providerId || row.model !== assignment.modelId ||
        row.source_stream_id !== (correction ? childStream : reviewStream) ||
        row.purpose !== (correction ? "delegation.proposal_correction" : "council.review") ||
        Number(row.attempt_count) !== 1 || Number(row.failed_attempt_count) !== 0 || Number(row.provider_call_count) !== 1 ||
        !scope || !executionScopesEqual(scope, expectedScope) ||
        entry.claim.runtimeAssignmentSha256 !== assignment.assignmentSha256 ||
        completion.actual.tokens === undefined || completion.actual.costMicrousd === undefined ||
        !usage || Number(usage.totalTokens) !== completion.actual.tokens ||
        row.estimated_cost_microusd === null || Number(row.estimated_cost_microusd) !== completion.actual.costMicrousd) {
      throw new Error("The sealed stage model, scope, or actual usage does not match its durable usage receipt.");
    }
    usedReceiptIds.add(receiptId);
    if (correction) {
      const events = childEvents.filter((event) => event.type === "run.model" && event.payload.usageReceiptId === receiptId);
      if (events.length !== 1 || events[0].payload.provider !== assignment.providerId ||
          events[0].payload.model !== assignment.modelId || events[0].payload.usageReceiptRecorded !== true ||
          canonicalJsonSha256(events[0].payload) !== receipt.modelReceiptSha256 ||
          !execution.result!.modelReceiptSha256s.includes(receipt.modelReceiptSha256) ||
          !execution.result!.usageReceiptSha256s.includes(receipt.usageReceiptSha256)) {
        throw new Error("The corrected proposal lacks its exact persisted child model and usage evidence.");
      }
    } else if (receipt.modelReceiptSha256 !== canonicalJsonSha256({
      runtimeAssignmentSha256: assignment.assignmentSha256,
      providerId: row.provider,
      modelId: row.model,
      modelTier: assignment.modelTier,
      usageReceiptRecorded: true,
      usageReceiptId: receiptId,
      attemptCount: 1,
    })) {
      throw new Error("The independent review model receipt does not match its pinned execution.");
    }
  }
}
