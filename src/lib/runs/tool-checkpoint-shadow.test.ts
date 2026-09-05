import { describe, expect, it } from "vitest";

import {
  RUN_CHECKPOINT_CAPABILITY_ID,
  RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import { buildInitialShadowRunContract } from "@/lib/runs/contract-runtime";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import type { RunCheckpointV1 } from "@/lib/runs/checkpoints";
import {
  recordToolAfterCheckpointShadow,
  recordToolBeforeCheckpointShadow,
} from "@/lib/runs/tool-checkpoint-shadow";
import {
  createExecutionScope,
  deriveExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  buildEffectIntentV2,
  finalizeEffectIntentV2,
} from "@/lib/tools/effect-intent-v2";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import { toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import { getGovernedTool } from "@/lib/tools/registry";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const RUN_ID = "run_tool_checkpoint_shadow_test";
const SCOPE = createExecutionScope({
  tenantId: "tenant_tool_checkpoint_shadow_test",
  initiatingActorId: "actor_tool_checkpoint_shadow_test",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_tool_checkpoint_shadow_test",
  correlationId: RUN_ID,
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "Test tool checkpoint shadow writing.",
});
const TOOL_SCOPE = deriveExecutionScope(SCOPE, {
  causationId: "tool_call_checkpoint_shadow_test",
  purpose: "agent.tool.execute",
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
const TOOL = getGovernedTool("runs.list");

function enrollment(): ApprovalCheckpointShadowEnrollment {
  return {
    schemaVersion: 1,
    runId: RUN_ID,
    tenantId: SCOPE.tenantId,
    enrolledAt: "2026-09-06T09:00:00.000Z",
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

function record(
  status: ToolExecutionRecord["status"],
): ToolExecutionRecord {
  return {
    id: "tool_execution_checkpoint_shadow_test",
    tenantId: SCOPE.tenantId,
    actorId: SCOPE.initiatingActorId || undefined,
    toolId: "runs.list",
    toolName: "List Runs",
    riskLevel: 0,
    status,
    dryRun: false,
    approvalRequired: false,
    input: { limit: 1 },
    output: status === "executed" ? { runs: [] } : undefined,
    createdAt: "2026-09-06T09:00:01.000Z",
    completedAt: status === "executed"
      ? "2026-09-06T09:00:02.000Z"
      : undefined,
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
        started_at: "2026-09-06T09:00:00.000Z",
      }];
    }
    if (text.includes("boundary_kind = 'tool'")) {
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

describe("tool checkpoint shadow", () => {
  it("records a read-only before/after pair around one governed execution", async () => {
    if (!TOOL) throw new Error("Expected runs.list to be registered.");
    const { sql, checkpoints, domainEvents } = checkpointSql();
    const before = await recordToolBeforeCheckpointShadow({
      runId: RUN_ID,
      record: record("executing"),
      tool: TOOL,
      operationClass: "read_only",
      executionScope: SCOPE,
      toolExecutionScope: TOOL_SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
      recordedAt: "2026-09-06T09:00:01.000Z",
    }, sql);
    const after = await recordToolAfterCheckpointShadow({
      runId: RUN_ID,
      record: record("executed"),
      tool: TOOL,
      operationClass: "read_only",
      executionScope: SCOPE,
      toolExecutionScope: TOOL_SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);

    expect(before).toMatchObject({
      sequence: 0,
      boundary: { kind: "tool", phase: "before" },
      toolBinding: {
        operationClass: "read_only",
        effectState: "not_applicable",
      },
      resourceUsage: { toolCallCount: 0 },
    });
    expect(after).toMatchObject({
      sequence: 1,
      boundary: { kind: "tool", phase: "after" },
      resourceUsage: {
        toolCallCount: 1,
        toolResultByteCount: Buffer.byteLength(
          JSON.stringify({ runs: [] }),
          "utf8",
        ),
        externalEffectCount: 0,
      },
    });
    expect(checkpoints).toHaveLength(2);
    expect(domainEvents).toHaveLength(4);
  });

  it("rejects mutation classification without a persisted effect intent", async () => {
    if (!TOOL) throw new Error("Expected runs.list to be registered.");
    const { sql } = checkpointSql();
    await expect(recordToolBeforeCheckpointShadow({
      runId: RUN_ID,
      record: record("executing"),
      tool: TOOL,
      operationClass: "mutation",
      executionScope: SCOPE,
      toolExecutionScope: TOOL_SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
      recordedAt: "2026-09-06T09:00:01.000Z",
    }, sql)).rejects.toThrow(/persisted effect intent/i);
  });

  it("binds a persisted mutation intent and its exact effect receipt", async () => {
    const tool = getGovernedTool("memory.write");
    if (!tool) throw new Error("Expected memory.write to be registered.");
    const { sql } = checkpointSql();
    const input = { title: "Preference", content: "Use concise answers." };
    const approvalFingerprint = toolApprovalFingerprint(tool);
    const intent = buildEffectIntentV2({
      effectMode: "live",
      reversible: true,
      executionKind: "direct",
      executionId: "tool_mutation_checkpoint_shadow_test",
      tenantId: SCOPE.tenantId,
      actorId: SCOPE.initiatingActorId || "",
      executingPrincipalType: TOOL_SCOPE.executingPrincipalType,
      executingPrincipalId: TOOL_SCOPE.executingPrincipalId || "",
      workflowRunId: null,
      planId: null,
      planSha256: null,
      planNodeId: null,
      toolId: tool.id,
      toolContractSha256: canonicalJsonSha256({ approvalFingerprint }),
      approvalState: "not_required",
      approvalBindingSha256: null,
      inputSha256: toolInputSha256(input),
      idempotencyKeySha256: canonicalJsonSha256("idempotency"),
      targetType: "memory",
      targetId: "memory_target_checkpoint_shadow_test",
      expectedTargetStateSha256: canonicalJsonSha256("expected state"),
    });
    const executing: ToolExecutionRecord = {
      id: intent.executionId,
      tenantId: SCOPE.tenantId,
      actorId: SCOPE.initiatingActorId || undefined,
      toolId: tool.id,
      toolName: tool.name,
      riskLevel: tool.riskLevel,
      status: "executing",
      dryRun: false,
      approvalRequired: false,
      input,
      output: {
        __approvalFingerprint: approvalFingerprint,
        __effectIntentV2: intent,
      },
      createdAt: "2026-09-06T09:00:01.000Z",
    };
    const receipt = finalizeEffectIntentV2(intent, {
      providerAcknowledgement: "first_party_store_commit",
      providerAcknowledgementId: "memory_ack_checkpoint_shadow_test",
      providerAcknowledgementSha256: canonicalJsonSha256("acknowledgement"),
      verificationMethod: "read_after_write",
      verificationState: "verified",
      verificationReasonCode: "state_matched",
      observedTargetStateSha256: intent.expectedTargetStateSha256,
    });

    await recordToolBeforeCheckpointShadow({
      runId: RUN_ID,
      record: executing,
      tool,
      operationClass: "mutation",
      executionScope: SCOPE,
      toolExecutionScope: TOOL_SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
      recordedAt: "2026-09-06T09:00:01.000Z",
    }, sql);
    const after = await recordToolAfterCheckpointShadow({
      runId: RUN_ID,
      record: {
        ...executing,
        status: "executed",
        output: {
          ...(executing.output as Record<string, unknown>),
          memoryId: intent.targetId,
        },
        effectReceipt: receipt,
        completedAt: "2026-09-06T09:00:02.000Z",
      },
      tool,
      operationClass: "mutation",
      executionScope: SCOPE,
      toolExecutionScope: TOOL_SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
    }, sql);

    expect(after).toMatchObject({
      toolBinding: {
        operationClass: "mutation",
        effectState: "effect_recorded",
        effectIntent: {
          referenceId: intent.effectIntentId,
          referenceSha256: intent.effectIntentSha256,
        },
        effectReceipt: {
          referenceId: receipt.effectReceiptId,
          referenceSha256: receipt.receiptSha256,
        },
      },
      resourceUsage: {
        toolCallCount: 1,
        externalEffectCount: 1,
        boundaryExternalEffectCount: 1,
      },
    });
  });
});
