import { scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import { dispatchWorkflowTrigger } from "@/lib/workflows/triggers";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const bodyText = await request.text();

  try {
    const result = await dispatchWorkflowTrigger({
      triggerId: id,
      bodyText,
      headers: request.headers,
    });

    if (result.workflow) {
      scheduleWorkflowQueueDrain();
    }

    const status = result.event.status === "enqueued"
      ? 202
      : result.event.status === "rejected"
        ? 401
        : 500;

    return Response.json({
      trigger: {
        id: result.trigger.id,
        source: result.trigger.source,
        status: result.trigger.status,
      },
      event: result.event,
      workflowRunId: result.workflow?.run.id,
      queueJobId: result.queueJob?.id,
    }, { status });
  } catch (error) {
    return Response.json(
      { error: "Workflow trigger dispatch failed", message: error instanceof Error ? error.message : "Unknown error." },
      { status: 404 },
    );
  }
}
