import { z } from "zod";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { signalWorkflowRun } from "@/lib/workflows/runner";

export const runtime = "nodejs";

const signalSchema = z.object({
  signal: z.enum(["pause", "resume", "cancel", "approve", "retry"]),
});

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const parsed = signalSchema.safeParse(await request.json().catch(() => ({})));

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid workflow signal request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const securityContext = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "workflow",
      resourceId: id,
      metadata: parsed.data,
    });
    const detail = await signalWorkflowRun(id, parsed.data.signal, { tenantId: securityContext.tenantId });
    let queueJob;
    let canceledJobs;

    if (parsed.data.signal === "pause" || parsed.data.signal === "cancel") {
      canceledJobs = await cancelWorkflowRunTick(id, `Workflow ${parsed.data.signal} signal received.`);
    }

    if (parsed.data.signal === "resume" || parsed.data.signal === "approve" || parsed.data.signal === "retry") {
      queueJob = await enqueueWorkflowRunTick(id, `workflow_${parsed.data.signal}`);
      scheduleWorkflowQueueDrain();
    }

    return Response.json({
      ...detail,
      queueJob,
      canceledJobs,
    });
  } catch (error) {
    try {
      return forbiddenResponse(error);
    } catch {
      // fall through to not-found style workflow error
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow signal failed." },
      { status: 404 },
    );
  }
}
