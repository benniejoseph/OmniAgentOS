import { z } from "zod";
import {
  defaultEvalCases,
  defaultEvaluationMaxSafetyMode,
  evaluateEvaluationGovernance,
  selectEvaluationCases,
  summarizeEvaluationGovernance,
  runEvaluationSuite,
} from "@/lib/evaluations/runner";
import { getEvalStats, listEvalRuns } from "@/lib/evaluations/store";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const evalRunSchema = z.object({
  suite: z.string().min(1).max(80).optional(),
  caseIds: z.array(z.string().min(1)).optional(),
  maxSafetyMode: z.enum(["read_only", "synthetic", "mutation_allowed"]).optional(),
  allowMutation: z.boolean().optional(),
  reason: z.string().min(1).max(500).optional(),
});

export async function GET(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "evaluation",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 20), 1), 100);
  return Response.json({
    cases: defaultEvalCases,
    governance: summarizeEvaluationGovernance(defaultEvalCases),
    defaults: {
      maxSafetyMode: defaultEvaluationMaxSafetyMode(),
    },
    runs: await listEvalRuns(limit, { tenantId: context.tenantId }),
    stats: await getEvalStats({ tenantId: context.tenantId }),
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
    const overrideReason = parsed.data.reason?.trim();
    const overrideEvidence = {
      requested: Boolean(parsed.data.allowMutation || overrideReason),
      allowMutation: Boolean(parsed.data.allowMutation),
      reasonProvided: Boolean(overrideReason),
      reason: overrideReason,
      role: context.role,
      actorId: context.actorId,
      tenantId: context.tenantId,
    };
    const maxSafetyMode = parsed.data.maxSafetyMode ??
      (parsed.data.caseIds?.length ? undefined : defaultEvaluationMaxSafetyMode());
    const selection = selectEvaluationCases({
      caseIds: parsed.data.caseIds,
      maxSafetyMode,
    });

    if (selection.unknownCaseIds.length) {
      return Response.json(
        {
          error: "Unknown evaluation case",
          unknownCaseIds: selection.unknownCaseIds,
        },
        { status: 400 },
      );
    }

    const governance = evaluateEvaluationGovernance({
      cases: selection.cases,
      role: context.role,
      allowMutation: parsed.data.allowMutation,
      reason: overrideReason,
    });

    if (!governance.allowed) {
      await recordRuntimeEventSafely({
        level: "warn",
        category: "evaluation",
        action: "evaluation.governance_blocked",
        route: "/api/evaluations",
        method: "POST",
        statusCode: 403,
        durationMs: Date.now() - startedAt,
        requestId: telemetry.requestId,
        correlationId: telemetry.correlationId,
        tenantId: context.tenantId,
        actorId: context.actorId,
        resourceType: "evaluation",
        message: "Evaluation run blocked by governance policy.",
        metadata: {
          failureType: "policy_block",
          suite: parsed.data.suite || "core",
          caseIds: selection.cases.map((evalCase) => evalCase.id),
          violations: governance.violations,
          summary: governance.summary,
          override: overrideEvidence,
        },
      });
      return Response.json(
        {
          error: "Evaluation governance blocked run",
          violations: governance.violations,
          governance: governance.summary,
          override: overrideEvidence,
        },
        { status: 403 },
      );
    }

    const detail = await runEvaluationSuite({
      suite: parsed.data.suite || "core",
      caseIds: selection.cases.map((evalCase) => evalCase.id),
      tenantId: context.tenantId,
    });
    if (!detail) {
      throw new Error("Evaluation run detail unavailable.");
    }

    const status = detail.run.status === "failed" ? 202 : 201;
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
      resourceId: detail.run.id,
      message: "Evaluation suite completed.",
      metadata: {
        suite: detail.run.suite,
        status: detail.run.status,
        total: detail.run.summary.total,
        passed: detail.run.summary.passed,
        failed: detail.run.summary.failed,
        warnings: detail.run.summary.warnings,
        caseIds: selection.cases.map((evalCase) => evalCase.id),
        governance: governance.summary,
        maxSafetyMode,
        override: overrideEvidence,
      },
    });
    return Response.json({ ...detail, governance: governance.summary, override: overrideEvidence }, { status });
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
