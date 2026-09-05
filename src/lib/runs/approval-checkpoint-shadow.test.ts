import { describe, expect, it } from "vitest";

import {
  buildApprovalWaitingCheckpointShadow,
  parseApprovalCheckpointShadowEnrollment,
  recordApprovalDecisionCheckpointShadow,
  recordApprovalWaitingCheckpointShadow,
  RUN_CHECKPOINT_CANARY_CONFIGURATION_SHA256,
  RUN_CHECKPOINT_CAPABILITY_ID,
  RUN_CHECKPOINT_CONFIGURATION_SHA256,
  RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  RUN_CHECKPOINT_ENGINE_VERSION_ID,
  RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import { buildInitialShadowRunContract } from "@/lib/runs/contract-runtime";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import {
  buildRunCheckpointV1,
  validateRunCheckpointSuccessorV1,
} from "@/lib/runs/checkpoints";
import {
  createExecutionScope,
  deriveExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const RUN_ID = "run_checkpoint_shadow_test";
const EXECUTION_ID = "tool_execution_checkpoint_shadow_test";
const RECORDED_AT = "2026-09-05T12:00:05.000Z";
const SCOPE = createExecutionScope({
  tenantId: "tenant_checkpoint_shadow_test",
  initiatingActorId: "actor_checkpoint_shadow_test",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_checkpoint_shadow_test",
  correlationId: RUN_ID,
  contextGrantIds: ["context_checkpoint_shadow_test"],
  capabilityGrantIds: ["capability_checkpoint_shadow_test"],
  purpose: "Test approval checkpoint shadow writing.",
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
    enrolledAt: "2026-09-05T12:00:00.000Z",
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

function continuation() {
  return {
    executionScope: SCOPE,
    runContractEnvelope: CONTRACT.envelope,
    checkpointShadowEnrollment: enrollment(),
    instructions: "private instructions",
    conversationItems: [{ role: "user", content: "private content" }],
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call_checkpoint_shadow",
      toolId: "calendar.create",
      toolName: "Create calendar event",
      riskLevel: 2,
      executionId: EXECUTION_ID,
    },
    context: {
      tenantId: SCOPE.tenantId,
      actorId: SCOPE.initiatingActorId,
      role: "operator",
    },
    createdAt: RECORDED_AT,
  };
}

function waitingCheckpoint() {
  return buildApprovalWaitingCheckpointShadow({
    runId: RUN_ID,
    executionScope: SCOPE,
    runContractEnvelope: CONTRACT.envelope,
    enrollment: enrollment(),
    approvalExecutionId: EXECUTION_ID,
    state: {
      runRecordSha256: canonicalJsonSha256("run"),
      approvalRequestSha256: canonicalJsonSha256("approval"),
      toolExecutionSha256: canonicalJsonSha256("tool"),
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
    recordedAt: RECORDED_AT,
  });
}

describe("approval checkpoint shadow", () => {
  it("accepts the expanded configuration only as a shadow pin", () => {
    const expanded = structuredClone(enrollment());
    expanded.enginePin.configurationSha256 =
      RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256;

    expect(() => buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: expanded,
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("run"),
        approvalRequestSha256: canonicalJsonSha256("approval"),
        toolExecutionSha256: canonicalJsonSha256("tool"),
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
      recordedAt: RECORDED_AT,
    })).not.toThrow();

    expanded.enginePin.rolloutMode = "canary";
    expect(() => buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: expanded,
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("run"),
        approvalRequestSha256: canonicalJsonSha256("approval"),
        toolExecutionSha256: canonicalJsonSha256("tool"),
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
      recordedAt: RECORDED_AT,
    })).toThrow(/binding changed/i);
  });

  it("does not count a pending expanded approval tool before its after boundary", () => {
    const expanded = structuredClone(enrollment());
    expanded.enginePin.configurationSha256 =
      RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256;
    const modelBefore = buildRunCheckpointV1({
      runId: RUN_ID,
      executionScope: SCOPE,
      boundary: {
        kind: "model",
        phase: "before",
        boundaryId: `${RUN_ID}:model:1`,
        attempt: 1,
      },
      sequence: 0,
      parent: null,
      enginePin: expanded.enginePin,
      stateReferences: [
        {
          kind: "run_record",
          referenceId: RUN_ID,
          referenceSha256: canonicalJsonSha256("run before approval"),
          versionId: "agent_run_v1",
        },
        {
          kind: "harness_manifest",
          referenceId: expanded.enginePin.harnessManifestId,
          referenceSha256: expanded.enginePin.harnessManifestSha256,
          versionId: "harness_manifest_v1",
        },
        {
          kind: "model_turn",
          referenceId: `${RUN_ID}:model:1`,
          referenceSha256: canonicalJsonSha256("model request"),
          versionId: "model_turn_request_v1",
        },
      ],
      toolBinding: null,
      resourceUsage: {
        modelCallCount: 0,
        modelInputTokenCount: 0,
        modelOutputTokenCount: 0,
        cachedInputTokenCount: 0,
        toolCallCount: 0,
        toolResultByteCount: 0,
        externalEffectCount: 0,
        boundaryExternalEffectCount: 0,
        elapsedMs: 3_000,
      },
      lifecycleState: "active",
      resumeDisposition: "resumable",
      recordedAt: "2026-09-05T12:00:03.000Z",
    });
    const parent = buildRunCheckpointV1({
      runId: RUN_ID,
      executionScope: SCOPE,
      boundary: {
        kind: "model",
        phase: "after",
        boundaryId: `${RUN_ID}:model:1`,
        attempt: 1,
      },
      sequence: 1,
      parent: {
        checkpointId: modelBefore.checkpointId,
        checkpointSha256: modelBefore.checkpointSha256,
        sequence: modelBefore.sequence,
      },
      enginePin: expanded.enginePin,
      stateReferences: [
        {
          kind: "run_record",
          referenceId: RUN_ID,
          referenceSha256: canonicalJsonSha256("run before approval"),
          versionId: "agent_run_v1",
        },
        {
          kind: "harness_manifest",
          referenceId: expanded.enginePin.harnessManifestId,
          referenceSha256: expanded.enginePin.harnessManifestSha256,
          versionId: "harness_manifest_v1",
        },
        {
          kind: "model_turn",
          referenceId: `${RUN_ID}:model:1`,
          referenceSha256: canonicalJsonSha256("model receipt"),
          versionId: "model_turn_receipt_v1",
        },
      ],
      toolBinding: null,
      resourceUsage: {
        modelCallCount: 1,
        modelInputTokenCount: 10,
        modelOutputTokenCount: 5,
        cachedInputTokenCount: 2,
        toolCallCount: 0,
        toolResultByteCount: 0,
        externalEffectCount: 0,
        boundaryExternalEffectCount: 0,
        elapsedMs: 4_000,
      },
      lifecycleState: "active",
      resumeDisposition: "resumable",
      recordedAt: "2026-09-05T12:00:04.000Z",
    });
    expect(() =>
      validateRunCheckpointSuccessorV1(modelBefore, parent)
    ).not.toThrow();
    const waiting = buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: expanded,
      parent,
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("waiting run"),
        approvalRequestSha256: canonicalJsonSha256("approval request"),
        toolExecutionSha256: canonicalJsonSha256("pending tool"),
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
      recordedAt: RECORDED_AT,
    });

    expect(waiting.resourceUsage).toMatchObject({
      modelCallCount: 1,
      toolCallCount: 0,
      elapsedMs: 5_000,
    });
    expect(() => validateRunCheckpointSuccessorV1(parent, waiting)).not.toThrow();
  });

  it("accepts only the dedicated canary configuration for a canary pin", () => {
    const canary = structuredClone(enrollment());
    canary.enginePin.rolloutMode = "canary";
    canary.enginePin.configurationSha256 =
      RUN_CHECKPOINT_CANARY_CONFIGURATION_SHA256;

    expect(() => buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: canary,
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("run"),
        approvalRequestSha256: canonicalJsonSha256("approval"),
        toolExecutionSha256: canonicalJsonSha256("tool"),
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
      recordedAt: RECORDED_AT,
    })).not.toThrow();

    canary.enginePin.configurationSha256 =
      RUN_CHECKPOINT_CONFIGURATION_SHA256;
    expect(() => buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: canary,
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("run"),
        approvalRequestSha256: canonicalJsonSha256("approval"),
        toolExecutionSha256: canonicalJsonSha256("tool"),
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
      recordedAt: RECORDED_AT,
    })).toThrow(/binding changed/i);
  });

  it("builds a metadata-only, non-resumable waiting shadow", () => {
    const checkpoint = buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("run"),
        approvalRequestSha256: canonicalJsonSha256("approval"),
        toolExecutionSha256: canonicalJsonSha256("tool"),
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
      recordedAt: RECORDED_AT,
    });

    expect(checkpoint.boundary).toEqual({
      kind: "approval",
      phase: "waiting",
      boundaryId: EXECUTION_ID,
      attempt: 1,
    });
    expect(checkpoint.lifecycleState).toBe("waiting");
    expect(checkpoint.resumeDisposition).toBe("awaiting_signal");
    expect(checkpoint.toolBinding).toBeNull();
    expect(checkpoint.stateReferences.map((item) => item.kind)).toEqual([
      "approval_request",
      "harness_manifest",
      "model_continuation",
      "run_record",
      "tool_execution",
    ]);
    expect(JSON.stringify(checkpoint)).not.toContain("private content");
  });

  it("rejects a pin that changed after enrollment", () => {
    const changed = structuredClone(enrollment());
    changed.enginePin.rolloutGeneration = 2;
    expect(() => parseApprovalCheckpointShadowEnrollment(changed)).not.toThrow();
    expect(() => buildApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: {
        ...changed,
        enginePin: {
          ...changed.enginePin,
          runContractEnvelopeSha256: canonicalJsonSha256("changed"),
        },
      },
      approvalExecutionId: EXECUTION_ID,
      state: {
        runRecordSha256: canonicalJsonSha256("run"),
        approvalRequestSha256: canonicalJsonSha256("approval"),
        toolExecutionSha256: canonicalJsonSha256("tool"),
        continuationSha256: canonicalJsonSha256("continuation"),
      },
      resourceUsage: {
        modelCallCount: 0,
        modelInputTokenCount: 0,
        modelOutputTokenCount: 0,
        cachedInputTokenCount: 0,
        toolCallCount: 0,
        toolResultByteCount: 0,
        externalEffectCount: 0,
        elapsedMs: 0,
      },
      recordedAt: RECORDED_AT,
    })).toThrow(/binding changed/i);
  });

  it("persists the checkpoint in the legacy continuation transaction", async () => {
    const value = continuation();
    const insertedEvents: unknown[][] = [];
    const sql = (async (
      strings: TemplateStringsArray,
      ...params: unknown[]
    ) => {
      if (strings.join(" ").includes("INSERT INTO omni_events")) {
        insertedEvents.push(params);
        return [{ seq: "1" }];
      }
      throw new Error(`Unexpected tagged SQL: ${strings.join(" ")}`);
    }) as unknown as RunCheckpointWriterSql;
    sql.query = async (text, params = []) => {
      if (
        text.includes("FROM omni_run_checkpoints") &&
        text.includes("ORDER BY sequence DESC")
      ) return [];
      if (text.includes("FROM omni_agent_runs")) {
        return [{
          id: RUN_ID,
          tenant_id: SCOPE.tenantId,
          status: "waiting_approval",
          response: "partial",
          continuation: value,
          started_at: "2026-09-05T12:00:00.000Z",
        }];
      }
      if (text.includes("FROM omni_tool_executions") && text.includes("LIMIT 2")) {
        return [{
          id: EXECUTION_ID,
          tenant_id: SCOPE.tenantId,
          actor_id: SCOPE.initiatingActorId,
          tool_id: "calendar.create",
          tool_name: "Create calendar event",
          risk_level: 2,
          status: "approval_required",
          dry_run: false,
          approval_required: true,
          input: {},
          output: {},
          reason: "Approval required",
          created_at: "2026-09-05T12:00:04.000Z",
        }];
      }
      if (text.includes("type = 'tool.scope_bound'")) {
        return [{ payload: {
          _executionScope: deriveExecutionScope(SCOPE, {
            causationId: "call_checkpoint_shadow",
            purpose: "agent.tool.execute",
          }),
          requesterRole: "operator",
          toolId: "calendar.create",
          inputSha256: canonicalJsonSha256("input"),
          scopeSha256: canonicalJsonSha256("scope"),
        } }];
      }
      if (text.includes("FROM omni_agent_events")) {
        return [
          {
            type: "model",
            payload: {
              inputTokens: 10,
              outputTokens: 5,
              cachedInputTokens: 2,
            },
          },
          { type: "tool", payload: { executionId: EXECUTION_ID } },
        ];
      }
      if (text.includes("id = ANY")) {
        return [{
          id: EXECUTION_ID,
          status: "approval_required",
          output: {},
          effect_receipt: null,
        }];
      }
      if (text.includes("INSERT INTO omni_run_checkpoints")) {
        return [{ checkpoint_json: params[26] }];
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

    const result = await recordApprovalWaitingCheckpointShadow({
      runId: RUN_ID,
      continuation: value,
      executionScope: SCOPE,
      runContractEnvelope: CONTRACT.envelope,
      enrollment: enrollment(),
      approvalExecutionId: EXECUTION_ID,
      response: "partial",
      recordedAt: RECORDED_AT,
    }, sql);

    expect(result).toMatchObject({
      outcome: "recorded",
      resumeAuthorityGranted: false,
      checkpoint: {
        lifecycleState: "waiting",
        resumeDisposition: "awaiting_signal",
      },
    });
    expect(insertedEvents).toHaveLength(2);
  });

  it.each([
    ["approved", "executing", "tool.approval.recorded", "execution_claimed", "active", "resumable"],
    ["rejected", "rejected", "tool.approval.rejected", "rejected", "terminal", "not_resumable"],
  ] as const)(
    "records a matched %s decision successor before legacy continuation",
    async (
      decision,
      toolStatus,
      eventType,
      eventOutcome,
      lifecycleState,
      resumeDisposition,
    ) => {
      const parent = waitingCheckpoint();
      const value = continuation();
      const insertedEvents: unknown[][] = [];
      const toolScope = deriveExecutionScope(SCOPE, {
        causationId: "call_checkpoint_shadow",
        purpose: "agent.tool.execute",
      });
      const sql = (async (
        strings: TemplateStringsArray,
        ...params: unknown[]
      ) => {
        if (strings.join(" ").includes("INSERT INTO omni_events")) {
          insertedEvents.push(params);
          return [{ seq: String(insertedEvents.length) }];
        }
        throw new Error(`Unexpected tagged SQL: ${strings.join(" ")}`);
      }) as unknown as RunCheckpointWriterSql;
      sql.query = async (text, params = []) => {
        if (text.includes("FROM omni_agent_runs")) {
          return [{
            id: RUN_ID,
            tenant_id: SCOPE.tenantId,
            status: "waiting_approval",
            response: "partial",
            continuation: value,
            started_at: "2026-09-05T12:00:00.000Z",
          }];
        }
        if (
          text.includes("FROM omni_run_checkpoints") &&
          text.includes("ORDER BY sequence DESC")
        ) {
          expect(text).toContain("LIMIT 1");
          return [{ checkpoint_json: parent }];
        }
        if (
          text.includes("FROM omni_run_checkpoints") &&
          text.includes("checkpoint_id = $3")
        ) {
          return [{ checkpoint_json: parent }];
        }
        if (text.includes("FROM omni_tool_executions")) {
          return [{
            id: EXECUTION_ID,
            tenant_id: SCOPE.tenantId,
            actor_id: SCOPE.initiatingActorId,
            tool_id: "calendar.create",
            tool_name: "Create calendar event",
            risk_level: 2,
            status: toolStatus,
            dry_run: false,
            approval_required: true,
            approval_decision: decision,
            approved_by: "actor_approver",
            approved_at: "2026-09-05T12:00:06.000Z",
            input: {},
            output: {},
            reason: "Decision recorded",
            effect_receipt: null,
            created_at: "2026-09-05T12:00:04.000Z",
          }];
        }
        if (text.includes("type = 'tool.scope_bound'")) {
          return [{ payload: {
            _executionScope: toolScope,
            requesterRole: "operator",
            toolId: "calendar.create",
            inputSha256: canonicalJsonSha256("input"),
            scopeSha256: canonicalJsonSha256("scope"),
          } }];
        }
        if (text.includes("payload->>'outcome'")) {
          expect(params[2]).toBe(eventType);
          expect(params[3]).toBe(eventOutcome);
          return [{
            id: `decision_event_${decision}`,
            type: eventType,
            actor_id: "actor_approver",
            payload: {
              schemaVersion: 1,
              executionId: EXECUTION_ID,
              decision,
              outcome: eventOutcome,
            },
            at: "2026-09-05T12:00:06.000Z",
          }];
        }
        if (text.includes("INSERT INTO omni_run_checkpoints")) {
          return [{ checkpoint_json: params[26] }];
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

      const result = await recordApprovalDecisionCheckpointShadow({
        tenantId: SCOPE.tenantId,
        approvalExecutionId: EXECUTION_ID,
        decision,
      }, sql);

      expect(result).toMatchObject({
        outcome: "recorded",
        resumeAuthorityGranted: false,
        checkpoint: {
          sequence: 1,
          lifecycleState,
          resumeDisposition,
          boundary: {
            kind: "approval",
            phase: "after",
            boundaryId: EXECUTION_ID,
          },
        },
      });
      expect(result.checkpoint?.parent).toEqual({
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: parent.sequence,
      });
      expect(insertedEvents).toHaveLength(2);
    },
  );
});
