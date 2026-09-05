import { describe, expect, it } from "vitest";

import {
  buildApprovalWaitingCheckpointShadow,
  RUN_CHECKPOINT_CAPABILITY_ID,
  RUN_CHECKPOINT_CONFIGURATION_SHA256,
  RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256,
  RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import {
  reconcileStoredApprovalCheckpointShadows,
  type RunCheckpointReconciliationSql,
} from "@/lib/runs/checkpoint-shadow-reconciliation";
import { buildInitialShadowRunContract } from "@/lib/runs/contract-runtime";
import {
  buildRunCheckpointV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const RUN_ID = "run_checkpoint_reconciliation_test";
const EXECUTION_ID = "tool_execution_reconciliation_test";
const WAITING_AT = "2026-09-05T14:00:00.000Z";
const DECISION_AT = "2026-09-05T14:00:01.000Z";
const SCOPE = createExecutionScope({
  tenantId: "tenant_checkpoint_reconciliation",
  initiatingActorId: "actor_checkpoint_reconciliation",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_checkpoint_reconciliation",
  correlationId: RUN_ID,
  causationId: "turn_checkpoint_reconciliation",
  contextGrantIds: ["context_checkpoint_reconciliation"],
  capabilityGrantIds: ["capability_checkpoint_reconciliation"],
  purpose: "Reconcile stored approval checkpoint shadows.",
});
const CONTRACT = buildInitialShadowRunContract({
  runId: RUN_ID,
  tenantId: SCOPE.tenantId,
  agentId: SCOPE.executingPrincipalId || undefined,
  executionScope: SCOPE,
  requestSha256: canonicalJsonSha256("request"),
  requestedOutcomeSha256: canonicalJsonSha256("outcome"),
  interactionMode: "orchestrate",
  executionMode: "live",
  autonomy: "governed",
  approvalPolicy: "risk_based",
  budget: {
    maxModelTurns: 6,
    maxToolCalls: 25,
    maxOutputTokens: 8_000,
    maxToolResultBytes: 200_000,
    maxExternalEffects: 25,
  },
});

function enrollment(): ApprovalCheckpointShadowEnrollment {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tenantId: SCOPE.tenantId,
    enrolledAt: "2026-09-05T13:59:59.000Z",
    enginePin: {
      rolloutCapabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
      engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
      contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
      configurationSha256: RUN_CHECKPOINT_CONFIGURATION_SHA256,
      runContractEnvelopeId: CONTRACT.envelope.envelopeId,
      runContractEnvelopeSha256: canonicalJsonSha256(CONTRACT.envelope),
      harnessManifestId: CONTRACT.envelope.harnessManifest.harnessManifestId,
      harnessManifestSha256: canonicalJsonSha256(
        CONTRACT.envelope.harnessManifest,
      ),
      rolloutMode: "shadow",
      rolloutLifecycleStatus: "active",
      rolloutGeneration: 1,
      rolloutLifecycleRevision: 1,
    },
  };
}

function waitingCheckpoint(): RunCheckpointV1 {
  return buildApprovalWaitingCheckpointShadow({
    runId: RUN_ID,
    executionScope: SCOPE,
    runContractEnvelope: CONTRACT.envelope,
    enrollment: enrollment(),
    approvalExecutionId: EXECUTION_ID,
    state: {
      runRecordSha256: canonicalJsonSha256("run"),
      approvalRequestSha256: canonicalJsonSha256("approval"),
      toolExecutionSha256: canonicalJsonSha256("tool-waiting"),
      continuationSha256: canonicalJsonSha256("continuation"),
    },
    resourceUsage: {
      modelCallCount: 1,
      modelInputTokenCount: 10,
      modelOutputTokenCount: 5,
      cachedInputTokenCount: 2,
      toolCallCount: 1,
      toolResultByteCount: 0,
      externalEffectCount: 0,
      elapsedMs: 5_000,
    },
    recordedAt: WAITING_AT,
  });
}

function approvedCheckpoint(parent: RunCheckpointV1): RunCheckpointV1 {
  return buildRunCheckpointV1({
    runId: parent.runId,
    executionScope: SCOPE,
    boundary: { ...parent.boundary, phase: "after" },
    sequence: 1,
    parent: {
      checkpointId: parent.checkpointId,
      checkpointSha256: parent.checkpointSha256,
      sequence: parent.sequence,
    },
    enginePin: parent.enginePin,
    stateReferences: parent.stateReferences
      .filter((reference) => reference.kind !== "tool_execution")
      .concat([
        {
          kind: "tool_execution",
          referenceId: EXECUTION_ID,
          referenceSha256: canonicalJsonSha256("tool-approved"),
          versionId: "governed_tool_execution_v1",
        },
        {
          kind: "approval_decision",
          referenceId: EXECUTION_ID,
          referenceSha256: canonicalJsonSha256("decision-approved"),
          versionId: "governed_tool_approval_v1",
        },
      ]),
    toolBinding: null,
    resourceUsage: {
      modelCallCount: 1,
      modelInputTokenCount: 10,
      modelOutputTokenCount: 5,
      cachedInputTokenCount: 2,
      toolCallCount: 1,
      toolResultByteCount: 0,
      externalEffectCount: 0,
      boundaryExternalEffectCount: 0,
      elapsedMs: 5_000,
    },
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: DECISION_AT,
  });
}

describe("approval checkpoint shadow reconciliation", () => {
  it("does not pass an empty tenant sample", async () => {
    const sql: RunCheckpointReconciliationSql = { query: async () => [] };

    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId, limit: 25 },
      sql,
    );

    expect(report).toMatchObject({
      status: "no_sample",
      sampleLimit: 25,
      sampledRunCount: 0,
      matchedRunCount: 0,
      resumeAuthorityGranted: false,
    });
  });

  it("reconciles a waiting checkpoint and its exact stored evidence", async () => {
    const waiting = waitingCheckpoint();
    const sql = fixtureSql({
      checkpoints: [waiting],
      tool: {
        id: EXECUTION_ID,
        status: "approval_required",
        approval_decision: null,
        effect_receipt: null,
      },
    });

    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId },
      sql,
    );

    expect(report).toMatchObject({
      status: "matched",
      sampledRunCount: 1,
      matchedRunCount: 1,
      checkpointCount: 1,
      comparisonReceiptCount: 1,
      waitingRunCount: 1,
      resumeAuthorityGranted: false,
    });
    expect(report.runs[0]).toMatchObject({
      status: "matched",
      decisionState: "waiting",
      effectState: "not_started",
      issues: [],
    });
  });

  it("reports terminal-without-receipt explicitly after an approved successor", async () => {
    const waiting = waitingCheckpoint();
    const approved = approvedCheckpoint(waiting);
    const sql = fixtureSql({
      checkpoints: [waiting, approved],
      tool: {
        id: EXECUTION_ID,
        status: "executed",
        approval_decision: "approved",
        effect_receipt: null,
      },
    });

    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId },
      sql,
    );

    expect(report).toMatchObject({
      status: "matched",
      checkpointCount: 2,
      comparisonReceiptCount: 2,
      approvedRunCount: 1,
      effectReceiptCount: 0,
    });
    expect(report.runs[0]).toMatchObject({
      decisionState: "approved",
      effectState: "terminal_without_receipt",
    });
  });

  it("fails the report when a state-reference index or receipt is missing", async () => {
    const waiting = waitingCheckpoint();
    const sql = fixtureSql({
      checkpoints: [waiting],
      tool: {
        id: EXECUTION_ID,
        status: "approval_required",
        approval_decision: null,
        effect_receipt: null,
      },
      omitLastReference: true,
      omitComparisonReceipt: true,
    });

    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId },
      sql,
    );

    expect(report.status).toBe("mismatch");
    expect(report.runs[0]?.issues.map((issue) => issue.code)).toEqual([
      "state_reference_mismatch",
      "comparison_receipt_mismatch",
    ]);
  });

  it("fails closed when an expanded sample lacks required boundary coverage", async () => {
    const checkpoints = expandedCheckpointChain().slice(0, 4);
    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId, mode: "expanded" },
      fixtureSql({
        checkpoints,
        tool: {
          id: EXECUTION_ID,
          status: "executed",
          approval_decision: "approved",
          effect_receipt: null,
        },
      }),
    );

    expect(report).toMatchObject({
      mode: "expanded",
      status: "incomplete_coverage",
      matchedRunCount: 1,
      observedBoundaryPhases: [
        "delegation:after",
        "delegation:before",
        "model:after",
        "model:before",
      ],
    });
    expect(report.missingBoundaryPhases).toContain("tool:before");
  });

  it("passes a complete expanded boundary sample", async () => {
    const checkpoints = expandedCheckpointChain();
    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId, mode: "expanded" },
      fixtureSql({
        checkpoints,
        tool: {
          id: EXECUTION_ID,
          status: "executed",
          approval_decision: "approved",
          effect_receipt: null,
        },
      }),
    );

    expect(report).toMatchObject({
      mode: "expanded",
      status: "matched",
      sampledRunCount: 1,
      matchedRunCount: 1,
      checkpointCount: 14,
      comparisonReceiptCount: 14,
      missingBoundaryPhases: [],
    });
  });

  it("reconciles the separately pinned full-boundary canary", async () => {
    const checkpoints = expandedCheckpointChain("canary");
    const report = await reconcileStoredApprovalCheckpointShadows(
      { tenantId: SCOPE.tenantId, mode: "expanded_canary" },
      fixtureSql({
        checkpoints,
        tool: {
          id: EXECUTION_ID,
          status: "executed",
          approval_decision: "approved",
          effect_receipt: null,
        },
      }),
    );

    expect(report).toMatchObject({
      mode: "expanded_canary",
      status: "matched",
      matchedRunCount: 1,
      checkpointCount: 14,
      missingBoundaryPhases: [],
      resumeAuthorityGranted: false,
    });
  });
});

function expandedCheckpointChain(mode: "shadow" | "canary" = "shadow") {
  const expanded = {
    ...enrollment(),
    enginePin: {
      ...enrollment().enginePin,
      configurationSha256: mode === "canary"
        ? RUN_CHECKPOINT_EXPANDED_CANARY_CONFIGURATION_SHA256
        : RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
      rolloutMode: mode,
      rolloutGeneration: mode === "canary" ? 4 : 3,
    },
  };
  const checkpoints: RunCheckpointV1[] = [];
  let modelCallCount = 0;
  let modelInputTokenCount = 0;
  let modelOutputTokenCount = 0;
  let toolCallCount = 0;
  const append = (
    boundary: RunCheckpointV1["boundary"],
    referenceKind: RunCheckpointV1["stateReferences"][number]["kind"],
  ) => {
    const parent = checkpoints.at(-1) || null;
    if (boundary.kind === "model" && boundary.phase === "after") {
      modelCallCount += 1;
      modelInputTokenCount += 2;
      modelOutputTokenCount += 1;
    }
    if (boundary.kind === "tool" && boundary.phase === "after") {
      toolCallCount += 1;
    }
    const toolExecutionSha256 = canonicalJsonSha256({
      executionId: boundary.boundaryId,
      state: boundary.phase,
    });
    const toolBinding = boundary.kind === "tool"
      ? {
          operationClass: "read_only" as const,
          toolExecutionId: boundary.boundaryId,
          toolExecutionSha256,
          toolId: "runs.list",
          toolContractSha256: canonicalJsonSha256("runs.list contract"),
          inputSha256: canonicalJsonSha256("runs.list input"),
          idempotencyKeySha256: null,
          effectState: "not_applicable" as const,
          effectIntent: null,
          effectReceipt: null,
        }
      : null;
    const checkpoint = buildRunCheckpointV1({
      runId: RUN_ID,
      executionScope: SCOPE,
      boundary,
      sequence: checkpoints.length,
      parent: parent
        ? {
            checkpointId: parent.checkpointId,
            checkpointSha256: parent.checkpointSha256,
            sequence: parent.sequence,
          }
        : null,
      enginePin: expanded.enginePin,
      stateReferences: [
        {
          kind: "run_record",
          referenceId: RUN_ID,
          referenceSha256: canonicalJsonSha256("expanded run"),
          versionId: "agent_run_v1",
        },
        {
          kind: referenceKind,
          referenceId: boundary.boundaryId,
          referenceSha256: boundary.kind === "tool"
            ? toolExecutionSha256
            : canonicalJsonSha256({ boundary }),
          versionId: "expanded_boundary_test_v1",
        },
      ],
      toolBinding,
      resourceUsage: {
        modelCallCount,
        modelInputTokenCount,
        modelOutputTokenCount,
        cachedInputTokenCount: 0,
        toolCallCount,
        toolResultByteCount: 0,
        externalEffectCount: 0,
        boundaryExternalEffectCount: 0,
        elapsedMs: checkpoints.length * 1_000,
      },
      lifecycleState: boundary.phase === "waiting" ? "waiting" : "active",
      resumeDisposition: boundary.phase === "waiting"
        ? "awaiting_signal"
        : "resumable",
      recordedAt: new Date(
        Date.parse(WAITING_AT) + checkpoints.length * 1_000,
      ).toISOString(),
    });
    checkpoints.push(checkpoint);
  };

  append(
    { kind: "delegation", phase: "before", boundaryId: `${RUN_ID}:delegation:scout:1`, attempt: 1 },
    "delegation",
  );
  append(
    { kind: "model", phase: "before", boundaryId: `${RUN_ID}:model:1`, attempt: 1 },
    "model_turn",
  );
  append(
    { kind: "model", phase: "after", boundaryId: `${RUN_ID}:model:1`, attempt: 1 },
    "model_turn",
  );
  append(
    { kind: "delegation", phase: "after", boundaryId: `${RUN_ID}:delegation:scout:1`, attempt: 1 },
    "delegation_signal",
  );
  append(
    { kind: "verifier", phase: "before", boundaryId: `${RUN_ID}:verifier:1`, attempt: 1 },
    "verifier_request",
  );
  append(
    { kind: "model", phase: "before", boundaryId: `${RUN_ID}:model:2`, attempt: 2 },
    "model_turn",
  );
  append(
    { kind: "model", phase: "after", boundaryId: `${RUN_ID}:model:2`, attempt: 2 },
    "model_turn",
  );
  append(
    { kind: "verifier", phase: "after", boundaryId: `${RUN_ID}:verifier:1`, attempt: 1 },
    "verifier_receipt",
  );
  append(
    { kind: "model", phase: "before", boundaryId: `${RUN_ID}:model:3`, attempt: 3 },
    "model_turn",
  );
  append(
    { kind: "model", phase: "after", boundaryId: `${RUN_ID}:model:3`, attempt: 3 },
    "model_turn",
  );
  append(
    { kind: "approval", phase: "waiting", boundaryId: EXECUTION_ID, attempt: 1 },
    "approval_request",
  );
  append(
    { kind: "approval", phase: "after", boundaryId: EXECUTION_ID, attempt: 1 },
    "approval_decision",
  );
  append(
    { kind: "tool", phase: "before", boundaryId: EXECUTION_ID, attempt: 1 },
    "tool_execution",
  );
  append(
    { kind: "tool", phase: "after", boundaryId: EXECUTION_ID, attempt: 1 },
    "tool_execution",
  );
  return checkpoints;
}

function fixtureSql(input: {
  checkpoints: RunCheckpointV1[];
  tool: Record<string, unknown>;
  omitLastReference?: boolean;
  omitComparisonReceipt?: boolean;
}): RunCheckpointReconciliationSql {
  const references = input.checkpoints.flatMap((checkpoint) =>
    checkpoint.stateReferences.map((reference, ordinal) => ({
      checkpoint_id: checkpoint.checkpointId,
      ordinal,
      reference_kind: reference.kind,
      reference_id: reference.referenceId,
      reference_sha256: reference.referenceSha256,
      version_id: reference.versionId,
    }))
  );
  if (input.omitLastReference) references.pop();
  const events = input.checkpoints.flatMap((checkpoint) => {
    const values: Record<string, unknown>[] = [recordedEvent(checkpoint)];
    if (!input.omitComparisonReceipt) values.push(comparisonEvent(checkpoint));
    return values;
  });
  return {
    query: async (text) => {
      if (text.includes("SELECT run_id")) {
        return [{ run_id: RUN_ID, latest_recorded_at: WAITING_AT }];
      }
      if (text.includes("FROM omni_run_checkpoint_state_references")) {
        return references;
      }
      if (text.includes("FROM omni_events")) return events;
      if (text.includes("FROM omni_tool_executions")) return [input.tool];
      if (text.includes("FROM omni_run_checkpoints")) {
        return input.checkpoints.map(checkpointRow);
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  };
}

function checkpointRow(checkpoint: RunCheckpointV1) {
  return {
    schema_version: checkpoint.schemaVersion,
    checkpoint_id: checkpoint.checkpointId,
    checkpoint_sha256: checkpoint.checkpointSha256,
    tenant_id: checkpoint.executionScope.tenantId,
    actor_id: checkpoint.executionScope.initiatingActorId,
    executing_principal_type: checkpoint.executionScope.executingPrincipalType,
    executing_principal_id: checkpoint.executionScope.executingPrincipalId,
    run_id: checkpoint.runId,
    sequence: checkpoint.sequence,
    parent_checkpoint_id: checkpoint.parent?.checkpointId ?? null,
    parent_checkpoint_sha256: checkpoint.parent?.checkpointSha256 ?? null,
    parent_sequence: checkpoint.parent?.sequence ?? null,
    boundary_kind: checkpoint.boundary.kind,
    boundary_phase: checkpoint.boundary.phase,
    boundary_id: checkpoint.boundary.boundaryId,
    boundary_attempt: checkpoint.boundary.attempt,
    execution_scope_sha256: checkpoint.executionScope.executionScopeSha256,
    purpose_sha256: checkpoint.executionScope.purposeSha256,
    rollout_capability_id: checkpoint.enginePin.rolloutCapabilityId,
    engine_version_id: checkpoint.enginePin.engineVersionId,
    contract_version_id: checkpoint.enginePin.contractVersionId,
    configuration_sha256: checkpoint.enginePin.configurationSha256,
    rollout_generation: checkpoint.enginePin.rolloutGeneration,
    rollout_lifecycle_revision: checkpoint.enginePin.rolloutLifecycleRevision,
    lifecycle_state: checkpoint.lifecycleState,
    resume_disposition: checkpoint.resumeDisposition,
    checkpoint_json: checkpoint,
    recorded_at: checkpoint.recordedAt,
  };
}

function recordedEvent(checkpoint: RunCheckpointV1) {
  return {
    id: `run-checkpoint-recorded:${checkpoint.checkpointSha256}`,
    type: "run.checkpoint.recorded",
    payload: {
      checkpointId: checkpoint.checkpointId,
      checkpointSha256: checkpoint.checkpointSha256,
      runId: checkpoint.runId,
      sequence: checkpoint.sequence,
      parentCheckpointId: checkpoint.parent?.checkpointId ?? null,
      parentCheckpointSha256: checkpoint.parent?.checkpointSha256 ?? null,
      boundaryKind: checkpoint.boundary.kind,
      boundaryPhase: checkpoint.boundary.phase,
      boundaryId: checkpoint.boundary.boundaryId,
      stateReferenceCount: checkpoint.stateReferences.length,
      executionScopeSha256: checkpoint.executionScope.executionScopeSha256,
      rolloutCapabilityId: checkpoint.enginePin.rolloutCapabilityId,
      rolloutGeneration: checkpoint.enginePin.rolloutGeneration,
      rolloutLifecycleRevision: checkpoint.enginePin.rolloutLifecycleRevision,
    },
  };
}

function comparisonEvent(checkpoint: RunCheckpointV1) {
  return {
    id: `run-checkpoint-shadow-compared:${checkpoint.checkpointSha256}`,
    type: "run.checkpoint.shadow_compared",
    payload: {
      schemaVersion: 1,
      checkpointId: checkpoint.checkpointId,
      checkpointSha256: checkpoint.checkpointSha256,
      runId: checkpoint.runId,
      boundaryKind: checkpoint.boundary.kind,
      boundaryPhase: checkpoint.boundary.phase,
      boundaryId: checkpoint.boundary.boundaryId,
      comparison: "matched",
      stateReferenceCount: checkpoint.stateReferences.length,
      externalEffectCount: checkpoint.resourceUsage.externalEffectCount,
      resumeAuthorityGranted: false,
      _executionScope: SCOPE,
    },
  };
}
