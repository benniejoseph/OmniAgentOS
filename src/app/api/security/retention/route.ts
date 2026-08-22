import { z } from "zod";
import {
  hasDatabaseUrl,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import {
  checkWorkerRevision,
  workerRevisionErrorResponse,
} from "@/lib/operations/worker-request";
import {
  getRetentionPolicy,
  sweepExpiredSensitiveData,
} from "@/lib/security/retention";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const sweepSchema = z.object({
  scope: z.enum(["tenant", "all_tenants"]).default("tenant"),
}).strict();

async function GETHandler(request: Request) {
  try {
    await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "retention_policy",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json({
    policy: getRetentionPolicy(),
    backend: hasDatabaseUrl() ? "postgres" : "bounded_local",
    automaticSweep: hasDatabaseUrl(),
  });
}

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "retention");
  let body: unknown;
  try {
    body = await parseJsonBody(request, 8_192);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = sweepSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid retention sweep", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let context: Awaited<ReturnType<typeof authorizeRequest>>;
  try {
    context = await authorizeRequest({
      request,
      action: "manage.identity",
      resourceType: "retention_policy",
      metadata: { scope: parsed.data.scope },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  if (parsed.data.scope === "all_tenants" && context.role !== "system") {
    return Response.json(
      {
        error: "Forbidden",
        message: "Only trusted system automation may sweep all tenants.",
      },
      { status: 403 },
    );
  }
  if (parsed.data.scope === "all_tenants") {
    const revisionCheck = checkWorkerRevision(request);
    if (!revisionCheck.accepted) {
      return workerRevisionErrorResponse(revisionCheck);
    }
  }

  try {
    const result = await sweepExpiredSensitiveData({
      tenantId: context.tenantId,
      allTenants: parsed.data.scope === "all_tenants",
    });
    await recordRuntimeEventSafely({
      category: "security",
      action: "security.retention_sweep",
      route: "/api/security/retention",
      method: "POST",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "retention_policy",
      message: "Sensitive-data retention sweep completed.",
      metadata: {
        scope: result.scope,
        backend: result.backend,
        deleted: result.deleted,
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json({ result });
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "security",
      action: "security.retention_sweep.failed",
      route: "/api/security/retention",
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "retention_policy",
      message: "Sensitive-data retention sweep failed.",
      metadata: {
        error: error instanceof Error ? error.message : "Retention sweep failed.",
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Retention sweep failed." },
      { status: 500 },
    );
  }
}
