import { withDatabaseRequestScope } from "@/lib/db/client";
import { serverErrorResponse } from "@/lib/http/errors";
import {
  ERROR_BUDGET_EXCEPTION_MAX_CHARS,
  normalizeErrorBudgetException,
} from "@/lib/release/error-budget";
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
    const requestUrl = new URL(request.url);
    const force = requestUrl.searchParams.get("refresh") === "true";
    const requireActiveWorkerHeartbeats =
      requestUrl.searchParams.get("requireActiveWorker") === "true";
    const rawWorkerHeartbeatNotBefore = requestUrl.searchParams
      .get("workerHeartbeatNotBefore")
      ?.trim();
    const workerHeartbeatNotBeforeMs = rawWorkerHeartbeatNotBefore
      ? Date.parse(rawWorkerHeartbeatNotBefore)
      : Number.NaN;
    if (
      requireActiveWorkerHeartbeats &&
      (!rawWorkerHeartbeatNotBefore ||
        rawWorkerHeartbeatNotBefore.length > 80 ||
        !Number.isFinite(workerHeartbeatNotBeforeMs))
    ) {
      return Response.json(
        {
          error: "Active worker evidence requires a valid not-before timestamp.",
        },
        { status: 400 },
      );
    }
    const errorBudgetException = normalizeErrorBudgetException(
      requestUrl.searchParams.get("errorBudgetException"),
    );
    if (errorBudgetException === null) {
      return Response.json(
        {
          error: `An error budget exception is one line of at most ${ERROR_BUDGET_EXCEPTION_MAX_CHARS} characters.`,
        },
        { status: 400 },
      );
    }
    const report = await getReleaseEvidenceReport(context.tenantId, {
      force,
      expectedWorkerTarget: requestUrl.origin,
      requireActiveWorkerHeartbeats,
      workerHeartbeatNotBefore: requireActiveWorkerHeartbeats
        ? new Date(workerHeartbeatNotBeforeMs).toISOString()
        : undefined,
      errorBudgetException,
    });
    const budgetException = report.gates.find((gate) => gate.id === "agent_error_budget")
      ?.details.exception as { reason: string; applied: boolean } | undefined;
    if (budgetException?.applied) {
      // Who approved a release past a spent budget, and why.
      await recordRuntimeEventSafely({
        level: "warn",
        category: "security",
        action: "release.agent_error_budget.exception_applied",
        requestId: telemetry.requestId,
        correlationId: telemetry.correlationId,
        tenantId: context.tenantId,
        actorId: context.actorId,
        resourceType: "release_evidence",
        message: "Approved a release while its error budget is spent.",
        metadata: {
          reason: budgetException.reason,
          revision: report.deployment.commitSha,
          ...telemetry.syntheticMetadata,
          // A record of a decision, not traffic.
          sloExcluded: true,
        },
      });
    }
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
    return serverErrorResponse(error, { message: "Release evidence failed.", request });
  }
}
