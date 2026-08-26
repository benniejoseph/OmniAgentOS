import { withDatabaseRequestScope } from "@/lib/db/client";
import { getReleaseEvidenceReport } from "@/lib/release/evidence";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "release-evidence");

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "release_evidence",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  try {
    const force =
      new URL(request.url).searchParams.get("refresh") === "true";
    const report = await getReleaseEvidenceReport(context.tenantId, {
      force,
      expectedWorkerTarget: new URL(request.url).origin,
    });
    await recordRuntimeEventSafely({
      category: "api",
      action: "release.evidence.read",
      route: "/api/release/evidence",
      method: "GET",
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "release_evidence",
      message: "Read release evidence gate.",
      metadata: {
        status: report.releaseGate.status,
        approved: report.releaseGate.approved,
        failures: report.releaseGate.summary.failures,
        warnings: report.releaseGate.summary.warnings,
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json(
      { report },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "api",
      action: "release.evidence.failed",
      route: "/api/release/evidence",
      method: "GET",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "release_evidence",
      message: "Release evidence gate failed.",
      metadata: {
        error: error instanceof Error ? error.message : "Release evidence failed.",
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Release evidence failed." },
      { status: 500 },
    );
  }
}
