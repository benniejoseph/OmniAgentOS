import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats, listWorkflowPlans } from "@/lib/workflows/planner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import {
  contextSelectionRequestSchema,
  verifyContextSelectionLock,
} from "@/lib/rag/context-selection-lock";
import {
  assertContextScopeRequest,
  CONTEXT_SCOPE_IDS,
  getContextScopePolicy,
} from "@/lib/rag/context-scope";

export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const workflowPlanSchema = z.object({
  goal: z.string().min(1).max(4000),
  contextScope: z.enum(CONTEXT_SCOPE_IDS).optional(),
  contextSelection: contextSelectionRequestSchema.optional(),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  workflowRunId: z.string().min(1).optional(),
  requireApproval: z.boolean().optional(),
  reuseExisting: z.boolean().optional(),
}).strict();

async function GETHandler(request: Request) {
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "workflow_plan",
      metadata: { limit },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json({
    plans: await listWorkflowPlans(limit, { tenantId: context.tenantId }),
    stats: await getWorkflowPlanStats({ tenantId: context.tenantId }),
  });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = workflowPlanSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow plan request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }
  if (
    parsed.data.contextSelection
    && normalizeTaskQuery(parsed.data.contextSelection.query) !== normalizeTaskQuery(parsed.data.goal)
  ) {
    return Response.json(
      {
        error: "Context selection is out of date.",
        message: "The reviewed context does not match this workflow goal. Rebuild context before planning.",
      },
      { status: 409 },
    );
  }
  if (parsed.data.contextScope) {
    try {
      assertContextScopeRequest(
        parsed.data.contextScope,
        Boolean(parsed.data.contextSelection),
      );
    } catch (error) {
      const policy = getContextScopePolicy(parsed.data.contextScope);
      return Response.json({
        error: policy.state === "authority_held"
          ? "Context scope unavailable"
          : "Invalid context scope",
        message: error instanceof Error ? error.message : "Invalid context scope.",
      }, { status: policy.state === "authority_held" ? 409 : 400 });
    }
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow_plan",
      metadata: {
        goalLength: parsed.data.goal.length,
        mode: parsed.data.mode || "orchestrate",
        workflowRunId: parsed.data.workflowRunId,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let contextSelection;
  if (parsed.data.contextSelection) {
    try {
      contextSelection = verifyContextSelectionLock({
        tenantId: context.tenantId,
        actorId: context.actorId,
        selection: parsed.data.contextSelection,
      });
    } catch (error) {
      return Response.json({
        error: "Context selection lock is invalid.",
        message: error instanceof Error
          ? error.message
          : "Refresh and review context again.",
      }, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
  }

  const plan = await buildDynamicWorkflowPlan({
    tenantId: context.tenantId,
    actorId: context.actorId,
    goal: parsed.data.goal,
    contextSelection: contextSelection || (parsed.data.contextScope
      ? { query: parsed.data.goal, evidenceIds: [] }
      : undefined),
    mode: parsed.data.mode,
    workflowRunId: parsed.data.workflowRunId,
    requireApproval: parsed.data.requireApproval,
    source: "api",
    reuseExisting: parsed.data.reuseExisting,
    executionScope: executionScopeFromSecurityContext(context, {
      correlationId:
        request.headers.get("x-idempotency-key")?.trim().slice(0, 240) ||
        request.headers.get("x-request-id")?.trim().slice(0, 240) ||
        `workflow-plan:${randomUUID()}`,
      purpose: "workflow.plan.create",
    }),
  });

  return Response.json({ plan, stats: await getWorkflowPlanStats({ tenantId: context.tenantId }) }, { status: 201 });
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
