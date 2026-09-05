import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { captureBrowserFrameAfterToolSafely } from "@/lib/browser/frames";
import {
  createGoogleCalendarEvent,
  googleCalendarCreateSchema,
  googleCalendarEventId,
  googleCalendarTargetState,
  reconcileGoogleCalendarEvent,
} from "@/lib/connectors/google-calendar-write";
import { embedTexts } from "@/lib/openai/client";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { validateConnectorInput } from "@/lib/connectors/input-validation";
import {
  callMcpTool,
  type McpSessionScope,
} from "@/lib/connectors/mcp-client";
import { callOpenApiOperation } from "@/lib/connectors/openapi-client";
import { assertConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { getOpenApiConnector, getOpenApiOperationById } from "@/lib/connectors/openapi-store";
import { getMcpConnector, getMcpToolById } from "@/lib/connectors/store";
import { readResponseTextLimited } from "@/lib/http/body";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import {
  publicMemoryDeletionReceiptV1,
  type MemoryDeletionReceiptV1,
} from "@/lib/memory/deletion-receipt";
import { queueMemoryGraphRebuild } from "@/lib/memory/graph";
import {
  correctMemory,
  forgetMemoryWithReceipt,
  getMemory,
  getMemoryDeletionReceipt,
  saveMemory,
  saveMemoryWithCommitStatus,
  searchMemories,
} from "@/lib/memory/store";
import type { MemoryRecord, MemoryType } from "@/lib/memory/types";
import {
  appendMissionTaskComment,
  ensureMissionTask,
  getMissionDetail,
  getMissionTask,
  listMissions,
} from "@/lib/missions/store";
import type {
  Mission,
  MissionArtifact,
  MissionAttempt,
  MissionDetail,
  MissionTask,
} from "@/lib/missions/types";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  executionScopesEqual,
  executionScopeFromSecurityContext,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { assertPublicHttpUrl, fetchPublicHttpUrl } from "@/lib/security/network";
import { redactExactSecrets } from "@/lib/security/secret-redaction";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { searchKnowledge } from "@/lib/rag/store";
import { listAgentRuns } from "@/lib/runs/store";
import { publicAgentRun } from "@/lib/runs/public";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  completeClaimedToolExecution,
  claimIdempotentToolExecution,
  createToolExecutionRecord,
  getToolExecution,
  getToolExecutionApprovalFingerprint,
  getToolExecutionEffectIntentV2,
  persistClaimedToolEffectIntentV2,
  reclaimStaleMemoryForgetToolExecutionClaim,
  repairFileToolEffectReceiptEvent,
  recoverStaleToolExecutionClaim,
  saveToolExecution,
  sealToolExecutionInput,
} from "@/lib/tools/audit-store";
import { approvalMaterialBindingSha256 } from "@/lib/tools/approval-binding";
import { toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import { evaluateToolPolicy } from "@/lib/tools/policy";
import type { SecurityContext } from "@/lib/security/types";
import {
  assertToolExecutionBindingMatchesRequest,
  bindToolExecutionScope,
  getToolExecutionScopeBinding,
  toolInputSha256,
  ToolExecutionScopeBindingError,
  type ToolExecutionScopeBinding,
} from "@/lib/tools/execution-scope";
import {
  buildEffectReceiptV1,
  canonicalJsonSha256,
  idempotencyKeySha256,
  memoryEffectTargetIdV1,
  parseEffectReceiptV1,
  type EffectReceiptV1,
} from "@/lib/tools/effect-receipt";
import {
  buildEffectIntentV2,
  finalizeEffectIntentV2,
  type EffectIntentV2,
} from "@/lib/tools/effect-intent-v2";
import { getGovernedTool } from "@/lib/tools/registry";
import { RISK3_QUORUM, type ToolDefinition, type ToolExecutionRecord } from "@/lib/tools/types";
import { actionClassFor, recordActionOutcome, resolveAutonomy } from "@/lib/trust/ledger";
import { isGraduatedAutonomyEnabled } from "@/lib/trust/policy";
import { runLiveWebSearch } from "@/lib/web-search/search";
import type { AiUsageOperation, AiUsageScope } from "@/lib/usage/types";

const searchSchema = z.object({
  query: z.string().min(1).max(4_000),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

const webSearchSchema = z.object({
  query: z.string().min(1).max(4_000),
  limit: z.number().int().min(1).max(20).optional(),
  searchContextSize: z.enum(["low", "medium", "high"]).optional(),
  allowedDomains: z.array(z.string().min(1).max(253)).max(20).optional(),
}).strict();

const memoryWriteSchema = z.object({
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(200_000),
  type: z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]).optional(),
  tags: z.array(z.string().min(1).max(80)).max(50).optional(),
  importance: z.number().min(0).max(1).optional(),
}).strict();

const memoryCorrectSchema = z.object({
  id: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(240).optional(),
  content: z.string().min(1).max(200_000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  validTo: z.string().datetime().optional(),
  contradiction: z.literal(true).optional(),
}).strict().refine(
  ({ title, content, confidence, validTo, contradiction }) =>
    title !== undefined ||
    content !== undefined ||
    confidence !== undefined ||
    validTo !== undefined ||
    contradiction === true,
  { message: "At least one correction field is required." },
);

const memoryForgetSchema = z.object({
  id: z.string().trim().min(1).max(200),
}).strict();

const knowledgeIngestSchema = z.object({
  title: z.string().min(1).max(240),
  content: z.string().min(1).max(20000),
  source: z.string().max(2_000).optional(),
  tags: z.array(z.string().min(1).max(80)).max(50).optional(),
}).strict();

const runsListSchema = z.object({
  limit: z.number().int().min(1).max(25).optional(),
}).strict();

const missionStatusSchema = z.enum([
  "draft",
  "queued",
  "running",
  "waiting",
  "succeeded",
  "failed",
  "canceled",
  "archived",
]);

const missionsListSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
  status: missionStatusSchema.optional(),
}).strict();

const missionShowSchema = z.object({
  missionId: z.string().uuid(),
}).strict();

const missionTaskCreateSchema = z.object({
  missionId: z.string().uuid(),
  title: z.string().trim().min(1).max(280),
  instructions: z.string().trim().min(1).max(8_000).optional(),
  definitionOfDone: z.string().trim().min(1).max(2_000).optional(),
  priority: z.enum(["low", "normal", "high", "urgent"]).optional(),
  dependencyIds: z.array(z.string().uuid()).max(50).refine(
    (ids) => new Set(ids).size === ids.length,
    "Dependency IDs must be unique.",
  ).optional(),
  assigneeKey: z.string().trim().min(1).max(160).optional(),
  skillIds: z.array(z.string().trim().min(1).max(120)).max(30).refine(
    (ids) => new Set(ids).size === ids.length,
    "Skill IDs must be unique.",
  ).optional(),
  reviewRequired: z.boolean().optional(),
}).strict();

const missionTaskCommentSchema = z.object({
  missionId: z.string().uuid(),
  taskId: z.string().uuid(),
  body: z.string().trim().min(1).max(4_000),
}).strict();

const httpRequestSchema = z.object({
  url: z.string().min(1).max(2048),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string().max(120), z.string().max(4096)).refine(
    (headers) => Object.keys(headers).length <= 50,
    "At most 50 request headers are allowed.",
  ).optional(),
  body: z.string().max(100_000).optional(),
  authEnv: z.string().max(120).optional(),
  authHeader: z.enum(["authorization", "x-api-key", "x-auth-token", "api-key"]).optional(),
  authMode: z.enum(["bearer", "basic", "raw"]).optional(),
}).strict().superRefine((input, context) => {
  if ((input.authHeader || input.authMode) && !input.authEnv) {
    context.addIssue({
      code: "custom",
      message: "authHeader and authMode require authEnv.",
    });
  }
  const header = input.authHeader || "authorization";
  const mode = input.authMode || (header === "authorization" ? "bearer" : "raw");
  if (
    (header === "authorization" && mode === "raw") ||
    (header !== "authorization" && mode !== "raw")
  ) {
    context.addIssue({
      code: "custom",
      message:
        "Authorization supports bearer or basic mode; API-key headers require raw mode.",
    });
  }
});

const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const HTTP_RESPONSE_MAX_BYTES = 20_000;

class ExecutionClaimLostError extends Error {
  constructor() {
    super("Tool execution claim was lost before completion.");
    this.name = "ExecutionClaimLostError";
  }
}

class MemoryForgetNotFoundError extends Error {
  constructor() {
    super("Memory not found.");
    this.name = "MemoryForgetNotFoundError";
  }
}

export class EffectReceiptFinalizationError extends Error {
  constructor(options?: { cause?: unknown }) {
    super(
      "The live effect may have completed, but its verification receipt is not finalized.",
      options,
    );
    this.name = "EffectReceiptFinalizationError";
  }
}

export type GovernedToolEffectBinding = Readonly<{
  workflowRunId: string;
  planId: string;
  planSha256: string;
  planNodeId: string;
}>;

export type GovernedToolExecutionResult = {
  record: ToolExecutionRecord;
  result: unknown;
};

export type GovernedToolCheckpointInput = Readonly<{
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  operationClass: "read_only" | "mutation";
  executionScope: ExecutionScope;
}>;

export class ToolInputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputValidationError";
  }
}

export async function executeGovernedTool({
  toolId,
  input,
  dryRun = true,
  approved = false,
  context,
  existingRecord,
  approvalReason,
  executionClaimToken,
  abortSignal,
  idempotencyKey,
  forceApproval = false,
  mcpSessionScope,
  executionScope,
  effectBinding,
  checkpointBeforeEffect,
}: {
  toolId: string;
  input: Record<string, unknown>;
  dryRun?: boolean;
  approved?: boolean;
  context?: SecurityContext;
  existingRecord?: ToolExecutionRecord;
  approvalReason?: string;
  executionClaimToken?: string;
  abortSignal?: AbortSignal;
  idempotencyKey?: string;
  /** Hardens write tools for agents configured to approve every mutation. */
  forceApproval?: boolean;
  /** Explicit owner/run boundary used only by stateful MCP transports. */
  mcpSessionScope?: McpSessionScope;
  /** Durable attribution inherited from the initiating run or request. */
  executionScope?: ExecutionScope;
  /** Exact persisted execution-plan binding for the P1.4 memory-write canary. */
  effectBinding?: GovernedToolEffectBinding;
  /** Dormant checkpoint shadow hook invoked after intent persistence. */
  checkpointBeforeEffect?: (
    input: GovernedToolCheckpointInput,
  ) => Promise<void>;
}): Promise<GovernedToolExecutionResult> {
  assertRequestedToolExecutionScope(
    executionScope,
    context,
    existingRecord,
    executionClaimToken,
  );
  try {
    assertToolInputSize(input);
  } catch (error) {
    if (existingRecord && executionClaimToken) {
      return completeClaimedInputValidationFailure(
        existingRecord,
        executionClaimToken,
        error,
      );
    }
    throw error;
  }
  const registeredTool =
    getGovernedTool(toolId) ||
    (await getMcpGovernedTool(toolId, { tenantId: context?.tenantId })) ||
    (await getOpenApiGovernedTool(toolId, { tenantId: context?.tenantId }));
  if (!registeredTool) {
    const scopedRequest = await resolveToolExecutionScopeRequest({
      record: existingRecord,
      toolInput: input,
      requestedScope: executionScope,
      context,
      executionClaimToken,
      mcpSessionScope,
    });
    const reason = "Unknown tools are blocked by default.";
    const patch: Omit<ToolExecutionRecord, "id" | "createdAt"> = {
      tenantId: existingRecord?.tenantId || context?.tenantId,
      actorId: existingRecord?.actorId || context?.actorId,
      toolId,
      toolName: "Unknown tool",
      riskLevel: 3,
      status: "blocked",
      dryRun,
      approvalRequired: true,
      input: redactSensitive(input) as Record<string, unknown>,
      output: undefined,
      reason,
      completedAt: new Date().toISOString(),
    };
    const record = existingRecord
      ? {
          ...existingRecord,
          ...patch,
          id: existingRecord.id,
          createdAt: existingRecord.createdAt,
          input: existingRecord.input,
        }
      : createToolExecutionRecord(patch);
    await recordToolPolicyBlock({
      context,
      executionScope: scopedRequest.executionScope,
      toolId,
      reason,
      input,
      riskLevel: 3,
    });
    const saved = executionClaimToken
      ? await completeClaimedToolExecution(record, executionClaimToken)
      : await saveToolExecution(record);
    if (!saved) {
      if (record.effectReceipt) {
        throw new EffectReceiptFinalizationError({
          cause: new ExecutionClaimLostError(),
        });
      }
      throw new ExecutionClaimLostError();
    }
    await bindToolScopeIfPresent({
      record: saved,
      toolInput: input,
      scopedRequest,
    });
    return { record: saved, result: null };
  }
  const effectiveForceApproval = forceApproval || Boolean(
    existingRecord?.approvalRequired && !registeredTool.approvalRequired && registeredTool.riskLevel > 0,
  );
  const registeredApprovalFingerprint = toolApprovalFingerprint(registeredTool);
  const tool = effectiveForceApproval
    ? {
        ...registeredTool,
        approvalRequired: true,
        approvalFingerprint: registeredApprovalFingerprint,
      }
    : registeredTool;
  if (
    !dryRun &&
    tool.id === "memory.forget" &&
    existingRecord?.status === "executing" &&
    executionClaimToken &&
    executionClaimTokenFromRecord(existingRecord) === executionClaimToken
  ) {
    const parsedForgetInput = memoryForgetSchema.safeParse(input);
    if (parsedForgetInput.success) {
      const scopedForgetRequest = await resolveToolExecutionScopeRequest({
        record: existingRecord,
        toolInput: parsedForgetInput.data,
        requestedScope: executionScope,
        context,
        executionClaimToken,
        mcpSessionScope,
      });
      const reconciled = await reconcileExistingMemoryForgetEffect({
        record: existingRecord,
        tool,
        preparedInput: parsedForgetInput.data,
        executionScope: scopedForgetRequest.executionScope,
      });
      if (reconciled) {
        return { record: reconciled, result: reconciled.output };
      }
    }
  }
  if (
    !dryRun &&
    tool.id === "calendar.create" &&
    existingRecord?.status === "executing" &&
    executionClaimToken &&
    executionClaimTokenFromRecord(existingRecord) === executionClaimToken &&
    Boolean(getToolExecutionEffectIntentV2(existingRecord))
  ) {
    const parsedCalendarInput = googleCalendarCreateSchema.safeParse(input);
    if (parsedCalendarInput.success) {
      const scopedCalendarRequest = await resolveToolExecutionScopeRequest({
        record: existingRecord,
        toolInput: parsedCalendarInput.data,
        requestedScope: executionScope,
        context,
        executionClaimToken,
        mcpSessionScope,
      });
      const reconciled = await reconcileExistingGoogleCalendarEffect({
        record: existingRecord,
        tool,
        preparedInput: parsedCalendarInput.data,
        effectBinding,
        executionScope: scopedCalendarRequest.executionScope,
        abortSignal,
      });
      if (reconciled) {
        return { record: reconciled, result: reconciled.output };
      }
    }
  }
  if (existingRecord && executionClaimToken) {
    const reviewedFingerprint =
      getToolExecutionApprovalFingerprint(existingRecord);
    if (
      !reviewedFingerprint ||
      reviewedFingerprint !== toolApprovalFingerprint(tool)
    ) {
      return completeClaimedInputValidationFailure(
        existingRecord,
        executionClaimToken,
        new ToolInputValidationError(
          "The tool contract changed after approval. Submit the action again.",
        ),
      );
    }
  }
  let preparedInput: Record<string, unknown>;
  try {
    preparedInput = parseInput(tool, input);
  } catch (error) {
    if (existingRecord && executionClaimToken) {
      return completeClaimedInputValidationFailure(
        existingRecord,
        executionClaimToken,
        error,
      );
    }
    if (
      effectBinding &&
      tool.id === "memory.write" &&
      !dryRun &&
      idempotencyKey
    ) {
      let existing: ToolExecutionRecord | undefined;
      try {
        existing = await getToolExecution(
          idempotentToolExecutionId(
            normalizeTenantId(context?.tenantId),
            idempotencyKey,
          ),
          { tenantId: context?.tenantId },
        );
      } catch (lookupError) {
        throw new EffectReceiptFinalizationError({ cause: lookupError });
      }
      if (
        existing?.status === "executed" &&
        !existing.dryRun &&
        existing.effectReceipt !== undefined
      ) {
        try {
          const safeRequestedInput = redactSensitive(input) as Record<
            string,
            unknown
          >;
          if (
            toolInputSha256(safeRequestedInput) !==
              toolInputSha256(existing.input)
          ) {
            throw new ToolExecutionScopeBindingError(
              "Idempotent tool input does not match its completed governed effect.",
            );
          }
          const resolved = await resolveToolExecutionScopeRequest({
            record: existing,
            toolInput: input,
            requestedScope: executionScope,
            context,
            executionClaimToken: undefined,
            mcpSessionScope,
          });
          assertCompletedMemoryWriteEffectReceipt({
            record: existing,
            effectBinding,
            executionScope: resolved.executionScope,
            idempotencyKey,
          });
          await repairFileToolEffectReceiptEvent(
            existing,
            resolved.executionScope,
          );
          return { record: existing, result: existing.output };
        } catch (receiptError) {
          throw new EffectReceiptFinalizationError({ cause: receiptError });
        }
      }
      if (existing && !isLegacyExecutionForEffectCanary(existing)) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
    }
    throw toolInputValidationError(error);
  }
  if (tool.id === "http.request") {
    try {
      await validateHttpRequestForApproval(
        httpRequestSchema.parse(preparedInput),
        context,
      );
    } catch (error) {
      if (existingRecord && executionClaimToken) {
        return completeClaimedInputValidationFailure(
          existingRecord,
          executionClaimToken,
          error,
        );
      }
      throw toolInputValidationError(error);
    }
  }

  const scopedRequest = await resolveToolExecutionScopeRequest({
    record: existingRecord,
    toolInput: preparedInput,
    requestedScope: executionScope,
    context,
    executionClaimToken,
    mcpSessionScope,
  });
  const toolRuntimeContext = scopedToolRuntimeContext(
    context,
    existingRecord,
    scopedRequest,
  );
  const effectCanaryRequest = Boolean(
    !dryRun &&
    idempotencyKey &&
    !existingRecord &&
    effectBinding &&
    tool.id === "memory.write",
  );

  if (effectCanaryRequest && idempotencyKey) {
    let existing: ToolExecutionRecord | undefined;
    try {
      existing = await getToolExecution(
        idempotentToolExecutionId(
          normalizeTenantId(context?.tenantId),
          idempotencyKey,
        ),
        { tenantId: context?.tenantId },
      );
    } catch (error) {
      throw new EffectReceiptFinalizationError({ cause: error });
    }
    if (existing) {
      if (isLegacyExecutionForEffectCanary(existing)) {
        await assertExistingScopedToolReceipt({
          record: existing,
          tool,
          toolInput: preparedInput,
          requestedScope: executionScope,
          context,
          mcpSessionScope,
          idempotencyKey,
        });
        const recovered = existing.status === "executing"
          ? await recoverStaleToolExecutionClaim(existing.id, {
              tenantId: context?.tenantId,
            })
          : undefined;
        const record = recovered || existing;
        return {
          record,
          result: record.status === "executed" ? record.output : null,
        };
      }
      try {
        await assertExistingScopedToolReceipt({
          record: existing,
          tool,
          toolInput: preparedInput,
          requestedScope: executionScope,
          context,
          mcpSessionScope,
          effectBinding,
          idempotencyKey,
        });
      } catch (error) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      const reconciled = await reconcileExistingMemoryWriteEffect({
        record: existing,
        tool,
        preparedInput,
        effectBinding,
        executionScope: scopedRequest.executionScope,
        idempotencyKey,
      });
      if (reconciled) {
        await repairFileToolEffectReceiptEvent(
          reconciled,
          scopedRequest.executionScope,
        );
        return { record: reconciled, result: reconciled.output };
      }
      if (existing.status !== "executing") {
        await repairFileToolEffectReceiptEvent(
          existing,
          scopedRequest.executionScope,
        );
        return {
          record: existing,
          result: existing.status === "executed" ? existing.output : null,
        };
      }
    }
  }

  // Idempotent retries must resolve their existing receipt before consulting
  // (and consuming) the earned-autonomy budget. This keeps transport retries
  // from spending additional authority or producing a new approval decision.
  if (
    !dryRun &&
    idempotencyKey &&
    !existingRecord &&
    !effectCanaryRequest
  ) {
    const existing = await getToolExecution(
      idempotentToolExecutionId(
        normalizeTenantId(context?.tenantId),
        idempotencyKey,
      ),
      { tenantId: context?.tenantId },
    );
    if (existing) {
      try {
        await assertExistingScopedToolReceipt({
          record: existing,
          tool,
          toolInput: preparedInput,
          requestedScope: executionScope,
          context,
          mcpSessionScope,
          effectBinding,
          idempotencyKey,
        });
      } catch (error) {
        if (!isLegacyExecutionForEffectCanary(existing)) {
          throw new EffectReceiptFinalizationError({ cause: error });
        }
        throw error;
      }
      const reconciled = (await reconcileExistingMemoryWriteEffect({
        record: existing,
        tool,
        preparedInput,
        effectBinding,
        executionScope: scopedRequest.executionScope,
        idempotencyKey,
      })) ?? (await reconcileExistingMemoryForgetEffect({
        record: existing,
        tool,
        preparedInput,
        executionScope: scopedRequest.executionScope,
      })) ?? (await reconcileExistingGoogleCalendarEffect({
        record: existing,
        tool,
        preparedInput,
        effectBinding,
        executionScope: scopedRequest.executionScope,
        abortSignal,
      }));
      if (
        !reconciled &&
        existing.status === "executing" &&
        tool.id === "memory.forget"
      ) {
        const replayClaimToken = randomUUID();
        const reclaimed = await reclaimStaleMemoryForgetToolExecutionClaim(
          existing,
          {
            tenantId: context?.tenantId,
            claimToken: replayClaimToken,
          },
        );
        if (reclaimed) {
          return executeGovernedTool({
            toolId: tool.id,
            input: preparedInput,
            dryRun: false,
            approved: true,
            context,
            existingRecord: reclaimed,
            approvalReason: reclaimed.approvalReason,
            executionClaimToken: replayClaimToken,
            abortSignal,
            idempotencyKey,
            forceApproval,
            mcpSessionScope,
            executionScope,
            effectBinding,
            checkpointBeforeEffect,
          });
        }
      }
      const recovered = !reconciled && existing.status === "executing"
        ? await recoverStaleToolExecutionClaim(existing.id, {
            tenantId: context?.tenantId,
          })
        : undefined;
      const record = reconciled || recovered || existing;
      await repairFileToolEffectReceiptEvent(
        record,
        scopedRequest.executionScope,
      );
      if (
        effectBinding &&
        tool.id === "memory.write" &&
        record.status === "executing"
      ) {
        throw new EffectReceiptFinalizationError();
      }
      return {
        record,
        result: record.status === "executed" ? record.output : null,
      };
    }
  }

  // Risk-3 approval is only honored when the record itself carries quorum
  // evidence: RISK3_QUORUM distinct admin/system approvers, requester excluded.
  // Enforced here so no API caller can bypass it with a bare approved flag.
  // A persisted approval record is executable only after the approval store
  // atomically changes it to `executing` and supplies the matching claim token.
  // This also fences legacy callers that pass approved=true after merely
  // reading an approval_required record.
  const durableApprovalClaim =
    !existingRecord ||
    (existingRecord.status === "executing" && Boolean(executionClaimToken));
  const effectiveApproved =
    approved &&
    durableApprovalClaim &&
    (tool.riskLevel < 3 || hasRisk3Quorum(existingRecord));

  // Graduated autonomy: an action class that has earned trust (clean track
  // record, reversible, risk < 3) may auto-approve instead of gating. Opt-in
  // and conservative — resolveAutonomy re-checks reversibility and risk tier.
  const reversible = tool.reversible ?? false;
  let autonomy: Awaited<ReturnType<typeof resolveAutonomy>> | undefined;
  let autonomyApproved = false;
  if (!dryRun && !effectiveApproved && isGraduatedAutonomyEnabled() && tool.riskLevel < 3) {
    autonomy = await resolveAutonomy({
      toolId: tool.id,
      tenantId: normalizeTenantId(context?.tenantId),
      riskLevel: tool.riskLevel,
      reversible,
    });
    if (autonomy.mode === "auto_with_alert") {
      try {
        const budget = await checkSharedRateLimit({
          key: `autonomy:${normalizeTenantId(context?.tenantId)}:${actionClassFor(tool.id)}`,
          limit: autonomy.budget.maxActions,
          windowMs: autonomy.budget.windowSeconds * 1_000,
        });
        autonomyApproved = budget.allowed;
        if (!budget.allowed) {
          autonomy = {
            ...autonomy,
            mode: "approve_each",
            stage: "supervised",
            reason: `The earned-autonomy budget is exhausted. Approval is required for ${budget.retryAfterSeconds} more seconds.`,
          };
        }
      } catch {
        // A missing shared budget ledger must never widen authority.
        autonomy = {
          ...autonomy,
          mode: "approve_each",
          stage: "supervised",
          reason: "The autonomy budget could not be verified, so approval remains required.",
        };
      }
    }
  }

  const decision = evaluateToolPolicy({ tool, approved: effectiveApproved || autonomyApproved });
  const baseRecord = {
    tenantId: existingRecord?.tenantId || context?.tenantId,
    actorId: existingRecord?.actorId || context?.actorId,
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: decision.riskLevel,
    dryRun,
    approvalRequired: decision.approvalRequired,
    input:
      redactSensitive(preparedInput) as Record<string, unknown>,
    reason: decision.reason,
  };
  let executionRecord = existingRecord;
  let activeExecutionClaimToken = executionClaimToken;
  const createRecord = (patch: Omit<ToolExecutionRecord, "id" | "createdAt">) => {
    if (!executionRecord) {
      return createToolExecutionRecord(patch);
    }

    return {
      ...executionRecord,
      ...patch,
      id: executionRecord.id,
      createdAt: executionRecord.createdAt,
    };
  };
  const bindPersistedRecord = async (record: ToolExecutionRecord) => {
    try {
      await bindToolScopeIfPresent({
        record,
        toolInput: preparedInput,
        scopedRequest,
      });
    } catch (error) {
      if (record.status === "approval_required") {
        await saveToolExecution({
          ...record,
          status: "failed",
          output: {
            error:
              "The action was not offered for approval because its execution scope could not be bound.",
          },
          reason:
            "Governed tool execution scope binding failed before approval.",
          completedAt: new Date().toISOString(),
        }).catch(() => undefined);
      }
      throw error;
    }
    return record;
  };
  const persistRecord = async (record: ToolExecutionRecord) => {
    if (!activeExecutionClaimToken) {
      const saved = await saveToolExecution(record);
      return bindPersistedRecord(saved);
    }
    let saved: ToolExecutionRecord | undefined;
    try {
      saved = await completeClaimedToolExecution(
        record,
        activeExecutionClaimToken,
        { executionScope: scopedRequest.executionScope },
      );
    } catch (error) {
      if (record.effectReceipt) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
    if (!saved) {
      if (record.effectReceipt) {
        throw new EffectReceiptFinalizationError({
          cause: new ExecutionClaimLostError(),
        });
      }
      throw new ExecutionClaimLostError();
    }
    try {
      return await bindPersistedRecord(saved);
    } catch (error) {
      if (saved.effectReceipt) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
  };

  if (decision.blocked) {
    const record = createRecord({
      ...baseRecord,
      status: "blocked" as const,
      output: undefined,
      completedAt: new Date().toISOString(),
    });
    await recordToolPolicyBlock({
      context,
      executionScope: scopedRequest.executionScope,
      toolId: tool.id,
      toolName: tool.name,
      reason: decision.reason,
      input: preparedInput,
      riskLevel: decision.riskLevel,
    });
    return { record: await persistRecord(record), result: null };
  }

  if (decision.approvalRequired && !decision.allowed && !dryRun) {
    const pendingRecord = createRecord({
      ...baseRecord,
      status: "approval_required" as const,
      output: undefined,
    });
    const pendingProviderEffect = prepareProviderEffectMaterial(
      tool,
      preparedInput,
      pendingRecord.id,
    );
    const record = {
      ...pendingRecord,
      output: sealToolExecutionInput(
        preparedInput,
        pendingRecord,
        toolApprovalFingerprint(tool),
        pendingProviderEffect
          ? {
              approvalMaterialBindingSha256:
                pendingProviderEffect.approvalBindingSha256,
            }
          : {},
      ),
    };
    await bindToolScopeIfPresent({
      record,
      toolInput: preparedInput,
      scopedRequest,
    });
    const saved = await persistRecord(record);
    await recordRuntimeEventSafely({
      level: "warn",
      category: "workflow",
      action: "tool.approval_pending",
      tenantId: scopedRequest.executionScope?.tenantId || context?.tenantId,
      actorId:
        scopedRequest.executionScope?.initiatingActorId || context?.actorId,
      resourceType: "tool_execution",
      resourceId: saved.id,
      message: `${tool.name} is waiting for human approval.`,
      metadata: {
        toolId: tool.id,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
      },
      correlationId: scopedRequest.executionScope?.correlationId,
    });
    return { record: saved, result: null };
  }

  if (!dryRun && idempotencyKey && !executionRecord) {
    const claimToken = randomUUID();
    const intendedExecutionId = idempotentToolExecutionId(
      normalizeTenantId(context?.tenantId),
      idempotencyKey,
    );
    const intendedEffectContext = prepareMemoryWriteEffectContext({
      tool,
      preparedInput,
      effectBinding,
      executionScope: scopedRequest.executionScope,
      executionId: intendedExecutionId,
      idempotencyKey,
    });
    const intendedProviderEffect = prepareProviderEffectMaterial(
      tool,
      preparedInput,
      intendedExecutionId,
    );
    const intent = createToolExecutionRecord({
      ...baseRecord,
      status: "executing",
      output: {
        __executionClaim: {
          token: claimToken,
          claimedAt: new Date().toISOString(),
        },
        __idempotencyKeyHash: createHash("sha256")
          .update(idempotencyKey)
          .digest("hex"),
        ...(intendedEffectContext
          ? {
              __effectIdempotencyKeySha256:
                intendedEffectContext.idempotencyKeySha256,
              __effectInputSha256: intendedEffectContext.inputSha256,
              __effectPlanSha256:
                intendedEffectContext.binding.planSha256,
              __effectTargetId: intendedEffectContext.targetId,
              __effectToolContractSha256:
                intendedEffectContext.toolContractSha256,
            }
          : {}),
      },
      approvalDecision: decision.approvalRequired ? "approved" : undefined,
      approvedBy: decision.approvalRequired ? context?.actorId : undefined,
      approvedAt: decision.approvalRequired
        ? new Date().toISOString()
        : undefined,
      approvalReason,
    });
    intent.id = intendedExecutionId;
    intent.output = {
      ...asObjectRecord(intent.output),
      ...sealToolExecutionInput(
        preparedInput,
        intent,
        toolApprovalFingerprint(tool),
        intendedProviderEffect
          ? {
              approvalMaterialBindingSha256:
                intendedProviderEffect.approvalBindingSha256,
            }
          : {},
      ),
    };
    let claim: Awaited<ReturnType<typeof claimIdempotentToolExecution>>;
    try {
      claim = await claimIdempotentToolExecution(intent);
    } catch (error) {
      if (intendedEffectContext) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
    if (claim.outcome === "existing") {
      if (isLegacyExecutionForEffectCanary(claim.record)) {
        await assertExistingScopedToolReceipt({
          record: claim.record,
          tool,
          toolInput: preparedInput,
          requestedScope: executionScope,
          context,
          mcpSessionScope,
          idempotencyKey,
        });
        const recovered = claim.record.status === "executing"
          ? await recoverStaleToolExecutionClaim(claim.record.id, {
              tenantId: context?.tenantId,
            })
          : undefined;
        const record = recovered || claim.record;
        return {
          record,
          result: record.status === "executed" ? record.output : null,
        };
      }
      try {
        await assertExistingScopedToolReceipt({
          record: claim.record,
          tool,
          toolInput: preparedInput,
          requestedScope: executionScope,
          context,
          mcpSessionScope,
          effectBinding,
          idempotencyKey,
        });
      } catch (error) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      const reconciled = (await reconcileExistingMemoryWriteEffect({
        record: claim.record,
        tool,
        preparedInput,
        effectBinding,
        executionScope: scopedRequest.executionScope,
        idempotencyKey,
      })) ?? (await reconcileExistingMemoryForgetEffect({
        record: claim.record,
        tool,
        preparedInput,
        executionScope: scopedRequest.executionScope,
      })) ?? (await reconcileExistingGoogleCalendarEffect({
        record: claim.record,
        tool,
        preparedInput,
        effectBinding,
        executionScope: scopedRequest.executionScope,
        abortSignal,
      }));
      const recovered =
        !intendedEffectContext &&
        !reconciled &&
        claim.record.status === "executing"
          ? await recoverStaleToolExecutionClaim(claim.record.id, {
              tenantId: context?.tenantId,
            })
          : undefined;
      const record = reconciled || recovered || claim.record;
      await repairFileToolEffectReceiptEvent(
        record,
        scopedRequest.executionScope,
      );
      if (
        effectBinding &&
        tool.id === "memory.write" &&
        record.status === "executing"
      ) {
        throw new EffectReceiptFinalizationError();
      }
      return {
        record,
        result: record.status === "executed" ? record.output : null,
      };
    }
    executionRecord = claim.record;
    activeExecutionClaimToken = claimToken;
    try {
      await bindToolScopeIfPresent({
        record: executionRecord,
        toolInput: preparedInput,
        scopedRequest,
      });
    } catch (error) {
      if (intendedEffectContext) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
    if (intendedEffectContext) {
      const reconciled = await reconcileExistingMemoryWriteEffect({
        record: executionRecord,
        tool,
        preparedInput,
        effectBinding,
        executionScope: scopedRequest.executionScope,
        idempotencyKey,
      });
      if (reconciled) {
        await repairFileToolEffectReceiptEvent(
          reconciled,
          scopedRequest.executionScope,
        );
        return { record: reconciled, result: reconciled.output };
      }
    }
  }

  if (
    !dryRun &&
    !idempotencyKey &&
    !executionRecord &&
    scopedRequest.executionScope
  ) {
    const claimToken = randomUUID();
    const intent = createToolExecutionRecord({
      ...baseRecord,
      status: "executing",
      output: {
        __executionClaim: {
          token: claimToken,
          claimedAt: new Date().toISOString(),
        },
      },
    });
    const intendedProviderEffect = prepareProviderEffectMaterial(
      tool,
      preparedInput,
      intent.id,
    );
    intent.output = {
      ...asObjectRecord(intent.output),
      ...sealToolExecutionInput(
        preparedInput,
        intent,
        toolApprovalFingerprint(tool),
        intendedProviderEffect
          ? {
              approvalMaterialBindingSha256:
                intendedProviderEffect.approvalBindingSha256,
            }
          : {},
      ),
    };
    executionRecord = await saveToolExecution(intent);
    activeExecutionClaimToken = claimToken;
    await bindToolScopeIfPresent({
      record: executionRecord,
      toolInput: preparedInput,
      scopedRequest,
    });
  }

  try {
    if (dryRun) {
      const preview = dryRunTool(tool, preparedInput);
      const safePreview = redactSensitive(preview);
      const record = createRecord({
        ...baseRecord,
        status: "dry_run" as const,
        output: safePreview,
        completedAt: new Date().toISOString(),
      });
      return { record: await persistRecord(record), result: safePreview };
    }

    const effectContext = prepareMemoryWriteEffectContext({
      tool,
      preparedInput,
      effectBinding,
      executionScope: scopedRequest.executionScope,
      executionId: executionRecord?.id,
      idempotencyKey,
    });
    if (effectContext && executionRecord) {
      try {
        assertPreparedEffectIntent(executionRecord, effectContext);
      } catch (error) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
    }
    let providerEffectIntent: EffectIntentV2 | undefined;
    const providerEffectMaterial = prepareProviderEffectMaterial(
      tool,
      preparedInput,
      executionRecord?.id,
    );
    if (providerEffectMaterial) {
      try {
        if (
          !executionRecord ||
          !activeExecutionClaimToken ||
          !scopedRequest.executionScope
        ) {
          throw new Error(
            "A mutating HTTP request requires a claimed scoped execution.",
          );
        }
        providerEffectIntent = buildProviderEffectIntent({
          record: executionRecord,
          tool,
          material: providerEffectMaterial,
          executionScope: scopedRequest.executionScope,
          effectBinding,
        });
        const persistedIntent = await persistClaimedToolEffectIntentV2({
          recordId: executionRecord.id,
          tenantId: scopedRequest.executionScope.tenantId,
          claimToken: activeExecutionClaimToken,
          intent: providerEffectIntent,
          executionScope: scopedRequest.executionScope,
        });
        if (!persistedIntent) throw new ExecutionClaimLostError();
        executionRecord = persistedIntent;
      } catch (error) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
    }
    if (
      checkpointBeforeEffect &&
      executionRecord &&
      scopedRequest.executionScope
    ) {
      await checkpointBeforeEffect({
        record: executionRecord,
        tool,
        operationClass: governedToolOperationClass(tool, preparedInput),
        executionScope: scopedRequest.executionScope,
      });
    }
    let result: unknown;
    try {
      result = await runTool(
        tool,
        preparedInput,
        toolRuntimeContext,
        executionRecord?.id || idempotencyKey,
        abortSignal,
        mcpSessionScope,
        scopedRequest.binding?.executionScope || executionScope,
        effectContext?.targetId || providerEffectIntent?.targetId,
        executionRecord?.createdAt,
      );
    } catch (error) {
      if (effectContext || providerEffectIntent) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
    let effectReceipt: ToolExecutionRecord["effectReceipt"];
    try {
      effectReceipt = effectContext
        ? await buildMemoryWriteEffectReceipt({
            result,
            context: effectContext,
          })
        : providerEffectIntent
          ? finalizeProviderEffectIntent(tool, providerEffectIntent, result)
          : undefined;
    } catch (error) {
      throw new EffectReceiptFinalizationError({ cause: error });
    }
    const safeResult = redactSensitive(withoutEffectCommitMetadata(result));
    const record = createRecord({
      ...baseRecord,
      status: "executed" as const,
      output: safeResult,
      approvalDecision: executionRecord?.approvalDecision ||
        (decision.approvalRequired ? "approved" as const : undefined),
      approvedBy: executionRecord?.approvedBy ||
        (decision.approvalRequired ? context?.actorId : undefined),
      approvedAt: executionRecord?.approvedAt ||
        (decision.approvalRequired ? new Date().toISOString() : undefined),
      approvalReason: executionRecord?.approvalReason ?? approvalReason,
      effectReceipt,
      completedAt: new Date().toISOString(),
    });
    let saved: ToolExecutionRecord;
    try {
      saved = await persistRecord(record);
    } catch (error) {
      if (tool.id === "memory.forget") {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
    if (tool.category === "mcp") {
      const frameExecutionScope = scopedRequest.executionScope ||
        (toolRuntimeContext
          ? executionScopeFromSecurityContext(toolRuntimeContext, {
              executingPrincipalType: "system",
              executingPrincipalId: "browser-frame-recorder",
              correlationId: saved.id,
              causationId: saved.id,
              purpose: "browser.frame.capture.legacy",
            })
          : undefined);
      if (frameExecutionScope) {
        await captureBrowserFrameAfterToolSafely({
          toolId: tool.id,
          toolInput: preparedInput,
          toolResult: safeResult,
          executionId: saved.id,
          executionScope: frameExecutionScope,
          context: toolRuntimeContext,
          sessionScope: mcpSessionScope,
          abortSignal,
        });
      }
    }
    if (autonomyApproved) {
      await recordRuntimeEventSafely({
        level: "warn",
        category: "security",
        action: "autonomy.auto_approved",
        tenantId: scopedRequest.executionScope?.tenantId || context?.tenantId,
        actorId:
          scopedRequest.executionScope?.initiatingActorId || context?.actorId,
        resourceType: "tool_execution",
        resourceId: saved.id,
        message: `${tool.name} executed on earned autonomy without a fresh human approval.`,
        metadata: {
          toolId: tool.id,
          toolName: tool.name,
          riskLevel: tool.riskLevel,
          autonomyReason: autonomy?.reason,
          cleanStreak: autonomy?.cleanStreak,
        },
        correlationId: scopedRequest.executionScope?.correlationId,
      });
    }
    await recordTrustOutcomeSafely(
      tool,
      toolRuntimeContext,
      "success",
      effectiveApproved,
    );
    return { record: saved, result: safeResult };
  } catch (error) {
    if (
      error instanceof ExecutionClaimLostError ||
      error instanceof EffectReceiptFinalizationError
    ) {
      throw error;
    }
    const message = String(
      redactSensitive(error instanceof Error ? error.message : "Tool execution failed."),
    );
    if (tool.category === "mcp" || tool.category === "openapi") {
      await recordRuntimeEventSafely({
        level: "error",
        category: "connector",
        action: tool.category === "mcp" ? "connector.mcp.tool_failed" : "connector.openapi.tool_failed",
        tenantId: scopedRequest.executionScope?.tenantId || context?.tenantId,
        actorId:
          scopedRequest.executionScope?.initiatingActorId || context?.actorId,
        resourceType: "tool",
        resourceId: tool.id,
        message,
        metadata: {
          failureType: "connector_failure",
          toolName: tool.name,
          toolCategory: tool.category,
          riskLevel: tool.riskLevel,
        },
        correlationId: scopedRequest.executionScope?.correlationId,
      });
    }
    const record = createRecord({
      ...baseRecord,
      status: "failed" as const,
      output: { error: message },
      reason: message,
      completedAt: new Date().toISOString(),
    });
    const saved = await persistRecord(record);
    await recordTrustOutcomeSafely(
      tool,
      toolRuntimeContext,
      "failure",
      effectiveApproved,
    );
    return { record: saved, result: null };
  }
}

type ResolvedToolExecutionScope = Readonly<{
  executionScope?: ExecutionScope;
  requesterRole?: SecurityContext["role"];
  binding?: ToolExecutionScopeBinding;
}>;

function assertRequestedToolExecutionScope(
  executionScope: ExecutionScope | undefined,
  context: SecurityContext | undefined,
  existingRecord: ToolExecutionRecord | undefined,
  executionClaimToken: string | undefined,
) {
  if (!executionScope) return;
  if (!context) {
    throw new ToolExecutionScopeBindingError(
      "Scoped governed tool execution requires an authorized security context.",
    );
  }
  try {
    assertExecutionScopeTenant(executionScope, normalizeTenantId(context.tenantId));
  } catch {
    throw new ToolExecutionScopeBindingError(
      "Governed tool execution scope does not match the authorized tenant.",
    );
  }
  const isClaimedApproval = Boolean(
    existingRecord?.status === "executing" && executionClaimToken,
  );
  if (
    executionScope.initiatingActorId &&
    executionScope.initiatingActorId !== context.actorId &&
    !isClaimedApproval
  ) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool execution scope does not match the authorized actor.",
    );
  }
  if (
    executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId !== context.actorId &&
    !isClaimedApproval
  ) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool user principal does not match the authorized actor.",
    );
  }
}

async function resolveToolExecutionScopeRequest(input: {
  record?: ToolExecutionRecord;
  toolInput: Record<string, unknown>;
  requestedScope?: ExecutionScope;
  context?: SecurityContext;
  executionClaimToken?: string;
  mcpSessionScope?: McpSessionScope;
}): Promise<ResolvedToolExecutionScope> {
  if (
    input.record?.tenantId &&
    input.context?.tenantId &&
    normalizeTenantId(input.record.tenantId) !==
      normalizeTenantId(input.context.tenantId)
  ) {
    throw new ToolExecutionScopeBindingError(
      "Governed tool receipt does not belong to the authorized tenant.",
    );
  }

  const binding = input.record
    ? await getToolExecutionScopeBinding(input.record.id, {
        tenantId: input.record.tenantId || input.context?.tenantId,
      })
    : undefined;
  if (binding && input.record) {
    assertToolExecutionBindingMatchesRequest({
      binding,
      record: input.record,
      toolInput: input.toolInput,
      requestedScope: input.requestedScope,
    });
    if (
      !input.requestedScope &&
      !(
        input.record.status === "executing" &&
        Boolean(input.executionClaimToken)
      )
    ) {
      throw new ToolExecutionScopeBindingError(
        "A scoped governed tool receipt cannot be reused by an unscoped request.",
      );
    }
    assertMcpSessionMatchesToolScope(
      input.mcpSessionScope,
      binding.executionScope,
      input.record,
    );
    return {
      executionScope: binding.executionScope,
      requesterRole: binding.requesterRole,
      binding,
    };
  }

  if (input.record && input.requestedScope) {
    throw new ToolExecutionScopeBindingError(
      "A legacy governed tool receipt cannot be rebound during execution.",
    );
  }
  if (input.requestedScope) {
    assertMcpSessionMatchesToolScope(
      input.mcpSessionScope,
      input.requestedScope,
      input.record,
    );
  }
  return {
    executionScope: input.requestedScope,
    requesterRole: input.requestedScope ? input.context?.role : undefined,
  };
}

async function assertExistingScopedToolReceipt(input: {
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  toolInput: Record<string, unknown>;
  requestedScope?: ExecutionScope;
  context?: SecurityContext;
  mcpSessionScope?: McpSessionScope;
  effectBinding?: GovernedToolEffectBinding;
  idempotencyKey?: string;
}) {
  if (input.record.toolId !== input.tool.id) {
    throw new ToolExecutionScopeBindingError(
      "Idempotent tool execution belongs to a different governed tool.",
    );
  }
  const resolved = await resolveToolExecutionScopeRequest({
    ...input,
    executionClaimToken: undefined,
  });
  const hasEffectReceipt = input.record.effectReceipt !== undefined;
  const providerMaterial = prepareProviderEffectMaterial(
    input.tool,
    input.toolInput,
    input.record.id,
  );
  if (providerMaterial) {
    if (!resolved.executionScope) {
      throw new Error("Provider effect receipt is missing its execution scope.");
    }
    const intent = getToolExecutionEffectIntentV2(input.record);
    if (!intent) {
      throw new Error("Provider effect intent is missing.");
    }
    const expected = buildProviderEffectIntent({
      record: input.record,
      tool: input.tool,
      material: providerMaterial,
      executionScope: resolved.executionScope,
      effectBinding: input.effectBinding,
    });
    if (intent.effectIntentSha256 !== expected.effectIntentSha256) {
      throw new Error(
        "Provider effect intent does not match its reviewed execution binding.",
      );
    }
    if (input.record.status === "executing" && !hasEffectReceipt) return;
    if (
      input.record.status === "executed" &&
      input.record.effectReceipt?.schemaVersion === 2 &&
      input.record.effectReceipt.executionId === intent.executionId &&
      input.record.effectReceipt.inputSha256 === intent.inputSha256 &&
      input.record.effectReceipt.targetId === intent.targetId &&
      input.record.effectReceipt.expectedTargetStateSha256 === intent.expectedTargetStateSha256
    ) return;
    throw new Error("Provider effect is not in a reconcilable state.");
  }
  if (!input.effectBinding) {
    if (hasEffectReceipt) {
      throw new Error(
        "A tool execution carries an effect receipt without a supported effect binding.",
      );
    }
    return;
  }
  if (input.record.status === "executed" && !input.record.dryRun) {
    assertCompletedMemoryWriteEffectReceipt({
      record: input.record,
      effectBinding: input.effectBinding,
      executionScope: resolved.executionScope,
      idempotencyKey: input.idempotencyKey,
    });
    return;
  }
  const effectContext = prepareMemoryWriteEffectContext({
    tool: input.tool,
    preparedInput: input.toolInput,
    effectBinding: input.effectBinding,
    executionScope: resolved.executionScope,
    executionId: input.record.id,
    idempotencyKey: input.idempotencyKey,
  });
  if (!effectContext) {
    throw new Error("The workflow effect binding could not be reconstructed.");
  }
  if (input.record.status === "executing" && !input.record.dryRun) {
    assertPreparedEffectIntent(input.record, effectContext);
  } else if (hasEffectReceipt) {
    throw new Error(
      "Only a completed live workflow memory effect may carry a receipt.",
    );
  } else {
    throw new Error(
      "A governed memory effect intent cannot become terminal without its receipt.",
    );
  }
}

function assertCompletedMemoryWriteEffectReceipt(input: {
  record: ToolExecutionRecord;
  effectBinding: GovernedToolEffectBinding;
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}) {
  const scope = input.executionScope;
  const rawIdempotencyKey = input.idempotencyKey?.trim();
  if (
    input.record.status !== "executed" ||
    input.record.dryRun ||
    input.record.toolId !== "memory.write" ||
    input.record.effectReceipt === undefined ||
    !scope ||
    !scope.initiatingActorId ||
    !rawIdempotencyKey
  ) {
    throw new Error(
      "A completed workflow memory effect requires its receipt, scope, actor, and idempotency binding.",
    );
  }
  const binding = {
    workflowRunId: requiredEffectId(
      input.effectBinding.workflowRunId,
      "workflowRunId",
    ),
    planId: requiredEffectId(input.effectBinding.planId, "planId"),
    planSha256: requiredEffectSha256(
      input.effectBinding.planSha256,
      "planSha256",
    ),
    planNodeId: requiredEffectId(
      input.effectBinding.planNodeId,
      "planNodeId",
    ),
  } satisfies GovernedToolEffectBinding;
  const expectedPrincipalId = `workflow:${binding.workflowRunId}`;
  const expectedCausationId = `workflow.tool:${createHash("sha256")
    .update([
      binding.workflowRunId,
      binding.planId,
      binding.planNodeId,
      "memory.write",
    ].join("\0"))
    .digest("hex")}`;
  if (
    !input.record.tenantId?.trim() ||
    input.record.tenantId !== scope.tenantId ||
    input.record.actorId !== scope.initiatingActorId ||
    scope.executingPrincipalType !== "system" ||
    scope.executingPrincipalId !== expectedPrincipalId ||
    scope.causationId !== expectedCausationId
  ) {
    throw new Error(
      "The completed workflow effect does not match its governed execution scope.",
    );
  }
  const inputSha256 = toolInputSha256(input.record.input);
  const idempotencyDigest = idempotencyKeySha256({
    tenantId: scope.tenantId,
    idempotencyKey: rawIdempotencyKey,
  });
  const targetId = memoryEffectTargetIdV1({
    tenantId: scope.tenantId,
    executionId: input.record.id,
    workflowRunId: binding.workflowRunId,
    planId: binding.planId,
    planSha256: binding.planSha256,
    planNodeId: binding.planNodeId,
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
  });
  const receipt = parseEffectReceiptV1(input.record.effectReceipt, {
    executionId: input.record.id,
    tenantId: scope.tenantId,
    actorId: scope.initiatingActorId,
    executingPrincipalType: "system",
    executingPrincipalId: expectedPrincipalId,
    workflowRunId: binding.workflowRunId,
    planId: binding.planId,
    planSha256: binding.planSha256,
    planNodeId: binding.planNodeId,
    toolId: "memory.write",
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
    targetType: "memory",
    targetId,
  });
  if (!receipt) {
    throw new Error("The completed workflow effect receipt is missing.");
  }
}

async function reconcileExistingMemoryWriteEffect(input: {
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  preparedInput: Record<string, unknown>;
  effectBinding?: GovernedToolEffectBinding;
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
}): Promise<ToolExecutionRecord | undefined> {
  if (
    input.record.status !== "executing" ||
    input.tool.id !== "memory.write" ||
    !input.effectBinding ||
    !input.executionScope ||
    !input.idempotencyKey
  ) {
    return undefined;
  }
  const claimToken = executionClaimTokenFromRecord(input.record);
  if (!claimToken) return undefined;
  const effectContext = prepareMemoryWriteEffectContext({
    tool: input.tool,
    preparedInput: input.preparedInput,
    effectBinding: input.effectBinding,
    executionScope: input.executionScope,
    executionId: input.record.id,
    idempotencyKey: input.idempotencyKey,
  });
  if (!effectContext) return undefined;
  let observed: MemoryRecord | null;
  try {
    observed = await getMemory(effectContext.targetId, {
      tenantId: effectContext.executionScope.tenantId,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (!observed || !memoryWasCreatedForExecution(observed, input.record)) {
    return undefined;
  }
  if (
    canonicalJsonSha256(memoryEffectTargetState(observed)) !==
    effectContext.expectedTargetStateSha256
  ) {
    throw new EffectReceiptFinalizationError({
      cause: new Error(
        "The committed memory target does not match its governed effect intent.",
      ),
    });
  }
  const result = { record: stripEmbedding(observed) };
  let effectReceipt: EffectReceiptV1;
  try {
    effectReceipt = await buildMemoryWriteEffectReceipt({
      result,
      context: effectContext,
      acceptExistingCommitAcknowledgement: true,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  const terminalRecord: ToolExecutionRecord = {
    ...input.record,
    status: "executed",
    output: redactSensitive(result),
    effectReceipt,
    completedAt: new Date().toISOString(),
  };
  let saved: ToolExecutionRecord | undefined;
  try {
    saved = await completeClaimedToolExecution(
      terminalRecord,
      claimToken,
      { executionScope: input.executionScope },
    );
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (saved) return saved;

  let current: ToolExecutionRecord | undefined;
  try {
    current = await getToolExecution(input.record.id, {
      tenantId: effectContext.executionScope.tenantId,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (current?.status !== "executed" || !current.effectReceipt) {
    return undefined;
  }
  try {
    parseEffectReceiptV1(current.effectReceipt, {
      executionId: effectContext.executionId,
      tenantId: effectContext.executionScope.tenantId,
      actorId: effectContext.executionScope.initiatingActorId,
      executingPrincipalType:
        effectContext.executionScope.executingPrincipalType,
      executingPrincipalId: effectContext.executionScope.executingPrincipalId,
      workflowRunId: effectContext.binding.workflowRunId,
      planId: effectContext.binding.planId,
      planSha256: effectContext.binding.planSha256,
      planNodeId: effectContext.binding.planNodeId,
      toolId: "memory.write",
      inputSha256: effectContext.inputSha256,
      idempotencyKeySha256: effectContext.idempotencyKeySha256,
      targetType: "memory",
      targetId: effectContext.targetId,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  return current;
}

async function reconcileExistingGoogleCalendarEffect(input: {
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  preparedInput: Record<string, unknown>;
  effectBinding?: GovernedToolEffectBinding;
  executionScope?: ExecutionScope;
  abortSignal?: AbortSignal;
}): Promise<ToolExecutionRecord | undefined> {
  if (
    input.record.status !== "executing" ||
    input.tool.id !== "calendar.create" ||
    !input.executionScope?.initiatingActorId
  ) return undefined;
  const claimToken = executionClaimTokenFromRecord(input.record);
  if (!claimToken) return undefined;
  let intent: EffectIntentV2;
  try {
    intent = getToolExecutionEffectIntentV2(input.record) as EffectIntentV2;
    const material = prepareProviderEffectMaterial(
      input.tool,
      input.preparedInput,
      input.record.id,
    );
    if (!material) return undefined;
    const expected = buildProviderEffectIntent({
      record: input.record,
      tool: input.tool,
      material,
      executionScope: input.executionScope,
      effectBinding: input.effectBinding,
    });
    if (intent.effectIntentSha256 !== expected.effectIntentSha256) {
      throw new Error("Calendar reconciliation does not match the persisted effect intent.");
    }
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  let result;
  try {
    result = await reconcileGoogleCalendarEvent(input.preparedInput, {
      tenantId: input.executionScope.tenantId,
      actorId: input.executionScope.initiatingActorId,
      executionId: input.record.id,
      abortSignal: input.abortSignal,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (!result) return undefined;
  let effectReceipt: ToolExecutionRecord["effectReceipt"];
  try {
    effectReceipt = finalizeProviderEffectIntent(input.tool, intent, result);
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  const terminalRecord: ToolExecutionRecord = {
    ...input.record,
    status: "executed",
    output: redactSensitive(result),
    effectReceipt,
    completedAt: new Date().toISOString(),
  };
  try {
    const saved = await completeClaimedToolExecution(
      terminalRecord,
      claimToken,
      { executionScope: input.executionScope },
    );
    if (saved) return saved;
    const current = await getToolExecution(input.record.id, {
      tenantId: input.executionScope.tenantId,
    });
    return current?.status === "executed" && current.effectReceipt
      ? current
      : undefined;
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
}

async function reconcileExistingMemoryForgetEffect(input: {
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  preparedInput: Record<string, unknown>;
  executionScope?: ExecutionScope;
}): Promise<ToolExecutionRecord | undefined> {
  if (
    input.record.status !== "executing" ||
    input.tool.id !== "memory.forget" ||
    !input.executionScope?.initiatingActorId
  ) {
    return undefined;
  }
  const claimToken = executionClaimTokenFromRecord(input.record);
  if (!claimToken) return undefined;
  const { id } = memoryForgetSchema.parse(input.preparedInput);

  let receipt: MemoryDeletionReceiptV1 | null = null;
  let memory: MemoryRecord | null = null;
  try {
    receipt = await getMemoryDeletionReceipt(id, {
      tenantId: input.executionScope.tenantId,
    });
    if (!receipt) return undefined;
    memory = await getMemory(id, { tenantId: input.executionScope.tenantId });
    if (!memory) {
      throw new Error(
        "Memory deletion receipt is missing its canonical forgotten shell.",
      );
    }
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (!receipt || !memory) return undefined;

  const deletionDisposition =
    receipt.attributionKind === "scope_bound" &&
      receipt.executionScope &&
      executionScopesEqual(receipt.executionScope, input.executionScope)
      ? "committed" as const
      : "already_deleted" as const;

  const result = {
    forgotten: true,
    id,
    record: stripEmbedding(memory),
    deletionGuarantee: receipt.attributionKind === "scope_bound"
      ? "scope_bound_receipt"
      : "legacy_unattributed_receipt",
    deletionDisposition,
    deletionReceipt: publicMemoryDeletionReceiptV1(receipt),
  };
  const terminalRecord: ToolExecutionRecord = {
    ...input.record,
    status: "executed",
    output: redactSensitive(result),
    completedAt: new Date().toISOString(),
  };

  let saved: ToolExecutionRecord | undefined;
  try {
    saved = await completeClaimedToolExecution(terminalRecord, claimToken, {
      executionScope: input.executionScope,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (saved) return saved;

  let current: ToolExecutionRecord | undefined;
  try {
    current = await getToolExecution(input.record.id, {
      tenantId: input.executionScope.tenantId,
    });
  } catch (error) {
    throw new EffectReceiptFinalizationError({ cause: error });
  }
  if (
    current?.status !== "executed" ||
    !toolOutputHasMemoryDeletionReceipt(current.output, receipt.id)
  ) {
    return undefined;
  }
  return current;
}

function toolOutputHasMemoryDeletionReceipt(
  output: unknown,
  receiptId: string,
) {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return false;
  }
  const deletionReceipt = (output as Record<string, unknown>).deletionReceipt;
  return Boolean(
    deletionReceipt &&
    typeof deletionReceipt === "object" &&
    !Array.isArray(deletionReceipt) &&
    (deletionReceipt as Record<string, unknown>).id === receiptId,
  );
}

function asObjectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function executionClaimTokenFromRecord(record: ToolExecutionRecord) {
  if (!record.output || typeof record.output !== "object" || Array.isArray(record.output)) {
    return undefined;
  }
  const claim = (record.output as Record<string, unknown>).__executionClaim;
  if (!claim || typeof claim !== "object" || Array.isArray(claim)) {
    return undefined;
  }
  const token = (claim as Record<string, unknown>).token;
  return typeof token === "string" && token.trim() ? token : undefined;
}

function memoryWasCreatedForExecution(
  memory: MemoryRecord,
  execution: ToolExecutionRecord,
) {
  const memoryCreatedAt = Date.parse(memory.createdAt);
  const executionCreatedAt = Date.parse(execution.createdAt);
  return Number.isFinite(memoryCreatedAt) &&
    Number.isFinite(executionCreatedAt) &&
    memoryCreatedAt >= executionCreatedAt;
}

async function bindToolScopeIfPresent(input: {
  record: ToolExecutionRecord;
  toolInput: Record<string, unknown>;
  scopedRequest: ResolvedToolExecutionScope;
}) {
  if (
    !input.scopedRequest.executionScope ||
    !input.scopedRequest.requesterRole
  ) {
    return;
  }
  await bindToolExecutionScope({
    record: input.record,
    toolInput: input.toolInput,
    executionScope: input.scopedRequest.executionScope,
    requesterRole: input.scopedRequest.requesterRole,
  });
}

function scopedToolRuntimeContext(
  context: SecurityContext | undefined,
  record: ToolExecutionRecord | undefined,
  scopedRequest: ResolvedToolExecutionScope,
): SecurityContext | undefined {
  if (!scopedRequest.binding || !context) return context;
  return {
    ...context,
    tenantId: scopedRequest.binding.executionScope.tenantId,
    actorId:
      scopedRequest.binding.executionScope.initiatingActorId ||
      record?.actorId ||
      context.actorId,
    role: scopedRequest.binding.requesterRole,
  };
}

function assertMcpSessionMatchesToolScope(
  mcpSessionScope: McpSessionScope | undefined,
  executionScope: ExecutionScope,
  record: ToolExecutionRecord | undefined,
) {
  if (!mcpSessionScope) return;
  if (
    normalizeTenantId(mcpSessionScope.tenantId) !== executionScope.tenantId
  ) {
    throw new ToolExecutionScopeBindingError(
      "MCP session tenant does not match the governed tool execution scope.",
    );
  }
  const requesterId = executionScope.initiatingActorId || record?.actorId;
  if (requesterId && mcpSessionScope.actorId !== requesterId) {
    throw new ToolExecutionScopeBindingError(
      "MCP session actor does not match the governed tool requester.",
    );
  }
}

/**
 * Record a trust outcome for gateable tools only (the ones where autonomy can
 * ever matter). Never throws — trust accounting must not break execution.
 */
async function recordTrustOutcomeSafely(
  tool: ToolDefinition,
  context: SecurityContext | undefined,
  kind: "success" | "failure",
  humanApproved: boolean,
) {
  if (!tool.approvalRequired && tool.riskLevel < 2) {
    return;
  }
  try {
    await recordActionOutcome({
      actionClass: actionClassFor(tool.id),
      toolId: tool.id,
      tenantId: normalizeTenantId(context?.tenantId),
      kind,
      reversible: tool.reversible ?? false,
      riskLevel: tool.riskLevel,
      humanApproved,
    });
  } catch (error) {
    console.warn("Trust outcome write failed.", error instanceof Error ? error.message : error);
  }
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim() || "default";
}

function idempotentToolExecutionId(
  tenantId: string,
  idempotencyKey: string,
) {
  return `idem_${createHash("sha256")
    .update(`${tenantId}\u0000${idempotencyKey}`)
    .digest("hex")}`;
}

function dryRunTool(tool: ToolDefinition, input: Record<string, unknown>) {
  const parsed = parseInput(tool, input);
  return {
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: tool.riskLevel,
    wouldExecute: tool.status === "active",
    sideEffects: describeSideEffects(tool.id),
    normalizedInput: parsed,
  };
}

type PreparedMemoryWriteEffectContext = Readonly<{
  executionScope: ExecutionScope & {
    initiatingActorId: string;
    executingPrincipalType: "system";
    executingPrincipalId: string;
  };
  binding: GovernedToolEffectBinding;
  executionId: string;
  expectedTargetStateSha256: string;
  idempotencyKeySha256: string;
  inputSha256: string;
  toolContractSha256: string;
  targetId: string;
}>;

function prepareMemoryWriteEffectContext(input: {
  tool: ToolDefinition;
  preparedInput: Record<string, unknown>;
  effectBinding?: GovernedToolEffectBinding;
  executionScope?: ExecutionScope;
  executionId?: string;
  idempotencyKey?: string;
}): PreparedMemoryWriteEffectContext | undefined {
  if (!input.effectBinding) return undefined;
  if (input.tool.id !== "memory.write") {
    if (
      input.tool.id === "calendar.create" ||
      input.tool.id === "http.request" ||
      input.tool.category === "mcp" ||
      input.tool.category === "openapi"
    ) return undefined;
    throw new Error("This effect-receipt version supports memory.write only.");
  }
  if (input.tool.reversible !== true) {
    throw new Error("The memory-write effect contract must remain reversible.");
  }
  const scope = input.executionScope;
  const executionId = input.executionId?.trim();
  const rawIdempotencyKey = input.idempotencyKey?.trim();
  if (
    !scope ||
    !scope.initiatingActorId ||
    !scope.executingPrincipalId ||
    !executionId ||
    !rawIdempotencyKey
  ) {
    throw new Error(
      "A workflow memory-write effect requires scope, principals, execution identity, and idempotency.",
    );
  }
  const binding = {
    workflowRunId: requiredEffectId(
      input.effectBinding.workflowRunId,
      "workflowRunId",
    ),
    planId: requiredEffectId(input.effectBinding.planId, "planId"),
    planSha256: requiredEffectSha256(
      input.effectBinding.planSha256,
      "planSha256",
    ),
    planNodeId: requiredEffectId(
      input.effectBinding.planNodeId,
      "planNodeId",
    ),
  } satisfies GovernedToolEffectBinding;
  const expectedPrincipalId = `workflow:${binding.workflowRunId}`;
  const expectedCausationId = `workflow.tool:${createHash("sha256")
    .update([
      binding.workflowRunId,
      binding.planId,
      binding.planNodeId,
      input.tool.id,
    ].join("\0"))
    .digest("hex")}`;
  if (
    scope.executingPrincipalType !== "system" ||
    scope.executingPrincipalId !== expectedPrincipalId ||
    scope.causationId !== expectedCausationId
  ) {
    throw new Error(
      "Workflow effect binding does not match the governed execution scope.",
    );
  }
  const safeMemoryInput = redactSensitive(
    memoryWriteSchema.parse(input.preparedInput),
  ) as z.infer<typeof memoryWriteSchema>;
  const inputSha256 = toolInputSha256(safeMemoryInput);
  const idempotencyDigest = idempotencyKeySha256({
    tenantId: scope.tenantId,
    idempotencyKey: rawIdempotencyKey,
  });
  const targetId = memoryEffectTargetIdV1({
    tenantId: scope.tenantId,
    executionId,
    workflowRunId: binding.workflowRunId,
    planId: binding.planId,
    planSha256: binding.planSha256,
    planNodeId: binding.planNodeId,
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
  });
  const expectedTargetStateSha256 = canonicalJsonSha256(
    intendedMemoryEffectTargetState({
      targetId,
      tenantId: scope.tenantId,
      input: safeMemoryInput,
    }),
  );
  return {
    executionScope: scope as PreparedMemoryWriteEffectContext["executionScope"],
    binding,
    executionId,
    expectedTargetStateSha256,
    idempotencyKeySha256: idempotencyDigest,
    inputSha256,
    toolContractSha256: canonicalJsonSha256({
      approvalFingerprint: toolApprovalFingerprint(input.tool),
    }),
    targetId,
  };
}

function assertPreparedEffectIntent(
  record: ToolExecutionRecord,
  context: PreparedMemoryWriteEffectContext,
) {
  const output = record.output &&
    typeof record.output === "object" &&
    !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : {};
  if (
    record.id !== context.executionId ||
    record.status !== "executing" ||
    record.dryRun ||
    record.toolId !== "memory.write" ||
    normalizeTenantId(record.tenantId) !== context.executionScope.tenantId ||
    record.actorId !== context.executionScope.initiatingActorId ||
    toolInputSha256(record.input) !== context.inputSha256 ||
    output.__effectIdempotencyKeySha256 !== context.idempotencyKeySha256 ||
    output.__effectInputSha256 !== context.inputSha256 ||
    output.__effectPlanSha256 !== context.binding.planSha256 ||
    output.__effectTargetId !== context.targetId ||
    output.__effectToolContractSha256 !== context.toolContractSha256
  ) {
    throw new Error(
      "The governed memory effect does not match its persisted execution intent.",
    );
  }
}

async function buildMemoryWriteEffectReceipt(input: {
  result: unknown;
  context: PreparedMemoryWriteEffectContext;
  acceptExistingCommitAcknowledgement?: boolean;
}): Promise<EffectReceiptV1> {
  const created = memoryRecordFromToolResult(input.result);
  if (!created || created.id !== input.context.targetId) {
    throw new Error(
      "The memory store did not acknowledge the deterministic effect target.",
    );
  }
  if (
    !input.acceptExistingCommitAcknowledgement &&
    !memoryEffectCommitInserted(input.result)
  ) {
    throw new Error(
      "The deterministic memory target already existed, so a new commit was not acknowledged.",
    );
  }
  const committedTargetStateSha256 = canonicalJsonSha256(
    memoryEffectTargetState(created),
  );
  const expectedTargetStateSha256 = input.context.expectedTargetStateSha256;
  let verificationState: EffectReceiptV1["verificationState"] = "unverifiable";
  let verificationReasonCode: EffectReceiptV1["verificationReasonCode"] =
    "read_unavailable";
  let observedTargetStateSha256: string | null = null;
  try {
    const observed = await getMemory(input.context.targetId, {
      tenantId: input.context.executionScope.tenantId,
    });
    if (!observed) {
      verificationState = "failed";
      verificationReasonCode = "target_missing";
    } else {
      observedTargetStateSha256 = canonicalJsonSha256(
        memoryEffectTargetState(observed),
      );
      if (observedTargetStateSha256 === expectedTargetStateSha256) {
        verificationState = "verified";
        verificationReasonCode = "state_matched";
      } else {
        verificationState = "failed";
        verificationReasonCode = "state_mismatch";
      }
    }
  } catch {
    verificationState = "unverifiable";
    verificationReasonCode = "read_failed";
    observedTargetStateSha256 = null;
  }
  const scope = input.context.executionScope;
  return buildEffectReceiptV1({
    effectMode: "live",
    reversible: true,
    executionId: input.context.executionId,
    tenantId: scope.tenantId,
    actorId: scope.initiatingActorId,
    executingPrincipalType: scope.executingPrincipalType,
    executingPrincipalId: scope.executingPrincipalId,
    workflowRunId: input.context.binding.workflowRunId,
    planId: input.context.binding.planId,
    planSha256: input.context.binding.planSha256,
    planNodeId: input.context.binding.planNodeId,
    toolId: "memory.write",
    toolContractSha256: input.context.toolContractSha256,
    inputSha256: input.context.inputSha256,
    idempotencyKeySha256: input.context.idempotencyKeySha256,
    targetType: "memory",
    targetId: input.context.targetId,
    providerAcknowledgement: "first_party_store_commit",
    providerAcknowledgementId: input.context.targetId,
    providerAcknowledgementSha256: canonicalJsonSha256({
      provider: "first_party_memory_store",
      targetId: input.context.targetId,
      committedTargetStateSha256,
    }),
    verificationMethod: "read_after_write",
    verificationState,
    verificationReasonCode,
    expectedTargetStateSha256,
    observedTargetStateSha256,
  });
}

function memoryEffectCommitInserted(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (result as Record<string, unknown>).__effectCommitInserted === true;
}

function isLegacyExecutionForEffectCanary(record: ToolExecutionRecord) {
  if (record.effectReceipt !== undefined) return false;
  const output = record.output &&
    typeof record.output === "object" &&
    !Array.isArray(record.output)
    ? record.output as Record<string, unknown>
    : {};
  return ![
    "__effectIdempotencyKeySha256",
    "__effectInputSha256",
    "__effectPlanSha256",
    "__effectTargetId",
    "__effectToolContractSha256",
  ].some((key) => Object.hasOwn(output, key));
}

function withoutEffectCommitMetadata(result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return result;
  }
  const {
    __effectCommitInserted: _effectCommitInserted,
    ...publicResult
  } = result as Record<string, unknown>;
  void _effectCommitInserted;
  return publicResult;
}

function memoryRecordFromToolResult(result: unknown): MemoryRecord | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const record = (result as Record<string, unknown>).record;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  return record as MemoryRecord;
}

function memoryEffectTargetState(record: MemoryRecord) {
  return {
    id: record.id,
    tenantId: record.tenantId || "default",
    type: record.type,
    title: record.title,
    content: record.content,
    tags: record.tags,
    scope: record.scope,
    source: record.source,
    importance: record.importance,
    confidence: record.confidence ?? null,
    claimStatus: record.claimStatus ?? null,
    assertedBy: record.assertedBy ?? null,
    evidenceRefs: record.evidenceRefs || [],
    validFrom: record.validFrom ?? null,
    validTo: record.validTo ?? null,
    supersedesId: record.supersedesId ?? null,
    contradictionOfId: record.contradictionOfId ?? null,
  };
}

function intendedMemoryEffectTargetState(input: {
  targetId: string;
  tenantId: string;
  input: z.infer<typeof memoryWriteSchema>;
}) {
  return {
    id: input.targetId,
    tenantId: input.tenantId,
    type: input.input.type || "fact",
    title: input.input.title.slice(0, 240),
    content: input.input.content.slice(0, 200_000),
    tags: normalizeMemoryEffectTags(
      input.input.tags || ["tool-execution"],
    ),
    scope: "workspace",
    source: "tool-executor",
    importance: input.input.importance ?? 0.5,
    confidence: 0.7,
    claimStatus: "active",
    assertedBy: "system",
    evidenceRefs: [],
    validFrom: null,
    validTo: null,
    supersedesId: null,
    contradictionOfId: null,
  };
}

function normalizeMemoryEffectTags(tags: string[]) {
  return Array.from(
    new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean).slice(0, 12)),
  );
}

function requiredEffectId(value: string, field: string) {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(normalized)
  ) {
    throw new Error(`Workflow effect ${field} is not an opaque ID.`);
  }
  return normalized;
}

function requiredEffectSha256(value: string, field: string) {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Workflow effect ${field} is not a SHA-256 digest.`);
  }
  return value;
}

async function runTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context?: SecurityContext,
  idempotencyKey?: string,
  abortSignal?: AbortSignal,
  mcpSessionScope?: McpSessionScope,
  executionScope?: ExecutionScope,
  effectTargetId?: string,
  executionObservedAt?: string,
) {
  const parsed = parseInput(tool, input);
  const aiUsageScope = (
    operation: AiUsageOperation,
    purpose: string,
  ) => toolAiUsageScope(
    context,
    executionScope,
    idempotencyKey,
    operation,
    purpose,
  );

  if (tool.id === "memory.search") {
    const { query, limit } = searchSchema.parse(parsed);
    const safeQuery = String(redactSensitive(query));
    const queryEmbedding = (await embedTexts(
      [safeQuery],
      abortSignal,
      aiUsageScope("embedding", "tool.memory.search"),
    ))?.[0];
    const results = await searchMemories(safeQuery, { limit: limit || 5, queryEmbedding, tenantId: context?.tenantId });
    return {
      results: results.map((result) => ({
        score: result.score,
        reasons: result.reasons,
        record: {
          ...result.record,
          embedding: undefined,
        },
      })),
    };
  }

  if (tool.id === "knowledge.search") {
    const { query, limit } = searchSchema.parse(parsed);
    const safeQuery = String(redactSensitive(query));
    const queryEmbedding = (await embedTexts(
      [safeQuery],
      abortSignal,
      aiUsageScope("embedding", "tool.knowledge.search"),
    ))?.[0];
    const results = await searchKnowledge(safeQuery, { limit: limit || 5, queryEmbedding, tenantId: context?.tenantId });
    return {
      results: results.map((result) => ({
        score: result.score,
        vectorScore: result.vectorScore,
        lexicalScore: result.lexicalScore,
        reasons: result.reasons,
        chunk: {
          ...result.chunk,
          embedding: undefined,
        },
        document: result.document,
      })),
    };
  }

  if (tool.id === "web.search") {
    const { query, limit, searchContextSize, allowedDomains } = webSearchSchema.parse(parsed);
    return runLiveWebSearch({
      query: String(redactSensitive(query)),
      maxSources: limit || 8,
      contextSize: searchContextSize || "medium",
      allowedDomains,
      abortSignal,
      usageScope: aiUsageScope("web_search", "tool.web.search"),
    });
  }

  if (tool.id === "memory.write") {
    const value = memoryWriteSchema.parse(parsed);
    const safeValue = redactSensitive(value) as typeof value;
    const contentForEmbedding = `${safeValue.title}\n\n${safeValue.content}`;
    const embedding = (await embedTexts(
      [contentForEmbedding],
      abortSignal,
      aiUsageScope("embedding", "tool.memory.write"),
    ))?.[0];
    const memoryInput: Parameters<typeof saveMemory>[0] = {
        id: effectTargetId,
        tenantId: context?.tenantId,
        title: safeValue.title,
        content: safeValue.content,
        type: safeValue.type as MemoryType | undefined,
        tags: safeValue.tags || ["tool-execution"],
        importance: safeValue.importance ?? 0.5,
        source: "tool-executor",
        scope: "workspace",
        embedding,
      };
    if (effectTargetId) {
      const committed = await saveMemoryWithCommitStatus(memoryInput);
      return {
        record: stripEmbedding(committed.record),
        __effectCommitInserted: committed.inserted,
      };
    }
    return {
      record: stripEmbedding(await saveMemory(memoryInput)),
    };
  }

  if (tool.id === "memory.correct") {
    const { id, ...correction } = memoryCorrectSchema.parse(parsed);
    const existing = await getMemory(id, { tenantId: context?.tenantId });
    if (!existing || existing.claimStatus === "forgotten") {
      throw new Error("Memory not found.");
    }
    const safeCorrection = redactSensitive(correction) as typeof correction;
    const title = safeCorrection.title ?? existing.title;
    const content = safeCorrection.content ?? existing.content;
    const embedding = (await embedTexts(
      [`${title}\n\n${content}`],
      abortSignal,
      aiUsageScope("embedding", "tool.memory.correct"),
    ))?.[0];
    const result = await correctMemory(
      id,
      { ...safeCorrection, embedding },
      { tenantId: context?.tenantId, actorId: context?.actorId },
    );
    if (!result) {
      throw new Error("Memory not found.");
    }
    await queueMemoryGraphRebuild({ tenantId: context?.tenantId });
    return {
      previous: stripEmbedding(result.previous),
      corrected: stripEmbedding(result.corrected),
    };
  }

  if (tool.id === "memory.forget") {
    const { id } = memoryForgetSchema.parse(parsed);
    if (!executionScope) {
      throw new Error("Governed memory deletion requires an execution scope.");
    }
    if (!executionScope.initiatingActorId) {
      throw new Error(
        "Governed memory deletion requires a non-null initiating actor.",
      );
    }
    let result: Awaited<ReturnType<typeof forgetMemoryWithReceipt>>;
    try {
      result = await forgetMemoryWithReceipt(id, {
        tenantId: executionScope.tenantId,
        executionScope,
      });
    } catch (error) {
      let committedReceipt: MemoryDeletionReceiptV1 | null;
      try {
        committedReceipt = await getMemoryDeletionReceipt(id, {
          tenantId: executionScope.tenantId,
        });
      } catch (receiptLookupError) {
        throw new EffectReceiptFinalizationError({
          cause: receiptLookupError,
        });
      }
      if (committedReceipt) {
        throw new EffectReceiptFinalizationError({ cause: error });
      }
      throw error;
    }
    if (!result) {
      throw new MemoryForgetNotFoundError();
    }
    return {
      forgotten: true,
      id,
      record: stripEmbedding(result.memory),
      deletionGuarantee: result.deletionGuarantee,
      deletionDisposition: result.deletionDisposition,
      deletionReceipt: result.receipt
        ? publicMemoryDeletionReceiptV1(result.receipt)
        : null,
    };
  }

  if (tool.id === "knowledge.ingest") {
    const value = knowledgeIngestSchema.parse(parsed);
    const safeValue = redactSensitive(value) as typeof value;
    const result = await ingestTextDocument({
      tenantId: context?.tenantId,
      title: safeValue.title,
      content: safeValue.content,
      source: safeValue.source || "tool-executor",
      sourceType: "manual",
      tags: safeValue.tags || ["tool-execution"],
      usageScope: aiUsageScope("embedding", "tool.knowledge.ingest"),
      ...(executionScope?.initiatingActorId && executionObservedAt
        ? {
            sourceLineage: {
              executionScope,
              connectionId: "first_party.knowledge_tool",
              adapterId: "asael.knowledge_tool",
              adapterVersionId: "1",
              externalItemId:
                idempotencyKey ||
                effectTargetId ||
                `knowledge_tool_${sourceContractSha256({
                  title: safeValue.title,
                  content: safeValue.content,
                  source: safeValue.source || "tool-executor",
                })}`,
              sourceKind: "document" as const,
              capturedAt: executionObservedAt,
            },
          }
        : {}),
    });
    return {
      document: result.document,
      chunks: result.chunks.length,
      memories: result.memories.length,
    };
  }

  if (tool.id === "missions.list") {
    const { limit = 20, status } = missionsListSchema.parse(parsed);
    const owner = requireMissionToolContext(context);
    const missions = await listMissions(status ? 200 : limit, owner);
    return {
      missions: missions
        .filter((mission) => !status || mission.status === status)
        .slice(0, limit)
        .map(publicMissionSummary),
    };
  }

  if (tool.id === "mission.show") {
    const { missionId } = missionShowSchema.parse(parsed);
    const owner = requireMissionToolContext(context);
    const detail = await getMissionDetail(missionId, owner, {
      tasks: 200,
      attempts: 200,
      artifacts: 200,
    });
    if (!detail) {
      throw new Error("Mission not found.");
    }
    return publicMissionDetail(detail);
  }

  if (tool.id === "mission.task.create") {
    const value = missionTaskCreateSchema.parse(parsed);
    const owner = requireMissionToolContext(context);
    const safeValue = redactSensitive(value) as typeof value;
    const task = await ensureMissionTask(
      safeValue.missionId,
      {
        sourceKey: missionToolSourceKey("task", safeValue.missionId, idempotencyKey),
        title: safeValue.title,
        instructions: safeValue.instructions,
        definitionOfDone: safeValue.definitionOfDone,
        priority: safeValue.priority,
        dependencyIds: safeValue.dependencyIds,
        status: "triage",
        metadata: {
          assigneeKey: safeValue.assigneeKey,
          skillIds: safeValue.skillIds,
          reviewRequired: safeValue.reviewRequired ?? false,
        },
      },
      owner,
    );
    return {
      task: publicMissionTask(task),
      placement: "triage",
    };
  }

  if (tool.id === "mission.task.comment") {
    const value = missionTaskCommentSchema.parse(parsed);
    const owner = requireMissionToolContext(context);
    const task = await getMissionTask(value.taskId, owner);
    if (!task || task.missionId !== value.missionId) {
      throw new Error("Mission task not found.");
    }
    const body = safeMissionText(value.body, 4_000);
    const comment = await appendMissionTaskComment(
      task.id,
      {
        body,
        sourceKey: missionToolSourceKey("comment", task.id, idempotencyKey),
      },
      owner,
    );
    return {
      comment: publicMissionComment(comment),
    };
  }

  if (tool.id === "runs.list") {
    const { limit } = runsListSchema.parse(parsed);
    return {
      runs: (
        await listAgentRuns(limit || 5, { tenantId: context?.tenantId })
      ).map(publicAgentRun),
    };
  }

  if (tool.id === "http.request") {
    return runHttpRequestTool(httpRequestSchema.parse(parsed), {
      idempotencyKey,
      context,
      abortSignal,
    });
  }

  if (tool.id === "calendar.create") {
    if (!context?.tenantId || !context.actorId || !idempotencyKey) {
      throw new Error("Calendar event creation requires tenant, actor, and execution scope.");
    }
    return createGoogleCalendarEvent(
      googleCalendarCreateSchema.parse(parsed),
      {
        tenantId: context.tenantId,
        actorId: context.actorId,
        executionId: idempotencyKey,
        abortSignal,
      },
    );
  }

  if (tool.category === "mcp") {
    const mcpTool = await getMcpToolById(tool.id, { tenantId: context?.tenantId });
    if (!mcpTool) {
      throw new Error(`MCP tool ${tool.id} is not registered.`);
    }

    const connector = await getMcpConnector(mcpTool.connectorId, { tenantId: context?.tenantId });
    if (!connector) {
      throw new Error(`MCP connector ${mcpTool.connectorId} is not registered.`);
    }

    if (connector.status !== "active" || mcpTool.status !== "active") {
      throw new Error("MCP connector or tool is not active.");
    }

    return {
      connector: {
        id: connector.id,
        name: connector.name,
        endpoint: connector.endpoint,
      },
      tool: {
        id: mcpTool.id,
        name: mcpTool.name,
        riskLevel: mcpTool.riskLevel,
      },
      result: await callMcpTool({
        connector,
        toolName: mcpTool.name,
        args: parsed,
        idempotencyKey,
        actorRole: context?.role,
        abortSignal,
        sessionScope: mcpSessionScope || {
          tenantId: normalizeTenantId(context?.tenantId),
          actorId: context?.actorId || "tool-executor",
          executionId: `tool:${idempotencyKey || randomUUID()}`,
        },
      }),
    };
  }

  if (tool.category === "openapi") {
    const operation = await getOpenApiOperationById(tool.id, { tenantId: context?.tenantId });
    if (!operation) {
      throw new Error(`OpenAPI operation ${tool.id} is not registered.`);
    }

    const connector = await getOpenApiConnector(operation.connectorId, { tenantId: context?.tenantId });
    if (!connector) {
      throw new Error(`OpenAPI connector ${operation.connectorId} is not registered.`);
    }

    if (connector.status !== "active" || operation.status !== "active") {
      throw new Error("OpenAPI connector or operation is not active.");
    }

    return {
      connector: {
        id: connector.id,
        name: connector.name,
        baseUrl: connector.baseUrl,
      },
      operation: {
        id: operation.id,
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        riskLevel: operation.riskLevel,
      },
      result: await callOpenApiOperation({
        connector,
        operation,
        input: parsed,
        idempotencyKey,
        actorRole: context?.role,
        abortSignal,
      }),
    };
  }

  throw new Error(`No handler is registered for ${tool.id}.`);
}

function toolAiUsageScope(
  context: SecurityContext | undefined,
  executionScope: ExecutionScope | undefined,
  receiptId: string | undefined,
  operation: AiUsageOperation,
  purpose: string,
): AiUsageScope | undefined {
  const tenantId = context?.tenantId?.trim();
  const actorId = context?.actorId?.trim();
  if (!tenantId || !actorId) return undefined;
  const sourceId = receiptId?.trim() || executionScope?.correlationId || randomUUID();
  return {
    tenantId,
    actorId,
    sourceStreamId: `tool-execution:${sourceId}`,
    operation,
    purpose,
    correlationId: executionScope?.correlationId || sourceId,
    causationId: executionScope?.causationId || undefined,
    executionScope,
    credentialSource: "deployment_environment",
  };
}

async function recordToolPolicyBlock({
  context,
  executionScope,
  toolId,
  toolName,
  reason,
  input,
  riskLevel,
}: {
  context?: SecurityContext;
  executionScope?: ExecutionScope;
  toolId: string;
  toolName?: string;
  reason: string;
  input: Record<string, unknown>;
  riskLevel: number;
}) {
  await recordRuntimeEventSafely({
    level: "warn",
    category: "security",
    action: "security.policy_blocked",
    tenantId: executionScope?.tenantId || context?.tenantId,
    actorId: executionScope?.initiatingActorId || context?.actorId,
    resourceType: "tool",
    resourceId: toolId,
    message: reason,
    metadata: {
      failureType: "policy_block",
      requestedAction: "execute.tool",
      toolName,
      riskLevel,
      input,
    },
    correlationId: executionScope?.correlationId,
  });
}

export function hasRisk3Quorum(record?: ToolExecutionRecord) {
  if (!record?.approvals?.length) {
    return false;
  }
  const distinctAdmins = new Set(
    record.approvals
      .filter((approval) => (approval.role === "admin" || approval.role === "system") && approval.by !== record.actorId)
      .map((approval) => approval.by),
  );
  return distinctAdmins.size >= RISK3_QUORUM;
}

type ProviderEffectMaterial = Readonly<{
  inputSha256: string;
  approvalBindingSha256: string;
  targetType:
    | "http_endpoint"
    | "google_calendar_event"
    | "mcp_operation"
    | "openapi_operation";
  targetId: string;
  targetSha256: string;
  expectedTargetStateSha256: string;
}>;

export function governedToolOperationClass(
  tool: ToolDefinition,
  input: Record<string, unknown>,
): "read_only" | "mutation" {
  if (tool.operationClass) return tool.operationClass;
  if (tool.id === "http.request") {
    const method = httpRequestSchema.parse(input).method || "GET";
    return method === "GET" ? "read_only" : "mutation";
  }
  return tool.riskLevel === 0 ? "read_only" : "mutation";
}

function prepareProviderEffectMaterial(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  executionId?: string,
): ProviderEffectMaterial | undefined {
  if (tool.id === "calendar.create") {
    if (!executionId) return undefined;
    const parsed = googleCalendarCreateSchema.parse(input);
    const eventId = googleCalendarEventId(executionId);
    const inputSha256 = toolInputSha256(parsed);
    const targetSha256 = canonicalJsonSha256({
      targetType: "google_calendar_event",
      calendarId: parsed.calendarId,
      eventId,
    });
    return Object.freeze({
      inputSha256,
      approvalBindingSha256: approvalMaterialBindingSha256({
        targetSha256,
        inputSha256,
      }),
      targetType: "google_calendar_event",
      targetId: `google_calendar_event:${parsed.calendarId}:${eventId}`,
      targetSha256,
      expectedTargetStateSha256: canonicalJsonSha256(
        googleCalendarTargetState(parsed, eventId),
      ),
    });
  }
  if (tool.id === "http.request") {
    const parsed = httpRequestSchema.parse(input);
    const method = parsed.method || "GET";
    if (method === "GET") return undefined;
    const url = new URL(parsed.url).toString();
    return genericProviderEffectMaterial({
      tool,
      input: parsed,
      targetType: "http_endpoint",
      targetIdentity: { method, url },
      targetIdPrefix: "http_target",
    });
  }
  if (
    (tool.category === "mcp" || tool.category === "openapi") &&
    governedToolOperationClass(tool, input) === "mutation"
  ) {
    const targetType = tool.category === "mcp"
      ? "mcp_operation"
      : "openapi_operation";
    return genericProviderEffectMaterial({
      tool,
      input,
      targetType,
      targetIdentity: {
        toolId: tool.id,
        approvalFingerprint: toolApprovalFingerprint(tool),
      },
      targetIdPrefix: tool.category === "mcp"
        ? "mcp_target"
        : "openapi_target",
    });
  }
  return undefined;
}

function genericProviderEffectMaterial(input: {
  tool: ToolDefinition;
  input: Record<string, unknown>;
  targetType: ProviderEffectMaterial["targetType"];
  targetIdentity: Record<string, unknown>;
  targetIdPrefix: string;
}): ProviderEffectMaterial {
  const inputSha256 = toolInputSha256(input.input);
  const targetSha256 = canonicalJsonSha256({
    targetType: input.targetType,
    ...input.targetIdentity,
  });
  return Object.freeze({
    inputSha256,
    approvalBindingSha256: approvalMaterialBindingSha256({
      targetSha256,
      inputSha256,
    }),
    targetType: input.targetType,
    targetId: `${input.targetIdPrefix}_${targetSha256.slice(0, 52)}`,
    targetSha256,
    expectedTargetStateSha256: canonicalJsonSha256({
      expectation: "provider_acknowledged_exact_request",
      targetSha256,
      inputSha256,
    }),
  });
}

function buildProviderEffectIntent(input: {
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  material: ProviderEffectMaterial;
  executionScope: ExecutionScope;
  effectBinding?: GovernedToolEffectBinding;
}) {
  const { record, tool, material, executionScope, effectBinding } = input;
  const isDirectUser = Boolean(
    executionScope.initiatingActorId &&
    executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId === executionScope.initiatingActorId
  );
  const isBoundWorkflow = Boolean(
    effectBinding &&
    executionScope.initiatingActorId &&
    executionScope.executingPrincipalType === "system" &&
    executionScope.executingPrincipalId === `workflow:${effectBinding?.workflowRunId}`
  );
  if (!isDirectUser && !isBoundWorkflow) {
    throw new Error(
      "Provider mutations require a directly authorized user or an exact workflow-plan binding.",
    );
  }
  const actorId = executionScope.initiatingActorId;
  const executingPrincipalId = executionScope.executingPrincipalId;
  if (!actorId || !executingPrincipalId) {
    throw new Error("Provider effects require a non-null initiating actor.");
  }
  return buildEffectIntentV2({
    effectMode: "live",
    reversible: tool.reversible ?? false,
    executionKind: isBoundWorkflow ? "workflow" : "direct",
    executionId: record.id,
    tenantId: executionScope.tenantId,
    actorId,
    executingPrincipalType: executionScope.executingPrincipalType,
    executingPrincipalId,
    workflowRunId: isBoundWorkflow ? effectBinding?.workflowRunId || null : null,
    planId: isBoundWorkflow ? effectBinding?.planId || null : null,
    planSha256: isBoundWorkflow ? effectBinding?.planSha256 || null : null,
    planNodeId: isBoundWorkflow ? effectBinding?.planNodeId || null : null,
    toolId: tool.id,
    toolContractSha256: canonicalJsonSha256({
      approvalFingerprint: toolApprovalFingerprint(tool),
    }),
    approvalState: record.approvalRequired ? "approved" : "not_required",
    approvalBindingSha256: record.approvalRequired
      ? material.approvalBindingSha256
      : null,
    inputSha256: material.inputSha256,
    idempotencyKeySha256: idempotencyKeySha256({
      tenantId: executionScope.tenantId,
      idempotencyKey: record.id,
    }),
    targetType: material.targetType,
    targetId: material.targetId,
    expectedTargetStateSha256: material.expectedTargetStateSha256,
  });
}

function finalizeProviderEffectIntent(
  tool: ToolDefinition,
  intent: EffectIntentV2,
  resultValue: unknown,
) {
  if (tool.id === "calendar.create") {
    const result = z.object({
      calendarId: z.string().min(1),
      eventId: z.string().min(1),
      providerAcknowledgement: z.enum([
        "provider_response",
        "provider_idempotency_reconciliation",
      ]),
      providerAcknowledgementId: z.string().min(1),
      providerAcknowledgementSha256: z.string().regex(/^[a-f0-9]{64}$/),
      observedTargetStateSha256: z.string().regex(/^[a-f0-9]{64}$/),
      htmlLink: z.string().url().optional(),
    }).strict().parse(resultValue);
    return finalizeEffectIntentV2(intent, {
      providerAcknowledgement: result.providerAcknowledgement,
      providerAcknowledgementId: result.providerAcknowledgementId,
      providerAcknowledgementSha256: result.providerAcknowledgementSha256,
      verificationMethod: "read_after_write",
      verificationState: "verified",
      verificationReasonCode: "state_matched",
      observedTargetStateSha256: result.observedTargetStateSha256,
    });
  }
  if (tool.category === "mcp" || tool.category === "openapi") {
    const acknowledgementSha256 = canonicalJsonSha256({
      toolId: tool.id,
      result: resultValue,
    });
    return finalizeEffectIntentV2(intent, {
      providerAcknowledgement: "provider_response",
      providerAcknowledgementId:
        `${tool.category}_ack_${acknowledgementSha256.slice(0, 54)}`,
      providerAcknowledgementSha256: acknowledgementSha256,
      verificationMethod: "read_after_write",
      verificationState: "unverifiable",
      verificationReasonCode: "read_unavailable",
      observedTargetStateSha256: null,
    });
  }
  const result = z.object({
    url: z.string().url(),
    method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
    status: z.number().int().min(100).max(599),
    statusText: z.string(),
    redirected: z.boolean(),
    location: z.string().optional(),
    contentType: z.string().optional(),
    body: z.string(),
  }).strict().parse(resultValue);
  const acknowledgementSha256 = canonicalJsonSha256({
    url: result.url,
    method: result.method,
    status: result.status,
    statusText: result.statusText,
    redirected: result.redirected,
    location: result.location || null,
    contentType: result.contentType || null,
    bodySha256: canonicalJsonSha256(result.body),
  });
  return finalizeEffectIntentV2(intent, {
    providerAcknowledgement: "provider_response",
    providerAcknowledgementId:
      `http_ack_${acknowledgementSha256.slice(0, 55)}`,
    providerAcknowledgementSha256: acknowledgementSha256,
    verificationMethod: "read_after_write",
    verificationState: "unverifiable",
    verificationReasonCode: "read_unavailable",
    observedTargetStateSha256: null,
  });
}

async function validateHttpRequestForApproval(
  input: z.infer<typeof httpRequestSchema>,
  context?: SecurityContext,
) {
  validateHttpRequestHeaders(input);
  const url = await assertPublicHttpUrl(input.url, "Request URL");
  if (input.authEnv) {
    assertConnectorSecretBinding({
      envName: input.authEnv,
      tenantId: context?.tenantId,
      targetUrl: url,
      role: context?.role,
    });
  }
}

async function runHttpRequestTool(
  input: z.infer<typeof httpRequestSchema>,
  options: { idempotencyKey?: string; context?: SecurityContext; abortSignal?: AbortSignal } = {},
) {
  const url = await assertPublicHttpUrl(input.url, "Request URL");

  validateHttpRequestHeaders(input);
  const headers = new Headers();
  let activeSecret: string | undefined;
  for (const [name, value] of Object.entries(input.headers || {})) {
    headers.set(name, value);
  }

  if (input.authEnv) {
    assertConnectorSecretBinding({
      envName: input.authEnv,
      tenantId: options.context?.tenantId,
      targetUrl: url,
      role: options.context?.role,
    });
    const secret = process.env[input.authEnv.trim().toUpperCase()];
    if (!secret) {
      throw new Error(`Env var ${input.authEnv} is not set in this environment.`);
    }
    activeSecret = secret;
    const authHeader = input.authHeader || "authorization";
    const authMode =
      input.authMode || (authHeader === "authorization" ? "bearer" : "raw");
    const authValue =
      authMode === "bearer"
        ? `Bearer ${secret}`
        : authMode === "basic"
          ? `Basic ${Buffer.from(secret, "utf8").toString("base64")}`
          : secret;
    headers.set(authHeader, authValue);
  }

  const method = input.method || "GET";
  if (method !== "GET" && options.idempotencyKey) {
    headers.set("idempotency-key", normalizeIdempotencyKey(options.idempotencyKey));
  }
  if (input.body && Buffer.byteLength(input.body, "utf8") > 100_000) {
    throw new Error("HTTP request body exceeds the 100,000-byte limit.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("HTTP request timed out.")), HTTP_REQUEST_TIMEOUT_MS);
  const signal = options.abortSignal
    ? AbortSignal.any([controller.signal, options.abortSignal])
    : controller.signal;
  try {
    const response = await fetchPublicHttpUrl(url, {
      method,
      headers,
      body: method === "GET" ? undefined : input.body,
      signal,
    }, "Request URL");
    const rawBody = await readResponseTextLimited(response, HTTP_RESPONSE_MAX_BYTES);
    return redactExactSecrets({
      url,
      method,
      status: response.status,
      statusText: response.statusText,
      redirected: response.status >= 300 && response.status < 400,
      location: response.headers.get("location") || undefined,
      contentType: response.headers.get("content-type") || undefined,
      body: rawBody.truncated ? `${rawBody.text}… [truncated]` : rawBody.text,
    }, [activeSecret]);
  } finally {
    clearTimeout(timer);
  }
}

function validateHttpRequestHeaders(input: z.infer<typeof httpRequestSchema>) {
  for (const [name, value] of Object.entries(input.headers || {})) {
    assertSafeHttpToolHeader(name);
    // Secrets must arrive via authEnv so they never sit in the approval or
    // audit ledger as caller-provided header values.
    if (redactSensitive(value) !== value) {
      throw new Error(
        `Header ${name} looks like a pasted secret. Reference it via authEnv instead.`,
      );
    }
  }
}

function assertSafeHttpToolHeader(name: string) {
  const normalized = name.trim().toLowerCase();
  if (
    !normalized ||
    normalized.length > 120 ||
    /[\r\n]/.test(name) ||
    /^(authorization|cookie|host|connection|content-length|transfer-encoding|forwarded|proxy-|sec-|cf-connecting-ip|true-client-ip|x-(?:forwarded-|original-|rewrite-|http-method-override$|method-override$|real-ip$|client-ip$|vercel-))/i.test(normalized) ||
    /(?:api[-_]?key|token|secret)/i.test(normalized)
  ) {
    throw new Error(`HTTP request header is not allowed: ${name}`);
  }
}

function normalizeIdempotencyKey(value: string) {
  const normalized = value.trim().replace(/[\r\n]/g, "").slice(0, 200);
  if (!normalized) {
    throw new Error("Idempotency key must not be empty.");
  }
  return normalized;
}

function assertToolInputSize(input: Record<string, unknown>) {
  let serialized: string;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new ToolInputValidationError("Tool input must be JSON serializable.");
  }
  if (Buffer.byteLength(serialized, "utf8") > 250_000) {
    throw new ToolInputValidationError(
      "Tool input exceeds the 250,000-byte execution limit.",
    );
  }
}

function toolInputValidationError(error: unknown) {
  if (error instanceof ToolInputValidationError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new ToolInputValidationError(
      error.issues[0]?.message || "Tool input did not match the required schema.",
    );
  }
  return new ToolInputValidationError(
    error instanceof Error ? error.message : "Tool input is invalid.",
  );
}

async function completeClaimedInputValidationFailure(
  existingRecord: ToolExecutionRecord,
  executionClaimToken: string,
  error: unknown,
) {
  const validationError = toolInputValidationError(error);
  const record: ToolExecutionRecord = {
    ...existingRecord,
    status: "failed",
    output: {
      error: `Approved tool input could not be validated: ${validationError.message}`,
    },
    reason: `Approved tool input could not be validated: ${validationError.message}`,
    completedAt: new Date().toISOString(),
  };
  const saved = await completeClaimedToolExecution(
    record,
    executionClaimToken,
  );
  if (!saved) {
    throw new ExecutionClaimLostError();
  }
  return { record: saved, result: null };
}

function stripEmbedding<T extends { embedding?: number[] }>(value: T) {
  return {
    ...value,
    embedding: undefined,
  };
}

function requireMissionToolContext(context?: SecurityContext) {
  const tenantId = context?.tenantId?.trim();
  const actorId = context?.actorId?.trim();
  if (!tenantId || !actorId) {
    throw new Error("Mission tools require an authenticated tenant and actor context.");
  }
  return { tenantId, actorId };
}

function missionToolSourceKey(
  kind: "task" | "comment",
  scopeId: string,
  idempotencyKey?: string,
) {
  const executionKey = idempotencyKey?.trim() || randomUUID();
  return `tool:${kind}:${createHash("sha256")
    .update(`${kind}\u0000${scopeId}\u0000${executionKey}`)
    .digest("hex")}`;
}

function safeMissionText(value: unknown, maxLength: number) {
  return String(redactSensitive(String(value ?? ""))).trim().slice(0, maxLength);
}

function safeMissionLine(value: unknown, maxLength: number) {
  return safeMissionText(value, maxLength).replace(/\s+/g, " ");
}

function publicMissionSummary(mission: Mission) {
  return {
    id: mission.id,
    title: safeMissionLine(mission.title, 240),
    objective: safeMissionLine(mission.objective, 600),
    status: mission.status,
    priority: mission.priority,
    startedAt: mission.startedAt,
    terminalAt: mission.terminalAt,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  };
}

function publicMissionDetail(detail: MissionDetail) {
  const commentArtifacts = detail.artifacts.filter(isMissionCommentArtifact);
  return {
    mission: {
      ...publicMissionSummary(detail.mission),
      objective: safeMissionText(detail.mission.objective, 4_000),
    },
    tasks: detail.tasks.map(publicMissionTask),
    attempts: detail.attempts.map(publicMissionAttempt),
    artifacts: detail.artifacts
      .filter((artifact) => !isMissionCommentArtifact(artifact))
      .map(publicMissionArtifact),
    comments: commentArtifacts.map(publicMissionComment),
  };
}

function publicMissionTask(task: MissionTask) {
  const metadata = task.metadata && typeof task.metadata === "object"
    ? task.metadata
    : {};
  const blocker = metadata.blocker && typeof metadata.blocker === "object" && !Array.isArray(metadata.blocker)
    ? metadata.blocker as Record<string, unknown>
    : undefined;
  const skillIds = Array.isArray(metadata.skillIds)
    ? [...new Set(metadata.skillIds
      .filter((value): value is string => typeof value === "string")
      .map((value) => safeMissionLine(value, 120))
      .filter(Boolean))].slice(0, 30)
    : [];
  return {
    id: task.id,
    missionId: task.missionId,
    parentTaskId: task.parentTaskId,
    title: safeMissionLine(task.title, 280),
    instructions: safeMissionText(task.instructions, 8_000),
    definitionOfDone: safeMissionText(task.definitionOfDone, 2_000),
    status: task.status,
    priority: task.priority,
    position: task.position,
    dependencyIds: task.dependencyIds.slice(0, 50),
    assignment: {
      assigned: Boolean(metadata.assigneeKey || metadata.assigneeName),
      name: metadata.assigneeName
        ? safeMissionLine(metadata.assigneeName, 160)
        : undefined,
    },
    skillIds,
    scheduledAt: typeof metadata.scheduledAt === "string"
      ? safeMissionLine(metadata.scheduledAt, 80)
      : undefined,
    blocker: blocker
      ? {
          kind: safeMissionLine(blocker.kind, 40),
          reason: safeMissionText(blocker.reason, 2_000),
        }
      : undefined,
    review: {
      required: metadata.reviewRequired === true,
      reviewerName: metadata.reviewerName
        ? safeMissionLine(metadata.reviewerName, 160)
        : undefined,
      requestedAt: typeof metadata.reviewRequestedAt === "string"
        ? safeMissionLine(metadata.reviewRequestedAt, 80)
        : undefined,
      summary: metadata.reviewSummary
        ? safeMissionText(metadata.reviewSummary, 2_000)
        : undefined,
      changesRequestedReason: metadata.changesRequestedReason
        ? safeMissionText(metadata.changesRequestedReason, 2_000)
        : undefined,
    },
    startedAt: task.startedAt,
    terminalAt: task.terminalAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function publicMissionAttempt(attempt: MissionAttempt) {
  return {
    id: attempt.id,
    taskId: attempt.taskId,
    executorType: safeMissionLine(attempt.executorType, 80),
    status: attempt.status,
    hasResult: Boolean(attempt.output),
    hasError: Boolean(attempt.error),
    startedAt: attempt.startedAt,
    terminalAt: attempt.terminalAt,
    createdAt: attempt.createdAt,
    updatedAt: attempt.updatedAt,
  };
}

function isMissionCommentArtifact(artifact: MissionArtifact) {
  return artifact.kind === "task_comment" || artifact.kind === "comment";
}

function publicMissionArtifact(artifact: MissionArtifact) {
  return {
    id: artifact.id,
    taskId: artifact.taskId,
    attemptId: artifact.attemptId,
    kind: safeMissionLine(artifact.kind, 80),
    title: safeMissionLine(artifact.title, 280),
    mimeType: artifact.mimeType
      ? safeMissionLine(artifact.mimeType, 160)
      : undefined,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
  };
}

function publicMissionComment(comment: MissionArtifact) {
  return {
    id: comment.id,
    taskId: comment.taskId,
    body: safeMissionText(comment.data?.body, 4_000),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

function parseInput(tool: ToolDefinition, input: Record<string, unknown>) {
  if (tool.id === "memory.search" || tool.id === "knowledge.search") {
    return searchSchema.parse(input);
  }

  if (tool.id === "web.search") {
    return webSearchSchema.parse(input);
  }

  if (tool.id === "memory.write") {
    return memoryWriteSchema.parse(input);
  }

  if (tool.id === "memory.correct") {
    return memoryCorrectSchema.parse(input);
  }

  if (tool.id === "memory.forget") {
    return memoryForgetSchema.parse(input);
  }

  if (tool.id === "knowledge.ingest") {
    return knowledgeIngestSchema.parse(input);
  }

  if (tool.id === "missions.list") {
    return missionsListSchema.parse(input);
  }

  if (tool.id === "mission.show") {
    return missionShowSchema.parse(input);
  }

  if (tool.id === "mission.task.create") {
    return missionTaskCreateSchema.parse(input);
  }

  if (tool.id === "mission.task.comment") {
    return missionTaskCommentSchema.parse(input);
  }

  if (tool.id === "runs.list") {
    return runsListSchema.parse(input);
  }

  if (tool.id === "http.request") {
    return httpRequestSchema.parse(input);
  }

  if (tool.id === "calendar.create") {
    return googleCalendarCreateSchema.parse(input);
  }

  if (tool.category === "mcp" || tool.category === "openapi") {
    validateConnectorInput(tool.inputSchema, input);
    return input;
  }

  return input;
}

function describeSideEffects(toolId: string) {
  if (toolId === "memory.write") {
    return ["writes omni_memories", "may create embedding"];
  }

  if (toolId === "memory.correct") {
    return [
      "creates a corrected omni_memories record",
      "marks the previous record as superseded or contradicted without erasing it",
      "regenerates the corrected embedding and queues a memory graph rebuild",
    ];
  }

  if (toolId === "memory.forget") {
    return [
      "irreversibly scrubs the selected memory, including evidence references and embeddings",
      "in Postgres, removes retrieval traces and graph rows derived from the selected memory or its descendants",
      "atomically records a scoped deletion receipt and queues a memory graph rebuild in Postgres",
      "file-backed compatibility mode performs a best-effort scrub and graph rebuild without a deletion receipt",
    ];
  }

  if (toolId === "knowledge.ingest") {
    return ["writes omni_knowledge_documents", "writes omni_knowledge_chunks", "writes compatible memory records"];
  }

  if (toolId === "missions.list") {
    return ["read-only tenant-and-actor-scoped mission summaries"];
  }

  if (toolId === "mission.show") {
    return ["read-only tenant-and-actor-scoped mission board detail"];
  }

  if (toolId === "mission.task.create") {
    return [
      "creates one tenant-and-actor-scoped mission task in triage",
      "records bounded assignment, skill, dependency, and review planning fields",
      "does not start, complete, or otherwise transition task execution",
    ];
  }

  if (toolId === "mission.task.comment") {
    return [
      "appends one bounded, redacted comment to a tenant-and-actor-scoped mission task",
      "does not change mission or task execution state",
    ];
  }

  if (toolId === "web.search") {
    return ["read-only live web search", "uses OpenAI Responses web_search hosted tool", "stores source metadata in the tool audit ledger"];
  }

  if (toolId === "http.request") {
    return [
      "outbound HTTP call to a public endpoint",
      "side effects depend on the target API and method",
      "SSRF-guarded; redirects are not followed; response is truncated in the audit record",
    ];
  }

  if (toolId === "calendar.create") {
    return [
      "creates one event in the exact connected user's Google Calendar",
      "uses a deterministic provider event ID to prevent duplicate delivery",
      "requires read-after-write verification before reporting success",
    ];
  }

  if (toolId.startsWith("mcp:")) {
    return ["remote MCP tool call", "side effects depend on discovered tool annotations and connector policy"];
  }

  if (toolId.startsWith("openapi:")) {
    return ["remote REST API call", "side effects depend on HTTP method, endpoint, and connector policy"];
  }

  return ["read-only"];
}
