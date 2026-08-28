import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { embedTexts } from "@/lib/openai/client";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { validateConnectorInput } from "@/lib/connectors/input-validation";
import { callMcpTool } from "@/lib/connectors/mcp-client";
import { callOpenApiOperation } from "@/lib/connectors/openapi-client";
import { assertConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { getOpenApiConnector, getOpenApiOperationById } from "@/lib/connectors/openapi-store";
import { getMcpConnector, getMcpToolById } from "@/lib/connectors/store";
import { readResponseTextLimited } from "@/lib/http/body";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { saveMemory, searchMemories } from "@/lib/memory/store";
import type { MemoryType } from "@/lib/memory/types";
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
import { assertPublicHttpUrl, fetchPublicHttpUrl } from "@/lib/security/network";
import { redactExactSecrets } from "@/lib/security/secret-redaction";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { searchKnowledge } from "@/lib/rag/store";
import { listAgentRuns } from "@/lib/runs/store";
import { publicAgentRun } from "@/lib/runs/public";
import {
  completeClaimedToolExecution,
  claimIdempotentToolExecution,
  createToolExecutionRecord,
  getToolExecution,
  getToolExecutionApprovalFingerprint,
  recoverStaleToolExecutionClaim,
  saveToolExecution,
  sealToolExecutionInput,
} from "@/lib/tools/audit-store";
import { toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import { evaluateToolPolicy } from "@/lib/tools/policy";
import type { SecurityContext } from "@/lib/security/types";
import { getGovernedTool } from "@/lib/tools/registry";
import { RISK3_QUORUM, type ToolDefinition, type ToolExecutionRecord } from "@/lib/tools/types";
import { actionClassFor, recordActionOutcome, resolveAutonomy } from "@/lib/trust/ledger";
import { isGraduatedAutonomyEnabled } from "@/lib/trust/policy";
import { runLiveWebSearch } from "@/lib/web-search/search";

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
}) {
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
    const reason = "Unknown tools are blocked by default.";
    const patch: Omit<ToolExecutionRecord, "id" | "createdAt"> = {
      tenantId: context?.tenantId,
      actorId: context?.actorId,
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
      toolId,
      reason,
      input,
      riskLevel: 3,
    });
    const saved = executionClaimToken
      ? await completeClaimedToolExecution(record, executionClaimToken)
      : await saveToolExecution(record);
    if (!saved) {
      throw new ExecutionClaimLostError();
    }
    return { record: saved, result: null };
  }
  const effectiveForceApproval = forceApproval || Boolean(
    existingRecord?.approvalRequired && !registeredTool.approvalRequired && registeredTool.riskLevel > 0,
  );
  const tool = effectiveForceApproval
    ? { ...registeredTool, approvalRequired: true }
    : registeredTool;
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

  // Idempotent retries must resolve their existing receipt before consulting
  // (and consuming) the earned-autonomy budget. This keeps transport retries
  // from spending additional authority or producing a new approval decision.
  if (!dryRun && idempotencyKey && !existingRecord) {
    const existing = await getToolExecution(
      idempotentToolExecutionId(
        normalizeTenantId(context?.tenantId),
        idempotencyKey,
      ),
      { tenantId: context?.tenantId },
    );
    if (existing) {
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
  const persistRecord = async (record: ToolExecutionRecord) => {
    if (!activeExecutionClaimToken) {
      return saveToolExecution(record);
    }
    const saved = await completeClaimedToolExecution(
      record,
      activeExecutionClaimToken,
    );
    if (!saved) {
      throw new ExecutionClaimLostError();
    }
    return saved;
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
    const record = {
      ...pendingRecord,
      output: sealToolExecutionInput(
        preparedInput,
        pendingRecord,
        toolApprovalFingerprint(tool),
      ),
    };
    const saved = await persistRecord(record);
    await recordRuntimeEventSafely({
      level: "warn",
      category: "workflow",
      action: "tool.approval_pending",
      tenantId: context?.tenantId,
      actorId: context?.actorId,
      resourceType: "tool_execution",
      resourceId: saved.id,
      message: `${tool.name} is waiting for human approval.`,
      metadata: {
        toolId: tool.id,
        toolName: tool.name,
        riskLevel: tool.riskLevel,
      },
    });
    return { record: saved, result: null };
  }

  if (!dryRun && idempotencyKey && !executionRecord) {
    const claimToken = randomUUID();
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
      },
      approvalDecision: decision.approvalRequired ? "approved" : undefined,
      approvedBy: decision.approvalRequired ? context?.actorId : undefined,
      approvedAt: decision.approvalRequired
        ? new Date().toISOString()
        : undefined,
      approvalReason,
    });
    intent.id = idempotentToolExecutionId(
      normalizeTenantId(context?.tenantId),
      idempotencyKey,
    );
    const claim = await claimIdempotentToolExecution(intent);
    if (claim.outcome === "existing") {
      const recovered =
        claim.record.status === "executing"
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
    executionRecord = claim.record;
    activeExecutionClaimToken = claimToken;
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

    const result = await runTool(
      tool,
      preparedInput,
      context,
      existingRecord?.id || idempotencyKey,
      abortSignal,
    );
    const safeResult = redactSensitive(result);
    const record = createRecord({
      ...baseRecord,
      status: "executed" as const,
      output: safeResult,
      approvalDecision: decision.approvalRequired ? "approved" as const : undefined,
      approvedBy: decision.approvalRequired ? context?.actorId : undefined,
      approvedAt: decision.approvalRequired ? new Date().toISOString() : undefined,
      approvalReason,
      completedAt: new Date().toISOString(),
    });
    const saved = await persistRecord(record);
    if (autonomyApproved) {
      await recordRuntimeEventSafely({
        level: "warn",
        category: "security",
        action: "autonomy.auto_approved",
        tenantId: context?.tenantId,
        actorId: context?.actorId,
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
      });
    }
    await recordTrustOutcomeSafely(tool, context, "success", effectiveApproved);
    return { record: saved, result: safeResult };
  } catch (error) {
    if (error instanceof ExecutionClaimLostError) {
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
        tenantId: context?.tenantId,
        actorId: context?.actorId,
        resourceType: "tool",
        resourceId: tool.id,
        message,
        metadata: {
          failureType: "connector_failure",
          toolName: tool.name,
          toolCategory: tool.category,
          riskLevel: tool.riskLevel,
        },
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
    await recordTrustOutcomeSafely(tool, context, "failure", effectiveApproved);
    return { record: saved, result: null };
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

async function runTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context?: SecurityContext,
  idempotencyKey?: string,
  abortSignal?: AbortSignal,
) {
  const parsed = parseInput(tool, input);

  if (tool.id === "memory.search") {
    const { query, limit } = searchSchema.parse(parsed);
    const safeQuery = String(redactSensitive(query));
    const queryEmbedding = (await embedTexts([safeQuery], abortSignal))?.[0];
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
    const queryEmbedding = (await embedTexts([safeQuery], abortSignal))?.[0];
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
    });
  }

  if (tool.id === "memory.write") {
    const value = memoryWriteSchema.parse(parsed);
    const safeValue = redactSensitive(value) as typeof value;
    const contentForEmbedding = `${safeValue.title}\n\n${safeValue.content}`;
    const embedding = (await embedTexts([contentForEmbedding], abortSignal))?.[0];
    return {
      record: stripEmbedding(await saveMemory({
        tenantId: context?.tenantId,
        title: safeValue.title,
        content: safeValue.content,
        type: safeValue.type as MemoryType | undefined,
        tags: safeValue.tags || ["tool-execution"],
        importance: safeValue.importance ?? 0.5,
        source: "tool-executor",
        scope: "workspace",
        embedding,
      })),
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

async function recordToolPolicyBlock({
  context,
  toolId,
  toolName,
  reason,
  input,
  riskLevel,
}: {
  context?: SecurityContext;
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
    tenantId: context?.tenantId,
    actorId: context?.actorId,
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

  if (toolId.startsWith("mcp:")) {
    return ["remote MCP tool call", "side effects depend on discovered tool annotations and connector policy"];
  }

  if (toolId.startsWith("openapi:")) {
    return ["remote REST API call", "side effects depend on HTTP method, endpoint, and connector policy"];
  }

  return ["read-only"];
}
