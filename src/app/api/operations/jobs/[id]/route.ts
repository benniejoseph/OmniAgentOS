import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { serverErrorResponse } from "@/lib/http/errors";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import {
  discardQuarantinedOperationJob,
  getOperationJob,
  releaseQuarantinedOperationJob,
} from "@/lib/operations/job-queue";
import { projectReadableOperationJob } from "@/lib/operations/job-visibility";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const quarantineActionSchema = z.object({
  action: z.enum(["release", "discard"]),
  reason: z.string().trim().min(1).max(500).optional(),
}).strict();

const noStore = { "cache-control": "private, no-store" };

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "operation_job",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const job = await getOperationJob(id, {
    tenantId: securityContext.tenantId,
  });
  if (!job) {
    return Response.json({ error: "Operation job not found." }, { status: 404 });
  }
  const projectedJob = projectReadableOperationJob(
    job,
    readableOwnerActorIdsFor(securityContext),
  );
  if (!projectedJob) {
    return Response.json(
      { error: "Operation job not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  return Response.json(
    { job: projectedJob },
    { headers: { "cache-control": "private, no-store" } },
  );
}

/**
 * An operator's decision on a quarantined job: release it to run again, or
 * discard it. A job the operator cannot read is not found, as on GET.
 */
async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "operation-job-quarantine");
  const { id } = await context.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = quarantineActionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid quarantine action", details: parsed.error.flatten() },
      { status: 400, headers: noStore },
    );
  }

  let securityContext: SecurityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "operation_job",
      resourceId: id,
      metadata: { action: parsed.data.action },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const notFound = () => Response.json(
    { error: "Operation job not found." },
    { status: 404, headers: noStore },
  );
  const readableOwnerActorIds = readableOwnerActorIdsFor(securityContext);
  try {
    const job = await getOperationJob(id, { tenantId: securityContext.tenantId });
    if (!job || !projectReadableOperationJob(job, readableOwnerActorIds)) {
      return notFound();
    }
    const options = {
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
    };
    const decision = parsed.data.action === "release"
      ? await releaseQuarantinedOperationJob(id, options)
      : await discardQuarantinedOperationJob(id, {
          ...options,
          reason: parsed.data.reason,
        });
    const statusCode = decision.outcome === "absent"
      ? 404
      : decision.outcome === "released" || decision.outcome === "discarded"
        ? 200
        : 409;
    await recordRuntimeEventSafely({
      category: "workflow",
      action: `operations.job.${parsed.data.action}`,
      route: "/api/operations/jobs/[id]",
      method: "POST",
      statusCode,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      resourceType: "operation_job",
      resourceId: id,
      message: "Operation job quarantine decision recorded.",
      metadata: { action: parsed.data.action, outcome: decision.outcome },
    });
    if (decision.outcome === "absent") {
      return notFound();
    }
    if (decision.outcome === "not_quarantined") {
      return Response.json(
        { error: "Operation job is not quarantined." },
        { status: 409, headers: noStore },
      );
    }
    if (decision.outcome === "owned_by_run") {
      return Response.json(
        { error: "Cancel the run that owns this job to discard it." },
        { status: 409, headers: noStore },
      );
    }
    return Response.json(
      {
        outcome: decision.outcome,
        job: projectReadableOperationJob(decision.job, readableOwnerActorIds),
      },
      { headers: noStore },
    );
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "workflow",
      action: `operations.job.${parsed.data.action}.failed`,
      route: "/api/operations/jobs/[id]",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      resourceType: "operation_job",
      resourceId: id,
      message: "Operation job quarantine decision failed.",
      metadata: { action: parsed.data.action },
    });
    return serverErrorResponse(error, {
      message: "Operation job quarantine decision failed.",
      request,
    });
  }
}

function readableOwnerActorIdsFor(securityContext: SecurityContext) {
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    securityContext,
  );
  return new Set([
    securityContext.actorId,
    ...(actorBinding?.readableOwnerActorIds || []),
  ]);
}
