import { createHash } from "node:crypto";
import { z } from "zod";
import { getMcpGovernedTool, getOpenApiGovernedTool } from "@/lib/connectors/governed-tools";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { foldRunProjection } from "@/lib/events/projections";
import { listStreamEvents } from "@/lib/events/store";
import { syncMissionExecutorSafely } from "@/lib/missions/runtime";
import { applyRunMemoryFeedback } from "@/lib/memory/store";
import {
  cancelOperationJobByDedupeKey,
  getAgentExecuteJobDedupeKey,
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
import { getGovernedTool } from "@/lib/tools/registry";
import { actionClassFor, recordActionOutcome } from "@/lib/trust/ledger";

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
  const response = run.response || "";
  const responseMatches = replayed.responseSha256
    ? replayed.responseLength === response.length &&
      replayed.responseSha256 === createHash("sha256").update(response).digest("hex")
    : replayed.response === response;
  const runError = run.error || "";
  const errorMatches = replayed.errorSha256
    ? replayed.errorLength === runError.length &&
      replayed.errorSha256 === createHash("sha256").update(runError).digest("hex")
    : replayed.error === run.error;
  // Terminal states are fully determined by run.done/run.error/run.canceled;
  // waiting_approval/running/resuming carry continuation state not on the log.
  const consistent =
    replayed.status === run.status &&
    (replayed.status !== "completed" || responseMatches) &&
    (replayed.status !== "failed" || errorMatches);

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
  const affectedMemoryIds = await applyRunMemoryFeedback(id, parsed.data.verdict, {
    tenantId: auth.tenantId,
  });
  const enteredNeedsWork = parsed.data.verdict === "needs_work" &&
    run.feedback?.verdict !== "needs_work";
  const demotedCapabilities = enteredNeedsWork
    ? await demoteRunCapabilities(id, auth.tenantId)
    : [];
  return Response.json({
    run: publicAgentRun(updated || run),
    learning: {
      disposition: parsed.data.verdict === "useful" ? "reinforced" : "quarantined",
      affectedMemories: affectedMemoryIds.length,
      demotedCapabilities,
    },
  });
}

async function demoteRunCapabilities(runId: string, tenantId: string) {
  const events = await listStreamEvents(`run:${runId}`, { tenantId, limit: 2_000 });
  const toolIds = [...new Set(events.flatMap((event) => {
    if (event.type !== "run.tool" || event.payload.status !== "executed") return [];
    const toolId = typeof event.payload.toolId === "string" ? event.payload.toolId : "";
    return toolId ? [toolId] : [];
  }))].slice(0, 20);
  const demoted: string[] = [];
  for (const toolId of toolIds) {
    const tool = getGovernedTool(toolId) ||
      await getMcpGovernedTool(toolId, { tenantId }) ||
      await getOpenApiGovernedTool(toolId, { tenantId });
    if (!tool || (!tool.approvalRequired && tool.riskLevel < 2)) continue;
    await recordActionOutcome({
      actionClass: actionClassFor(tool.id),
      toolId: tool.id,
      tenantId,
      kind: "rejected",
      reversible: tool.reversible === true,
      riskLevel: tool.riskLevel,
      humanApproved: false,
    });
    demoted.push(tool.id);
  }
  return demoted;
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
    let canceledJobs = 0;
    if (run.status === "canceled") {
      canceledJobs = (await cancelOperationJobByDedupeKey(
        getAgentExecuteJobDedupeKey(run.id),
        run.error || "Canceled by the operator.",
        { tenantId: auth.tenantId },
      )).length;
      await ensureRunCancellationEvent(
        run.id,
        run.error || "Canceled by the operator.",
        auth.tenantId,
        run.continuation,
      );
      await syncMissionExecutorSafely({
        executorType: "agent_run",
        executorId: run.id,
        status: "canceled",
      }, { tenantId: auth.tenantId, actorId: auth.actorId });
    }
    return Response.json({ run: publicAgentRun(run), canceledJobs });
  }

  const reason = "Canceled by the operator.";
  const executionId = run.continuation?.pendingToolCall.executionId;
  const canceled = await cancelAgentRun(run.id, reason);
  if (!canceled) {
    const current = await getAgentRun(id, { tenantId: auth.tenantId });
    if (current?.status === "canceled") {
      const canceledJobs = executionId
        ? await cancelOperationJobByDedupeKey(
            getAgentResumeJobDedupeKey(executionId),
            reason,
            { tenantId: auth.tenantId },
          )
        : [];
      canceledJobs.push(...await cancelOperationJobByDedupeKey(
        getAgentExecuteJobDedupeKey(current.id),
        reason,
        { tenantId: auth.tenantId },
      ));
      await ensureRunCancellationEvent(
        current.id,
        current.error || reason,
        auth.tenantId,
        run.continuation,
      );
      await syncMissionExecutorSafely({
        executorType: "agent_run",
        executorId: current.id,
        status: "canceled",
      }, { tenantId: auth.tenantId, actorId: auth.actorId });
      return Response.json({
        run: publicAgentRun(current),
        canceledJobs: canceledJobs.length,
      });
    }
    return Response.json({
      run: current ? publicAgentRun(current) : publicAgentRun(run),
      canceledJobs: 0,
    });
  }

  const canceledJobs = executionId
    ? await cancelOperationJobByDedupeKey(
        getAgentResumeJobDedupeKey(executionId),
        reason,
        { tenantId: auth.tenantId },
    )
    : [];
  canceledJobs.push(...await cancelOperationJobByDedupeKey(
    getAgentExecuteJobDedupeKey(run.id),
    reason,
    { tenantId: auth.tenantId },
  ));
  await ensureRunCancellationEvent(
    run.id,
    reason,
    auth.tenantId,
    run.continuation,
  );
  await syncMissionExecutorSafely({
    executorType: "agent_run",
    executorId: run.id,
    status: "canceled",
  }, { tenantId: auth.tenantId, actorId: auth.actorId });
  const current = await getAgentRun(id, { tenantId: auth.tenantId });
  return Response.json({
    run: publicAgentRun(current || { ...run, status: "canceled", error: reason }),
    canceledJobs: canceledJobs.length,
  });
}

async function ensureRunCancellationEvent(
  runId: string,
  message: string,
  tenantId: string,
  continuation?: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>["continuation"],
) {
  const events = await listStreamEvents(`run:${runId}`, { tenantId });
  if (events.some((event) => event.type === "run.canceled")) return;
  await appendRunEvent(runId, { type: "canceled", message }, {
    tenantId,
    executionScope: continuation?.executionScope,
    runContractEnvelope: continuation?.runContractEnvelope,
  });
}
