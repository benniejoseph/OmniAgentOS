import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import {
  defaultEvalCases,
  defaultEvaluationMaxSafetyMode,
  evaluateEvaluationGovernance,
  selectEvaluationCases,
  summarizeEvaluationGovernance,
} from "@/lib/evaluations/runner";
import { getEvalStats, listEvalRuns } from "@/lib/evaluations/store";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueEvaluationJob,
} from "@/lib/operations/background-jobs";
import {
  listOperationJobs,
  projectOperationJobStatus,
} from "@/lib/operations/job-queue";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const evalRunSchema = z.object({
  suite: z.string().min(1).max(80).optional(),
  caseIds: z.array(z.string().min(1).max(120)).max(200).optional(),
  maxSafetyMode: z.enum(["read_only", "synthetic", "mutation_allowed"]).optional(),
  allowMutation: z.boolean().optional(),
  reason: z.string().min(1).max(500).optional(),
}).strict();

async function GETHandler(request: Request) {
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
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 20, {
    max: 100,
  });
  const [runs, stats, jobs] = await Promise.all([
    listEvalRuns(limit, { tenantId: context.tenantId }),
    getEvalStats({ tenantId: context.tenantId }),
    listOperationJobs(limit, {
      tenantId: context.tenantId,
      type: "evaluation.run",
    }),
  ]);
  return Response.json({
    cases: defaultEvalCases,
    governance: summarizeEvaluationGovernance(defaultEvalCases),
    defaults: {
      maxSafetyMode: defaultEvaluationMaxSafetyMode(),
    },
    runs,
    stats,
    jobs: jobs.map(projectOperationJobStatus),
  });
}

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "evaluation");
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
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
      metadata: {
        suite: parsed.data.suite,
        caseCount: parsed.data.caseIds?.length || 0,
        maxSafetyMode: parsed.data.maxSafetyMode,
        allowMutation: Boolean(parsed.data.allowMutation),
        reasonProvided: Boolean(parsed.data.reason),
      },
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
          ...telemetry.syntheticMetadata,
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

    const job = await enqueueEvaluationJob({
      tenantId: context.tenantId,
      idempotencyKey:
        request.headers.get("idempotency-key")?.trim().slice(0, 200) ||
        undefined,
      request: {
        suite: parsed.data.suite || "core",
        caseIds: selection.cases.map((evalCase) => evalCase.id),
      },
    });
    const status = 202;
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
      resourceId: job.id,
      message: "Evaluation suite queued for background processing.",
      metadata: {
        suite: parsed.data.suite || "core",
        status: job.status,
        caseIds: selection.cases.map((evalCase) => evalCase.id),
        governance: governance.summary,
        maxSafetyMode,
        override: overrideEvidence,
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json(
      {
        job: projectOperationJobStatus(job),
        governance: governance.summary,
        override: overrideEvidence,
      },
      {
        status,
        headers: {
          location: `/api/operations/jobs/${job.id}`,
          "retry-after": "2",
          "cache-control": "private, no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof BackgroundJobIdempotencyConflictError) {
      return Response.json({ error: error.message }, { status: 409 });
    }
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
        metadata: {
          error: error instanceof Error ? error.message : "Evaluation failed.",
          ...telemetry.syntheticMetadata,
        },
      });
      return Response.json(
        { error: error instanceof Error ? error.message : "Evaluation failed." },
        { status: 500 },
      );
    }
    return forbiddenResponse(error);
  }
}
