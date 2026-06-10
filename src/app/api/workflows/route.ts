import { z } from "zod";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { getOperationJobStats } from "@/lib/operations/job-queue";
import { enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { createWorkflowRun, getWorkflowStats, listWorkflowRuns } from "@/lib/workflows/store";

export const runtime = "nodejs";

const workflowStartSchema = z.object({
  goal: z.string().min(1).max(4000),
  mode: z.enum(["orchestrate", "research", "execute", "learn"]).optional(),
  requireApproval: z.boolean().optional(),
  maxAttempts: z.number().int().min(1).max(5).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: Request) {
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
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  return Response.json({
    runs: await listWorkflowRuns(limit, { tenantId: context.tenantId }),
    stats: await getWorkflowStats({ tenantId: context.tenantId }),
    queue: await getOperationJobStats(),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  if (body === null) {
    return Response.json({ error: "Invalid request", message: "Request body is not valid JSON." }, { status: 400 });
  }
  const parsed = workflowStartSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow start request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      metadata: body,
    });
    const detail = await createWorkflowRun({ ...parsed.data, tenantId: context.tenantId });
    const queueJob = await enqueueWorkflowRunTick(detail.run.id, "workflow_created");
    scheduleWorkflowQueueDrain();
    return Response.json({ ...detail, queueJob }, { status: 201 });
  } catch (error) {
    return forbiddenResponse(error);
  }
}
