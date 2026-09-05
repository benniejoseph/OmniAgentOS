import { describe, expect, it } from "vitest";

import {
  RUN_CHECKPOINT_CAPABILITY_ID,
  RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import {
  recordModelAfterCheckpointShadow,
  recordModelBeforeCheckpointShadow,
} from "@/lib/runs/boundary-checkpoint-shadow";
import { buildInitialShadowRunContract } from "@/lib/runs/contract-runtime";
import {
  councilDelegationBoundaryId,
  councilVerifierBoundaryId,
  recordCouncilCheckpointShadow,
} from "@/lib/runs/council-checkpoint-shadow";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import type { RunCheckpointV1 } from "@/lib/runs/checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const RUN_ID = "run_council_checkpoint_shadow_test";
const SCOPE = createExecutionScope({
  tenantId: "tenant_council_checkpoint_shadow_test",
  initiatingActorId: "actor_council_checkpoint_shadow_test",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_council_checkpoint_shadow_test",
  correlationId: RUN_ID,
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "Test council checkpoint shadow writing.",
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
    enrolledAt: "2026-09-06T10:00:00.000Z",
    enginePin: {
      rolloutCapabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
      engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
      contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
      configurationSha256: RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
      runContractEnvelopeId: CONTRACT.envelope.envelopeId,
      runContractEnvelopeSha256: canonicalJsonSha256(CONTRACT.envelope),
      harnessManifestId: CONTRACT.envelope.harnessManifest.harnessManifestId,
      harnessManifestSha256: canonicalJsonSha256(
        CONTRACT.envelope.harnessManifest,
      ),
      rolloutMode: "shadow",
      rolloutLifecycleStatus: "active",
      rolloutGeneration: 3,
      rolloutLifecycleRevision: 1,
    },
  };
}

function checkpointSql() {
  const checkpoints: RunCheckpointV1[] = [];
  const sql = (async (strings: TemplateStringsArray) => {
    if (strings.join(" ").includes("INSERT INTO omni_events")) {
      return [{ seq: "1" }];
    }
    throw new Error(`Unexpected tagged SQL: ${strings.join(" ")}`);
  }) as unknown as RunCheckpointWriterSql;
  sql.query = async (text, params = []) => {
    if (text.includes("FROM omni_agent_runs")) {
      return [{
        id: RUN_ID,
        tenant_id: SCOPE.tenantId,
        status: "running",
        model: "gpt-test",
        agent_id: SCOPE.executingPrincipalId,
        started_at: "2026-09-06T10:00:00.000Z",
      }];
    }
    if (text.includes("boundary_kind = 'model'")) {
      const match = checkpoints.find((checkpoint) =>
        checkpoint.boundary.kind === "model" &&
        checkpoint.boundary.phase === params[2] &&
        checkpoint.boundary.boundaryId === params[3]
      );
      return match ? [{ checkpoint_json: match }] : [];
    }
    if (text.includes("boundary_kind = $3")) {
      const match = checkpoints.find((checkpoint) =>
        checkpoint.boundary.kind === params[2] &&
        checkpoint.boundary.phase === params[3] &&
        checkpoint.boundary.boundaryId === params[4]
      );
      return match ? [{ checkpoint_json: match }] : [];
    }
    if (text.includes("ORDER BY sequence DESC")) {
      const latest = checkpoints.at(-1);
      return latest ? [{ checkpoint_json: latest }] : [];
    }
    if (text.includes("checkpoint_id = $3")) {
      const match = checkpoints.find((checkpoint) =>
        checkpoint.checkpointId === params[2]
      );
      return match ? [{ checkpoint_json: match }] : [];
    }
    if (text.includes("INSERT INTO omni_run_checkpoints")) {
      const checkpoint = params[26] as RunCheckpointV1;
      checkpoints.push(checkpoint);
      return [{ checkpoint_json: checkpoint }];
    }
    if (text.includes("INSERT INTO omni_run_checkpoint_state_references")) {
      return (params[3] as Array<Record<string, unknown>>).map((row) => ({
        ordinal: row.ordinal,
        reference_kind: row.reference_kind,
        reference_id: row.reference_id,
        reference_sha256: row.reference_sha256,
        version_id: row.version_id,
      }));
    }
    throw new Error(`Unexpected query SQL: ${text}`);
  };
  sql.unsafe = sql.query;
  sql.transaction = async () => {
    throw new Error("Nested transaction is forbidden.");
  };
  Object.defineProperty(sql, "transactionScoped", { value: true });
  return { sql, checkpoints };
}

describe("council checkpoint shadow", () => {
  it("chains delegation and verifier boundaries around their model calls", async () => {
    const { sql, checkpoints } = checkpointSql();
    const delegationId = councilDelegationBoundaryId(RUN_ID, "scout");
    await recordCouncilCheckpointShadow({
      runId: RUN_ID,
      kind: "delegation",
      phase: "before",
      boundaryId: delegationId,
      attempt: 1,
      referenceSha256: canonicalJsonSha256("delegation request"),
      recordedAt: "2026-09-06T10:00:01.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);
    await recordModelBeforeCheckpointShadow({
      runId: RUN_ID,
      attempt: 1,
      provider: "model_gateway",
      model: "auto",
      tier: "reasoning",
      recordedAt: "2026-09-06T10:00:02.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);
    await recordModelAfterCheckpointShadow({
      runId: RUN_ID,
      event: {
        id: "delegation_model_receipt",
        createdAt: "2026-09-06T10:00:03.000Z",
        status: "completed",
        provider: "openai",
        model: "gpt-test",
        tier: "reasoning",
        inputTokens: 10,
        outputTokens: 4,
        cachedInputTokens: 1,
        totalTokens: 14,
        latencyMs: 500,
      },
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);
    await recordCouncilCheckpointShadow({
      runId: RUN_ID,
      kind: "delegation",
      phase: "after",
      boundaryId: delegationId,
      attempt: 1,
      referenceSha256: canonicalJsonSha256("delegation receipt"),
      recordedAt: "2026-09-06T10:00:04.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);

    const verifierId = councilVerifierBoundaryId(RUN_ID);
    await recordCouncilCheckpointShadow({
      runId: RUN_ID,
      kind: "verifier",
      phase: "before",
      boundaryId: verifierId,
      attempt: 1,
      referenceSha256: canonicalJsonSha256("verifier request"),
      recordedAt: "2026-09-06T10:00:05.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);
    await recordModelBeforeCheckpointShadow({
      runId: RUN_ID,
      attempt: 1,
      provider: "model_gateway",
      model: "auto",
      tier: "reasoning",
      recordedAt: "2026-09-06T10:00:06.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);
    await recordModelAfterCheckpointShadow({
      runId: RUN_ID,
      event: {
        id: "verifier_model_failure_receipt",
        createdAt: "2026-09-06T10:00:07.000Z",
        status: "failed",
        failureKind: "timeout",
        provider: "openai",
        model: "gpt-test",
        tier: "reasoning",
        inputTokens: 6,
        outputTokens: 0,
        cachedInputTokens: 0,
        totalTokens: 6,
        latencyMs: 1_000,
      },
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);
    await recordCouncilCheckpointShadow({
      runId: RUN_ID,
      kind: "verifier",
      phase: "after",
      boundaryId: verifierId,
      attempt: 1,
      referenceSha256: canonicalJsonSha256("verifier failure receipt"),
      recordedAt: "2026-09-06T10:00:08.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);

    expect(checkpoints.map((checkpoint) => [
      checkpoint.sequence,
      checkpoint.boundary.kind,
      checkpoint.boundary.phase,
      checkpoint.boundary.attempt,
    ])).toEqual([
      [0, "delegation", "before", 1],
      [1, "model", "before", 1],
      [2, "model", "after", 1],
      [3, "delegation", "after", 1],
      [4, "verifier", "before", 1],
      [5, "model", "before", 2],
      [6, "model", "after", 2],
      [7, "verifier", "after", 1],
    ]);
    expect(checkpoints.at(-1)?.resourceUsage).toMatchObject({
      modelCallCount: 2,
      modelInputTokenCount: 16,
      modelOutputTokenCount: 4,
      cachedInputTokenCount: 1,
      toolCallCount: 0,
      externalEffectCount: 0,
    });
  });
});
