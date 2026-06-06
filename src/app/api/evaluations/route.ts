import { z } from "zod";
import { defaultEvalCases, runEvaluationSuite } from "@/lib/evaluations/runner";
import { getEvalStats, listEvalRuns } from "@/lib/evaluations/store";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const evalRunSchema = z.object({
  suite: z.string().min(1).max(80).optional(),
  caseIds: z.array(z.string().min(1)).optional(),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  return Response.json({
    cases: defaultEvalCases,
    runs: await listEvalRuns(limit),
    stats: await getEvalStats(),
  });
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "evaluation");
  const body = await request.json().catch(() => ({}));
  const parsed = evalRunSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid evaluation run request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const context = await authorizeRequest({
      request,
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: parsed.data,
    });
    const detail = await runEvaluationSuite({
      suite: parsed.data.suite || "core",
      caseIds: parsed.data.caseIds,
    });
    const status = detail?.run.status === "failed" ? 202 : 201;
    await recordRuntimeEventSafely({
      category: "evaluation",
      action: "evaluation.run",
      route: "/api/evaluations",
      method: "POST",
      statusCode: status,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "evaluation",
      resourceId: detail?.run.id,
      message: "Evaluation suite completed.",
      metadata: {
        suite: detail?.run.suite,
        status: detail?.run.status,
        total: detail?.run.summary.total,
        passed: detail?.run.summary.passed,
        failed: detail?.run.summary.failed,
        warnings: detail?.run.summary.warnings,
        caseIds: parsed.data.caseIds || [],
      },
    });
    return Response.json(detail, { status });
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) {
      await recordRuntimeEventSafely({
        level: "error",
        category: "evaluation",
        action: "evaluation.run_failed",
        route: "/api/evaluations",
        method: "POST",
        statusCode: 500,
        durationMs: Date.now() - startedAt,
        requestId: telemetry.requestId,
        correlationId: telemetry.correlationId,
        resourceType: "evaluation",
        message: "Evaluation suite failed.",
        metadata: { error: error instanceof Error ? error.message : "Evaluation failed." },
      });
      return Response.json(
        { error: error instanceof Error ? error.message : "Evaluation failed." },
        { status: 500 },
      );
    }
    return forbiddenResponse(error);
  }
}
