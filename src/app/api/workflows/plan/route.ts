import { z } from "zod";
import { buildDynamicWorkflowPlan, getWorkflowPlanStats, listWorkflowPlans } from "@/lib/workflows/planner";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const workflowPlanSchema = z.object({
  goal: z.string().min(1).max(4000),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  workflowRunId: z.string().min(1).optional(),
  requireApproval: z.boolean().optional(),
  reuseExisting: z.boolean().optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);

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

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const parsed = workflowPlanSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow plan request", details: parsed.error.flatten() },
      { status: 400 },
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
    goal: parsed.data.goal,
    mode: parsed.data.mode,
    workflowRunId: parsed.data.workflowRunId,
    requireApproval: parsed.data.requireApproval,
    source: "api",
    reuseExisting: parsed.data.reuseExisting,
  });

  return Response.json({ plan, stats: await getWorkflowPlanStats({ tenantId: context.tenantId }) }, { status: 201 });
}
