import { getSql } from "@/lib/db/client";
import { appendDomainEvent } from "@/lib/events/store";
import {
  isExpandedCheckpointShadowEnrollment,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import {
  parseRunContractEnvelopeV1,
  runContractIdSchema,
  runContractSha256Schema,
  type RunContractEnvelopeV1,
} from "@/lib/runs/contracts";
import {
  recordRunCheckpointV1,
  type RunCheckpointWriterSql,
} from "@/lib/runs/checkpoint-store";
import {
  buildRunCheckpointV1,
  parseRunCheckpointV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type CouncilBoundaryKind = "delegation" | "verifier";
type CouncilBoundaryPhase = "before" | "after";

type CouncilCheckpointInput = Readonly<{
  runId: string;
  kind: CouncilBoundaryKind;
  phase: CouncilBoundaryPhase;
  boundaryId: string;
  attempt: number;
  referenceSha256: string;
  recordedAt: string;
  executionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
  enrollment: ApprovalCheckpointShadowEnrollment | undefined;
}>;

export function councilDelegationBoundaryId(
  runId: string,
  agentId: string,
  attempt = 1,
) {
  return runContractIdSchema.parse(
    `${runId}:delegation:${agentId}:${attempt}`,
  );
}

export function councilVerifierBoundaryId(runId: string, attempt = 1) {
  return runContractIdSchema.parse(`${runId}:verifier:${attempt}`);
}

export async function persistCouncilCheckpointShadow(
  input: CouncilCheckpointInput,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  return getSql().transaction((sql: RunCheckpointWriterSql) =>
    recordCouncilCheckpointShadow(input, sql)
  );
}

export async function recordCouncilCheckpointShadow(
  input: CouncilCheckpointInput,
  sql: RunCheckpointWriterSql,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  const boundaryId = runContractIdSchema.parse(input.boundaryId);
  const referenceSha256 = runContractSha256Schema.parse(input.referenceSha256);
  const common = await loadCommonState(input, sql);
  const existing = await exactBoundary(
    sql,
    common.scope.tenantId,
    input.runId,
    input.kind,
    input.phase,
    boundaryId,
  );
  if (existing) return existing;
  if (
    common.parent &&
    (common.parent.lifecycleState !== "active" ||
      common.parent.resumeDisposition !== "resumable" ||
      common.parent.boundary.phase === "waiting")
  ) {
    throw new Error("Council checkpoint cannot follow a closed boundary.");
  }
  if (input.phase === "after") {
    const before = await exactBoundary(
      sql,
      common.scope.tenantId,
      input.runId,
      input.kind,
      "before",
      boundaryId,
    );
    if (!before || before.boundary.attempt !== input.attempt) {
      throw new Error("Council after-checkpoint lacks its exact before boundary.");
    }
  }
  const recordedAt = canonicalTimestamp(input.recordedAt);
  const referenceKind = input.kind === "delegation"
    ? input.phase === "before"
      ? "delegation" as const
      : "delegation_signal" as const
    : input.phase === "before"
      ? "verifier_request" as const
      : "verifier_receipt" as const;
  const checkpoint = buildRunCheckpointV1({
    runId: input.runId,
    executionScope: common.scope,
    boundary: {
      kind: input.kind,
      phase: input.phase,
      boundaryId,
      attempt: input.attempt,
    },
    sequence: common.parent ? common.parent.sequence + 1 : 0,
    parent: parentReference(common.parent),
    enginePin: input.enrollment.enginePin,
    stateReferences: [
      {
        kind: "run_record",
        referenceId: input.runId,
        referenceSha256: common.runRecordSha256,
        versionId: "agent_run_v1",
      },
      {
        kind: "harness_manifest",
        referenceId: common.envelope.harnessManifest.harnessManifestId,
        referenceSha256: canonicalJsonSha256(common.envelope.harnessManifest),
        versionId: "harness_manifest_v1",
      },
      {
        kind: referenceKind,
        referenceId: boundaryId,
        referenceSha256,
        versionId: input.kind === "delegation"
          ? input.phase === "before"
            ? "council_delegation_v1"
            : "council_delegation_signal_v1"
          : input.phase === "before"
            ? "council_verifier_request_v1"
            : "council_verifier_receipt_v1",
      },
    ],
    toolBinding: null,
    resourceUsage: inheritedResourceUsage(
      common.parent,
      recordedAt,
      common.startedAt,
    ),
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt,
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: common.scope }, sql);
  await appendComparison(checkpoint, common.scope, sql);
  return checkpoint;
}

async function loadCommonState(
  input: CouncilCheckpointInput,
  sql: RunCheckpointWriterSql,
) {
  if (!sql.transactionScoped) {
    throw new Error("Council checkpoint shadow requires a run transaction.");
  }
  const scope = parsePersistedExecutionScope(input.executionScope);
  const envelope = parseRunContractEnvelopeV1(input.runContractEnvelope);
  if (!scope || !envelope || !input.enrollment) {
    throw new Error("Council checkpoint shadow lost its exact contracts.");
  }
  if (
    input.runId !== envelope.runId ||
    input.enrollment.runId !== input.runId ||
    input.enrollment.tenantId !== scope.tenantId ||
    input.enrollment.enginePin.runContractEnvelopeId !== envelope.envelopeId ||
    input.enrollment.enginePin.runContractEnvelopeSha256 !==
      canonicalJsonSha256(envelope)
  ) {
    throw new Error("Council checkpoint shadow changed its run binding.");
  }
  const runRows = await sql.query(
    `SELECT id, tenant_id, status, model, agent_id, started_at
     FROM omni_agent_runs
     WHERE tenant_id = $1 AND id = $2
     LIMIT 2
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  if (
    runRows.length !== 1 ||
    !["running", "resuming"].includes(String(runRows[0].status))
  ) {
    throw new Error("Council checkpoint run is not active.");
  }
  const checkpointRows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 1
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  const parent = checkpointRows[0]
    ? parseRunCheckpointV1(checkpointRows[0].checkpoint_json)
    : null;
  const runRow = runRows[0];
  const startedAt = canonicalTimestamp(runRow.started_at);
  return {
    scope,
    envelope,
    parent,
    startedAt,
    runRecordSha256: canonicalJsonSha256({
      schemaVersion: 1,
      runId: runRow.id,
      tenantId: runRow.tenant_id,
      status: runRow.status,
      model: runRow.model || null,
      agentId: runRow.agent_id,
      startedAt,
    }),
  };
}

async function exactBoundary(
  sql: RunCheckpointWriterSql,
  tenantId: string,
  runId: string,
  kind: CouncilBoundaryKind,
  phase: CouncilBoundaryPhase,
  boundaryId: string,
) {
  const rows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
       AND boundary_kind = $3 AND boundary_phase = $4
       AND boundary_id = $5
     LIMIT 2
     FOR SHARE`,
    [tenantId, runId, kind, phase, boundaryId],
  );
  if (rows.length > 1) throw new Error("Council checkpoint identity is ambiguous.");
  return rows[0] ? parseRunCheckpointV1(rows[0].checkpoint_json) : null;
}

function parentReference(parent: RunCheckpointV1 | null) {
  return parent
    ? {
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: parent.sequence,
      }
    : null;
}

function inheritedResourceUsage(
  parent: RunCheckpointV1 | null,
  recordedAt: string,
  startedAt: string,
) {
  return {
    modelCallCount: parent?.resourceUsage.modelCallCount || 0,
    modelInputTokenCount: parent?.resourceUsage.modelInputTokenCount || 0,
    modelOutputTokenCount: parent?.resourceUsage.modelOutputTokenCount || 0,
    cachedInputTokenCount: parent?.resourceUsage.cachedInputTokenCount || 0,
    toolCallCount: parent?.resourceUsage.toolCallCount || 0,
    toolResultByteCount: parent?.resourceUsage.toolResultByteCount || 0,
    externalEffectCount: parent?.resourceUsage.externalEffectCount || 0,
    boundaryExternalEffectCount: 0 as const,
    elapsedMs: elapsedMs(startedAt, recordedAt),
  };
}

async function appendComparison(
  checkpoint: RunCheckpointV1,
  executionScope: ExecutionScope,
  sql: RunCheckpointWriterSql,
) {
  await appendDomainEvent({
    id: `run-checkpoint-shadow-compared:${checkpoint.checkpointSha256}`,
    streamId: `run:${checkpoint.runId}`,
    type: "run.checkpoint.shadow_compared",
    executionScope,
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
    },
  }, { sql });
}

function elapsedMs(startedAt: string, recordedAt: string) {
  return Math.max(
    0,
    Date.parse(canonicalTimestamp(recordedAt)) -
      Date.parse(canonicalTimestamp(startedAt)),
  );
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Council checkpoint timestamp is invalid.");
  }
  return date.toISOString();
}
