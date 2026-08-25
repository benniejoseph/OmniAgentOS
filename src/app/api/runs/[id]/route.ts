import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { foldRunProjection } from "@/lib/events/projections";
import { listStreamEvents } from "@/lib/events/store";
import {
  cancelOperationJobByDedupeKey,
  getAgentResumeJobDedupeKey,
} from "@/lib/operations/job-queue";
import { publicAgentRun } from "@/lib/runs/public";
import {
  appendRunEvent,
  cancelAgentRun,
  getAgentRun,
  recordAgentRunFeedback,
} from "@/lib/runs/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

const feedbackSchema = z.object({
  verdict: z.enum(["useful", "needs_work"]),
  correction: z.string().trim().max(2_000).optional(),
}).strict();

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "agent_run",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get("replay") !== "true") {
    return Response.json({ run: publicAgentRun(run) });
  }

  // Stage-2 (EVENT_LOG.md): rebuild run state by folding `run:<id>`'s events —
  // verifiable proof the stored run matches its event history.
  const events = await listStreamEvents(`run:${id}`, { tenantId: auth.tenantId });
  const replayed = foldRunProjection(events);
  // Terminal states are fully determined by their run.done/run.error events;
  // waiting_approval/running/resuming carry continuation state not on the log.
  const consistent =
    replayed.status === run.status &&
    (replayed.status !== "completed" || replayed.response === run.response) &&
    (replayed.status !== "failed" || replayed.error === run.error);

  return Response.json({
    run: publicAgentRun(run),
    eventCount: events.length,
    replayed,
    consistent,
  });
}

async function PATCHHandler(
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
  const parsed = feedbackSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid run feedback", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "agent_run_feedback",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
  if (run.status !== "completed") {
    return Response.json(
      { error: "Feedback is available after a run completes." },
      { status: 409 },
    );
  }
  const updated = await recordAgentRunFeedback(id, parsed.data, {
    tenantId: auth.tenantId,
  });
  return Response.json({ run: publicAgentRun(updated || run) });
}

async function DELETEHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "agent_run",
      resourceId: id,
      metadata: { signal: "cancel" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  if (["completed", "failed", "canceled"].includes(run.status)) {
    return Response.json({ run: publicAgentRun(run), canceledJobs: 0 });
  }

  const reason = "Canceled by the operator.";
  const canceled = await cancelAgentRun(run.id, reason);
  if (!canceled) {
    const current = await getAgentRun(id, { tenantId: auth.tenantId });
    return Response.json({
      run: current ? publicAgentRun(current) : publicAgentRun(run),
      canceledJobs: 0,
    });
  }

  const executionId = run.continuation?.pendingToolCall.executionId;
  const canceledJobs = executionId
    ? await cancelOperationJobByDedupeKey(
        getAgentResumeJobDedupeKey(executionId),
        reason,
        { tenantId: auth.tenantId },
      )
    : [];
  await appendRunEvent(run.id, {
    type: "status",
    label: "Canceled",
    detail: reason,
  });
  const current = await getAgentRun(id, { tenantId: auth.tenantId });
  return Response.json({
    run: publicAgentRun(current || { ...run, status: "canceled", error: reason }),
    canceledJobs: canceledJobs.length,
  });
}
