import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats, listWorkflowPlans } from "@/lib/workflows/planner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 60;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const contextSelectionSchema = z.object({
  query: z.string().trim().min(1).max(4_000),
  evidenceIds: z.array(z.string().trim().min(1).max(200).regex(/^(?:memory|knowledge|graph):[^\s]+$/))
    .max(24)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Context evidence IDs must be unique.",
    }),
}).strict();

const workflowPlanSchema = z.object({
  goal: z.string().min(1).max(4000),
  contextSelection: contextSelectionSchema.optional(),
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

  const plan = await buildDynamicWorkflowPlan({
    tenantId: context.tenantId,
    actorId: context.actorId,
    goal: parsed.data.goal,
    contextSelection: parsed.data.contextSelection,
    mode: parsed.data.mode,
    workflowRunId: parsed.data.workflowRunId,
    requireApproval: parsed.data.requireApproval,
    source: "api",
    reuseExisting: parsed.data.reuseExisting,
  });

  return Response.json({ plan, stats: await getWorkflowPlanStats({ tenantId: context.tenantId }) }, { status: 201 });
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}
