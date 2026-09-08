import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { listWorkflowsService } from "@/lib/app-services/workflows";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { redactSensitive } from "@/lib/security/context";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import {
  requestSharedMemoryAccessFromSecurityContext,
  SharedContextAuthorityError,
} from "@/lib/memory/shared-context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  narrowRunBudgetLimits,
  runBudgetCountersV1Schema,
} from "@/lib/runs/budgets";
import { enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import {
  assertWorkflowRunExecutionAuthority,
  createWorkflowRun,
  getWorkflowRunDetail,
  transitionWorkflowRunWithEvents,
} from "@/lib/workflows/store";
import {
  claimWorkflowPlanForRun,
  getWorkflowPlanById,
  validateWorkflowPlan,
} from "@/lib/workflows/planner";
import {
  publicWorkflowRunDetail,
} from "@/lib/workflows/public";
import { getThread } from "@/lib/threads/store";
import {
  contextSelectionRequestSchema,
  verifyContextSelectionLock,
} from "@/lib/rag/context-selection-lock";
import {
  assertContextScopeRequest,
  CONTEXT_SCOPE_IDS,
  type ContextScopeId,
} from "@/lib/rag/context-scope";
import {
  createWorkflowSharedContextBinding,
  isWorkflowSharedContextScope,
  workflowPlanContextBoundariesEqual,
  workflowPlanContextBoundary,
  WORKFLOW_SHARED_CONTEXT_METADATA_KEY,
} from "@/lib/workflows/shared-context";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const workflowStartSchema = z.object({
  goal: z.string().min(1).max(4000),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  planId: z.string().min(1).max(120).optional(),
  requireApproval: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  budgets: runBudgetCountersV1Schema.partial().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  const includeStats = url.searchParams.get("stats") !== "false";
  const includeQueue = url.searchParams.get("queue") !== "false";
  const result = await listWorkflowsService(createAppServiceCaller({ context }), {
    limit,
    includeStats,
    includeQueue,
  });
  return Response.json({ ...result.data, serviceReceipt: result.receipt });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = workflowStartSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow start request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  let budgetLimits;
  try {
    budgetLimits = narrowRunBudgetLimits(
      WORKFLOW_RUN_BUDGET_LIMITS,
      parsed.data.budgets,
    );
  } catch (error) {
    return Response.json(
      {
        error: "Invalid workflow budget",
        message: error instanceof Error
          ? error.message
          : "The requested workflow budget is invalid.",
      },
      { status: 400 },
    );
  }
  const { budgets: _requestedBudgets, ...requestedWorkflowStart } = parsed.data;
  void _requestedBudgets;
  let idempotencyKey: string | undefined;
  try {
    idempotencyKey = requestIdempotencyKey(request);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Invalid Idempotency-Key." },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      metadata: {
        goalLength: parsed.data.goal.length,
        mode: parsed.data.mode || "orchestrate",
        planId: parsed.data.planId,
        requireApproval: Boolean(parsed.data.requireApproval),
        metadataKeys: Object.keys(parsed.data.metadata || {}).slice(0, 50),
      },
    });
    const {
      [WORKFLOW_SHARED_CONTEXT_METADATA_KEY]: _untrustedSharedContext,
      contextSelection: _untrustedContextSelection,
      ...clientMetadata
    } = parsed.data.metadata || {};
    void _untrustedSharedContext;
    void _untrustedContextSelection;
    const rawContextScope = clientMetadata.contextScope;
    const contextScope = typeof rawContextScope === "string" &&
        CONTEXT_SCOPE_IDS.includes(rawContextScope as ContextScopeId)
      ? rawContextScope as ContextScopeId
      : undefined;
    if (rawContextScope !== undefined && !contextScope) {
      return Response.json(
        { error: "Workflow metadata contains an invalid context scope." },
        { status: 400 },
      );
    }
    if (contextScope) {
      try {
        assertContextScopeRequest(
          contextScope,
          parsed.data.metadata?.contextSelection !== undefined,
        );
      } catch (error) {
        return Response.json({
          error: "Workflow context boundary is invalid.",
          message: error instanceof Error ? error.message : "Invalid context scope.",
        }, { status: 409 });
      }
    }
    let verifiedContextSelection;
    if (parsed.data.metadata?.contextSelection !== undefined) {
      const selection = contextSelectionRequestSchema.safeParse(
        parsed.data.metadata.contextSelection,
      );
      if (!selection.success) {
        return Response.json(
          { error: "Workflow context selection requires a valid lock." },
          { status: 400 },
        );
      }
      if (
        normalizedWorkflowGoal(selection.data.query) !==
          normalizedWorkflowGoal(parsed.data.goal)
      ) {
        return Response.json({
          error: "Workflow context selection is out of date.",
          message: "Refresh and review context after changing the workflow goal.",
        }, { status: 409 });
      }
      try {
        verifiedContextSelection = verifyContextSelectionLock({
          tenantId: context.tenantId,
          actorId: context.actorId,
          selection: selection.data,
        });
      } catch (error) {
        return Response.json({
          error: "Workflow context selection lock is invalid.",
          message: error instanceof Error
            ? error.message
            : "Refresh and review context again.",
        }, { status: 409 });
      }
    }
    const requestedThreadId = clientMetadata.threadId;
    if (requestedThreadId !== undefined) {
      if (typeof requestedThreadId !== "string" || !requestedThreadId.trim()) {
        return Response.json(
          { error: "Workflow metadata threadId must identify a conversation." },
          { status: 400 },
        );
      }
      const thread = await getThread(requestedThreadId.trim(), {
        tenantId: context.tenantId,
      });
      if (!thread || thread.actorId !== context.actorId) {
        return Response.json({ error: "Thread not found." }, { status: 404 });
      }
    }
    const selectedPlan = parsed.data.planId
      ? await getWorkflowPlanById(parsed.data.planId, {
          tenantId: context.tenantId,
        })
      : undefined;
    if (parsed.data.planId && !selectedPlan) {
      return Response.json(
        { error: "The selected workflow plan was not found for this workspace." },
        { status: 404 },
      );
    }
    if (
      selectedPlan &&
      (
        selectedPlan.status !== "planned" ||
        normalizedWorkflowGoal(selectedPlan.goal) !==
          normalizedWorkflowGoal(parsed.data.goal) ||
        selectedPlan.plan.mode !== (parsed.data.mode || "orchestrate")
      )
    ) {
      return Response.json(
        {
          error: "The selected workflow plan no longer matches this run.",
          message: "Generate a fresh plan after changing the goal or mode.",
        },
        { status: 409 },
      );
    }
    if (selectedPlan) {
      const validation = validateWorkflowPlan(selectedPlan.plan);
      const missingExecutableInput = validation.policyWarnings.some((warning) =>
        warning.startsWith("Missing executable input"),
      );
      if (
        !validation.isDag ||
        validation.missingDependencies.length > 0 ||
        missingExecutableInput
      ) {
        return Response.json(
          {
            error: "The selected workflow plan cannot be executed safely.",
            message: missingExecutableInput
              ? "Generate a fresh plan so connector inputs can be reviewed before execution."
              : "Generate a fresh plan because the stored plan structure is invalid.",
          },
          { status: 409 },
        );
      }
    }
    let sharedContextAccess;
    const workflowCorrelationId = selectedPlan
      ? `workflow-plan:${selectedPlan.id}`
      : idempotencyKey
        ? `workflow-request:${idempotencyKey}`
        : `workflow-request:${randomUUID()}`;
    if (isWorkflowSharedContextScope(contextScope)) {
      const projectId = metadataString(clientMetadata.projectId);
      const missionId = metadataString(clientMetadata.missionId);
      const workspaceId = metadataString(clientMetadata.workspaceId);
      if (contextScope === "project" && !projectId) {
        return Response.json(
          { error: "Workflow project context requires a project." },
          { status: 400 },
        );
      }
      if (
        contextScope === "mission" &&
        (!missionId || !z.string().uuid().safeParse(missionId).success)
      ) {
        return Response.json(
          { error: "Workflow Mission context requires a valid Mission." },
          { status: 400 },
        );
      }
      if (contextScope === "mission" && projectId) {
        return Response.json(
          { error: "Mission context resolves its canonical Project on the server." },
          { status: 400 },
        );
      }
      if (
        (contextScope === "mission" && workspaceId) ||
        (contextScope === "project" && (missionId || workspaceId)) ||
        (contextScope === "workspace" && missionId)
      ) {
        return Response.json(
          { error: "Workflow shared-context coordinates are inconsistent." },
          { status: 400 },
        );
      }
      try {
        sharedContextAccess = await requestSharedMemoryAccessFromSecurityContext(
          context,
          {
            scope: contextScope === "workspace" ? "workspace" : "project",
            projectId: contextScope === "mission" ? missionId : projectId,
            workspaceId,
            correlationId: workflowCorrelationId,
          },
        );
      } catch (error) {
        if (!(error instanceof SharedContextAuthorityError)) throw error;
        return Response.json({
          error: error.code === "scope_not_found"
            ? "Shared context not found"
            : "Shared context unavailable",
          message: error.code === "scope_not_found"
            ? "The selected shared context is unavailable to this account."
            : "Shared context authority could not be verified.",
        }, {
          status: error.code === "scope_not_found" ? 404 : 503,
          headers: { "cache-control": "private, no-store" },
        });
      }
    }
    const executionAuthority = {
      executionScope: executionScopeFromSecurityContext(context, {
        workspaceId: sharedContextAccess?.authority.workspaceId,
        projectId: sharedContextAccess?.authority.projectId,
        missionId: contextScope === "mission"
          ? metadataString(clientMetadata.missionId)
          : undefined,
        correlationId: workflowCorrelationId,
        purpose: "workflow.run",
      }),
      requesterRole: context.role,
    } as const;
    const sharedContextBinding = sharedContextAccess &&
        isWorkflowSharedContextScope(contextScope)
      ? createWorkflowSharedContextBinding({
          access: sharedContextAccess,
          contextScope,
          workflowExecutionScope: executionAuthority.executionScope,
        })
      : undefined;
    const requestedPlanContextBoundary = sharedContextAccess &&
        isWorkflowSharedContextScope(contextScope)
      ? workflowPlanContextBoundary(sharedContextAccess, contextScope)
      : undefined;
    if (
      selectedPlan &&
      !workflowPlanContextBoundariesEqual(
        selectedPlan.contextBoundary,
        requestedPlanContextBoundary,
      )
    ) {
      return Response.json({
        error: "The selected workflow plan has a different context boundary.",
        message: "Generate a fresh plan for the selected context before starting.",
      }, { status: 409 });
    }
    const workflowStart = {
      ...requestedWorkflowStart,
      metadata: {
        ...clientMetadata,
        ...(verifiedContextSelection
          ? { contextSelection: verifiedContextSelection }
          : contextScope && !isWorkflowSharedContextScope(contextScope)
            ? { contextSelection: { query: parsed.data.goal, evidenceIds: [] } }
            : {}),
        ...(sharedContextBinding
          ? { [WORKFLOW_SHARED_CONTEXT_METADATA_KEY]: sharedContextBinding }
          : {}),
      },
    };
    if (selectedPlan?.workflowRunId) {
      const existing = await getWorkflowRunDetail(selectedPlan.workflowRunId, {
        tenantId: context.tenantId,
      });
      if (!existing) {
        return Response.json(
          {
            error: "The selected workflow plan has an invalid run binding.",
            message: "Generate a fresh plan and contact an administrator if this repeats.",
          },
          { status: 409 },
        );
      }
      if (stableJson(existing.run.input.budgetLimits ?? null) !== stableJson(budgetLimits)) {
        return Response.json(
          {
            error: "The selected workflow plan already has different run budgets.",
            message: "Generate a fresh plan to change workflow budgets.",
          },
          { status: 409 },
        );
      }
      try {
        await assertWorkflowRunExecutionAuthority(
          existing.run.id,
          executionAuthority,
          { tenantId: context.tenantId },
        );
      } catch {
        return Response.json(
          {
            error: "The selected workflow authority no longer matches this request.",
            message: "Generate a fresh plan before starting this workflow.",
          },
          { status: 409 },
        );
      }
      const queueJob = existing.run.status === "queued"
        ? await enqueueWorkflowRunTick(
            existing.run.id,
            "workflow_create_replay",
            undefined,
            context.tenantId,
          )
        : undefined;
      if (queueJob) {
        scheduleWorkflowQueueDrain(undefined, context.tenantId);
      }
      return Response.json({
        ...publicWorkflowRunDetail(existing),
        queueJob,
        replayed: true,
      });
    }
    const detail = await createWorkflowRun({
      ...workflowStart,
      budgetLimits,
      executionAuthority,
      metadata: {
        ...(workflowStart.metadata || {}),
        actorId: context.actorId,
      },
      idempotencyKey: selectedPlan
        ? `reviewed-plan:${selectedPlan.id}`
        : idempotencyKey,
      requireApproval:
        Boolean(parsed.data.requireApproval) ||
        Boolean(selectedPlan?.approvalRequired),
      tenantId: context.tenantId,
    });
    if (
      idempotencyKey &&
      !selectedPlan &&
      !workflowRequestMatches(detail.run.input, {
        ...workflowStart,
        budgetLimits,
        metadata: {
          ...(workflowStart.metadata || {}),
          actorId: context.actorId,
        },
      })
    ) {
      return Response.json(
        {
          error: "Idempotency-Key was already used for a different workflow request.",
          message: "Use a new idempotency key when the goal or execution options change.",
        },
        { status: 409 },
      );
    }
    if (selectedPlan) {
      const claimedPlan = await claimWorkflowPlanForRun({
        planId: selectedPlan.id,
        workflowRunId: detail.run.id,
        tenantId: context.tenantId,
      });
      if (!claimedPlan) {
        const concurrentlyClaimedPlan = await getWorkflowPlanById(selectedPlan.id, {
          tenantId: context.tenantId,
        });
        if (concurrentlyClaimedPlan?.workflowRunId === detail.run.id) {
          const queueJob = await enqueueWorkflowRunTick(
            detail.run.id,
            "workflow_create_replay",
            undefined,
            context.tenantId,
          );
          scheduleWorkflowQueueDrain(undefined, context.tenantId);
          return Response.json({
            ...publicWorkflowRunDetail(detail),
            queueJob,
            replayed: true,
          });
        }
        await transitionWorkflowRunWithEvents(
          detail.run.id,
          ["queued"],
          {
            status: "canceled",
            error: "The selected plan was claimed by another workflow.",
            canceledAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
          },
          [{
            type: "workflow.plan_claim_conflict",
            payload: { planId: selectedPlan.id },
          }],
          {
            tenantId: context.tenantId,
            executionAuthority,
            eventExecutionScope: executionAuthority.executionScope,
          },
        );
        return Response.json(
          {
            error: "The selected workflow plan was already used.",
            message: "Generate a fresh plan and try again.",
          },
          { status: 409 },
        );
      }
    }
    const queueJob = await enqueueWorkflowRunTick(
      detail.run.id,
      "workflow_created",
      undefined,
      context.tenantId,
    );
    scheduleWorkflowQueueDrain(undefined, context.tenantId);
    return Response.json(
      { ...publicWorkflowRunDetail(detail), queueJob },
      { status: 201 },
    );
  } catch (error) {
    return forbiddenResponse(error);
  }
}

function requestIdempotencyKey(request: Request) {
  const value = request.headers.get("idempotency-key")?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > 200 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(
      "Idempotency-Key must be 200 characters or fewer and use letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
  return value;
}

function workflowRequestMatches(
  existing: {
    goal: string;
    mode?: "orchestrate" | "research" | "execute" | "learn";
    requireApproval?: boolean;
    maxAttempts?: number;
    budgetLimits?: z.infer<typeof runBudgetCountersV1Schema>;
    metadata?: Record<string, unknown>;
  },
  requested: Omit<z.infer<typeof workflowStartSchema>, "budgets"> & {
    budgetLimits: z.infer<typeof runBudgetCountersV1Schema>;
  },
) {
  const safeExisting = redactSensitive(existing) as typeof existing;
  const safeRequested = redactSensitive(requested) as typeof requested;
  return (
    normalizedWorkflowGoal(safeExisting.goal) ===
      normalizedWorkflowGoal(safeRequested.goal) &&
    (safeExisting.mode || "orchestrate") ===
      (safeRequested.mode || "orchestrate") &&
    (safeExisting.requireApproval ?? true) ===
      (safeRequested.requireApproval ?? true) &&
    (safeExisting.maxAttempts ?? 3) === (safeRequested.maxAttempts ?? 3) &&
    stableJson(safeExisting.budgetLimits ?? null) ===
      stableJson(safeRequested.budgetLimits) &&
    stableJson(safeExisting.metadata ?? null) ===
      stableJson(safeRequested.metadata ?? null)
  );
}

function normalizedWorkflowGoal(value: string) {
  return String(redactSensitive(value.trim()));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function metadataString(value: unknown) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 240
    ? normalized
    : undefined;
}
