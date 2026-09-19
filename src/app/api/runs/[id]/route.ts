import { createHash } from "node:crypto";
import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { cancelRunService, recordRunFeedbackService, showRunService } from "@/lib/app-services/runs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { foldRunProjection } from "@/lib/events/projections";
import { listStreamEvents } from "@/lib/events/store";
import { listRunGeneratedArtifacts } from "@/lib/runs/generated-artifacts";
import { listRunMediaArtifacts } from "@/lib/runs/media-artifacts";
import { listRunWorkspaceArtifacts } from "@/lib/runs/workspace-artifacts";
import { publicAgentRun } from "@/lib/runs/public";
import { getAgentRun } from "@/lib/runs/store";
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

  let result;
  try {
    result = await showRunService(createAppServiceCaller({ context: auth }), { runId: id });
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "Run not found.") throw error;
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  if (!result.data.run) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }

  const run = await getAgentRun(id, { tenantId: auth.tenantId });
  if (!run) return Response.json({ error: "Run not found." }, { status: 404 });
  // Media is consumed with the terminal result. Avoid rebuilding a potentially
  // long event projection during the three-second active-run polling loop.
  const terminal = ["completed", "failed", "canceled"].includes(run.status);
  const owner = { tenantId: auth.tenantId, actorId: run.ownerActorId };
  const artifactProjection = terminal
    ? await terminalArtifactProjections(run.id, owner)
    : {
        mediaArtifacts: [],
        fileArtifacts: [],
        fileArtifactState: "pending" as const,
        workspaceArtifacts: [],
        // A running task is not necessarily creating a Google file. Avoid a
        // misleading Workspace spinner until governed create evidence exists.
        workspaceArtifactState: "none" as const,
      };
  const {
    mediaArtifacts,
    fileArtifacts,
    fileArtifactState,
    workspaceArtifacts,
    workspaceArtifactState,
  } = artifactProjection;

  const url = new URL(request.url);
  if (url.searchParams.get("replay") !== "true") {
    return Response.json({
      ...result.data,
      mediaArtifacts,
      fileArtifacts,
      fileArtifactState,
      workspaceArtifacts,
      workspaceArtifactState,
      serviceReceipt: result.receipt,
    });
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
    mediaArtifacts,
    fileArtifacts,
    fileArtifactState,
    workspaceArtifacts,
    workspaceArtifactState,
    eventCount: events.length,
    replayed,
    consistent,
  });
}

async function terminalArtifactProjections(
  runId: string,
  owner: { tenantId: string; actorId: string },
) {
  const [mediaResult, fileResult, workspaceResult] = await Promise.allSettled([
    listRunMediaArtifacts(runId, owner),
    listRunGeneratedArtifacts(runId, owner),
    listRunWorkspaceArtifacts(runId, owner),
  ]);
  const mediaArtifacts = mediaResult.status === "fulfilled"
    ? mediaResult.value
    : [];
  const workspaceArtifacts = workspaceResult.status === "fulfilled"
    ? workspaceResult.value
    : [];
  const workspaceArtifactState = workspaceResult.status === "rejected"
    ? "unavailable" as const
    : workspaceArtifacts.length
      ? "ready" as const
      : "none" as const;
  if (workspaceResult.status === "rejected") {
    console.error(
      "Google Workspace artifact projection failed.",
      { runId, error: workspaceResult.reason instanceof Error ? workspaceResult.reason.name : "UnknownError" },
    );
  }
  if (fileResult.status === "rejected") {
    console.error(
      "Generated artifact projection failed.",
      { runId, error: fileResult.reason instanceof Error ? fileResult.reason.name : "UnknownError" },
    );
    return {
      mediaArtifacts,
      fileArtifacts: [],
      fileArtifactState: "unavailable" as const,
      workspaceArtifacts,
      workspaceArtifactState,
    };
  }
  return {
    mediaArtifacts,
    fileArtifacts: fileResult.value,
    fileArtifactState: fileResult.value.length
      ? "ready" as const
      : "none" as const,
    workspaceArtifacts,
    workspaceArtifactState,
  };
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

  try {
    const result = await recordRunFeedbackService(
      createRequestMutationAppServiceCaller(request, auth, { purpose: "run.feedback", causationId: id }),
      { runId: id, ...parsed.data },
    );
    return result.data.run
      ? Response.json({ ...result.data, serviceReceipt: result.receipt })
      : Response.json({ error: "Run not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "Feedback is available only after a run completes.") {
      return Response.json({ error: "Feedback is available after a run completes." }, { status: 409 });
    }
    if (error instanceof Error && error.message === "Run not found.") return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }
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
      nativeMutationCapability: "evidence.cancel",
      metadata: { signal: "cancel" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const reason = "Canceled by the operator.";
  try {
    const result = await cancelRunService(
      createRequestMutationAppServiceCaller(request, auth, { purpose: "run.cancel", causationId: id }),
      { runId: id, reason },
    );
    return result.data.run
      ? Response.json({ ...result.data, serviceReceipt: result.receipt })
      : Response.json({ error: "Run not found." }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && error.message === "Run not found.") return Response.json({ error: error.message }, { status: 404 });
    throw error;
  }
}
