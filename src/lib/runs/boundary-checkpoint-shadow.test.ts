import { describe, expect, it } from "vitest";

import {
  RUN_CHECKPOINT_CAPABILITY_ID,
  RUN_CHECKPOINT_CONFIGURATION_SHA256,
  RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import {
  modelCheckpointBoundaryId,
  recordModelAfterCheckpointShadow,
  recordModelBeforeCheckpointShadow,
} from "@/lib/runs/boundary-checkpoint-shadow";
import { buildInitialShadowRunContract } from "@/lib/runs/contract-runtime";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import type { RunCheckpointV1 } from "@/lib/runs/checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const RUN_ID = "run_model_checkpoint_shadow_test";
const SCOPE = createExecutionScope({
  tenantId: "tenant_model_checkpoint_shadow_test",
  initiatingActorId: "actor_model_checkpoint_shadow_test",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_model_checkpoint_shadow_test",
  correlationId: RUN_ID,
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "Test model checkpoint shadow writing.",
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

function enrollment(
  configurationSha256 = RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
): ApprovalCheckpointShadowEnrollment {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tenantId: SCOPE.tenantId,
    enrolledAt: "2026-09-06T08:00:00.000Z",
    enginePin: {
      rolloutCapabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
      engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
      contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
      configurationSha256,
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
  const domainEvents: unknown[][] = [];
  const sql = (async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    if (strings.join(" ").includes("INSERT INTO omni_events")) {
      domainEvents.push(params);
      return [{ seq: String(domainEvents.length) }];
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
        started_at: "2026-09-06T08:00:00.000Z",
      }];
    }
    if (text.includes("boundary_kind = 'model'")) {
      const match = checkpoints.find((checkpoint) =>
        checkpoint.boundary.phase === params[2] &&
        checkpoint.boundary.boundaryId === params[3]
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
  return { sql, checkpoints, domainEvents };
}

describe("expanded boundary checkpoint shadow", () => {
  it("records an exact model before/after pair with cumulative usage", async () => {
    const { sql, checkpoints, domainEvents } = checkpointSql();
    const before = await recordModelBeforeCheckpointShadow({
      runId: RUN_ID,
      attempt: 1,
      provider: "openai",
      model: "gpt-test",
      tier: "reasoning",
      recordedAt: "2026-09-06T08:00:01.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);

    expect(before).toMatchObject({
      sequence: 0,
      boundary: {
        kind: "model",
        phase: "before",
        boundaryId: modelCheckpointBoundaryId(RUN_ID, 1),
        attempt: 1,
      },
      resourceUsage: {
        modelCallCount: 0,
        modelInputTokenCount: 0,
        modelOutputTokenCount: 0,
      },
    });

    const after = await recordModelAfterCheckpointShadow({
      runId: RUN_ID,
      event: {
        id: "model_event_checkpoint_shadow_test",
        createdAt: "2026-09-06T08:00:02.000Z",
        provider: "openai",
        model: "gpt-test",
        tier: "reasoning",
        inputTokens: 12,
        outputTokens: 5,
        cachedInputTokens: 3,
        totalTokens: 17,
        latencyMs: 800,
        iteration: 1,
        providerRequestId: "provider_request_private",
        usageReceiptId: "usage_receipt_checkpoint_shadow_test",
      },
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);

    expect(after).toMatchObject({
      sequence: 1,
      parent: {
        checkpointId: before?.checkpointId,
        checkpointSha256: before?.checkpointSha256,
        sequence: 0,
      },
      boundary: {
        kind: "model",
        phase: "after",
        attempt: 1,
      },
      resourceUsage: {
        modelCallCount: 1,
        modelInputTokenCount: 12,
        modelOutputTokenCount: 5,
        cachedInputTokenCount: 3,
        totalTokenCount: 17,
      },
    });
    expect(checkpoints).toHaveLength(2);
    expect(domainEvents).toHaveLength(4);
    expect(JSON.stringify(after)).not.toContain("provider_request_private");
  });

  it("stays dormant for the approval-only shadow generation", async () => {
    const { sql, checkpoints, domainEvents } = checkpointSql();
    const result = await recordModelBeforeCheckpointShadow({
      runId: RUN_ID,
      attempt: 1,
      provider: "openai",
      model: "gpt-test",
      tier: "reasoning",
      recordedAt: "2026-09-06T08:00:01.000Z",
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(RUN_CHECKPOINT_CONFIGURATION_SHA256),
    }, sql);

    expect(result).toBeNull();
    expect(checkpoints).toHaveLength(0);
    expect(domainEvents).toHaveLength(0);
  });
});
