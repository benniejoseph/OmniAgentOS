import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { cancelWorkflowRunTick, enqueueWorkflowRunTick, scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import {
  signalWorkflowRun,
  WorkflowNotFoundError,
  WorkflowSignalConflictError,
} from "@/lib/workflows/runner";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const signalSchema = z.object({
  signal: z.enum(["pause", "resume", "cancel", "approve", "retry"]),
}).strict();

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = signalSchema.safeParse(body);

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
      metadata: { signal: parsed.data.signal },
    });
    const detail = await signalWorkflowRun(id, parsed.data.signal, { tenantId: securityContext.tenantId });
    let queueJob;
    let canceledJobs;

    if (parsed.data.signal === "pause" || parsed.data.signal === "cancel") {
      canceledJobs = await cancelWorkflowRunTick(
        id,
        `Workflow ${parsed.data.signal} signal received.`,
        securityContext.tenantId,
      );
    }

    if (parsed.data.signal === "resume" || parsed.data.signal === "approve" || parsed.data.signal === "retry") {
      queueJob = await enqueueWorkflowRunTick(
        id,
        `workflow_${parsed.data.signal}`,
        undefined,
        securityContext.tenantId,
      );
      scheduleWorkflowQueueDrain(undefined, securityContext.tenantId);
    }

    return Response.json({
      ...detail,
      queueJob,
      canceledJobs,
    });
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (error instanceof WorkflowSignalConflictError) {
      return Response.json(
        { error: "Workflow signal conflict", message: error.message },
        { status: 409 },
      );
    }
    try {
      return forbiddenResponse(error);
    } catch {
      // fall through to not-found style workflow error
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Workflow signal failed." },
      { status: 500 },
    );
  }
}
