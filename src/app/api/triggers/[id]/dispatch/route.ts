import { scheduleWorkflowQueueDrain } from "@/lib/workflows/queue";
import {
  dispatchWorkflowTrigger,
  WorkflowTriggerNotFoundError,
} from "@/lib/workflows/triggers";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { MAX_JSON_BODY_BYTES, readRequestTextLimited } from "@/lib/http/body";
import { getTrustedClientIp } from "@/lib/http/client-ip";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const clientIp = getTrustedClientIp(request);
  try {
    const rateLimit = await checkSharedRateLimit({
      key:
        clientIp === "unavailable"
          ? "trigger:dispatch:global-fallback"
          : `trigger:dispatch:ip:${clientIp}`,
      limit: clientIp === "unavailable" ? 2_000 : 600,
      windowMs: 60_000,
    });
    if (!rateLimit.allowed) {
      return Response.json(
        {
          error: "Too Many Requests",
          message: "This webhook endpoint is receiving too many requests.",
        },
        {
          status: 429,
          headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
        },
      );
    }
  } catch (error) {
    if (!(error instanceof RateLimitStoreUnavailableError)) {
      throw error;
    }
    return Response.json(
      {
        error: "Webhook temporarily unavailable",
        message: "The webhook cannot be safely accepted right now. Retry shortly.",
      },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
  const body = await readRequestTextLimited(request, MAX_JSON_BODY_BYTES);
  if (body.truncated) {
    return Response.json(
      {
        error: "Payload Too Large",
        message: `Trigger payloads must be ${MAX_JSON_BODY_BYTES} bytes or smaller.`,
      },
      { status: 413 },
    );
  }

  try {
    const result = await dispatchWorkflowTrigger({
      triggerId: id,
      bodyText: body.text,
      headers: request.headers,
    });

    if (result.workflow) {
      scheduleWorkflowQueueDrain(undefined, result.trigger.tenantId);
    }

    const status = result.event.status === "enqueued" || result.event.status === "accepted"
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
      replayed: result.replayed || false,
    }, { status });
  } catch (error) {
    console.warn(
      "Workflow trigger dispatch failed.",
      error instanceof Error ? error.name : "Unknown error.",
    );
    return Response.json(
      {
        error: "Workflow trigger dispatch failed",
        message:
          error instanceof WorkflowTriggerNotFoundError
            ? "The workflow trigger was not found."
            : "The trigger could not be accepted safely. Retry shortly.",
      },
      {
        status: error instanceof WorkflowTriggerNotFoundError ? 404 : 503,
        headers:
          error instanceof WorkflowTriggerNotFoundError
            ? undefined
            : { "Retry-After": "30" },
      },
    );
  }
}
