import { z } from "zod";
import {
  getLatestEvalReportSnapshot,
  getReportSigningKeyMetadata,
  verifyEvalReportSnapshot,
} from "@/lib/evaluations/reports";
import { getEvalReportSnapshot } from "@/lib/evaluations/store";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const verifySchema = z.object({
  reportId: z.string().min(1).optional(),
  report: z.unknown().optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "evaluation-report-verify");
  const { id } = await context.params;
  const url = new URL(request.url);
  const reportId = url.searchParams.get("reportId") || undefined;

  try {
    const securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "evaluation_report",
      resourceId: reportId || id,
      metadata: { evalRunId: id, reportId, verifier: true },
    });
    const report = reportId
      ? await getEvalReportSnapshot(reportId, { tenantId: securityContext.tenantId })
      : await getLatestEvalReportSnapshot(id, { tenantId: securityContext.tenantId });

    if (!report || report.evalRunId !== id) {
      return Response.json({ error: "Evaluation report not found." }, { status: 404 });
    }

    const verification = verifyEvalReportSnapshot(report);
    await recordVerificationEvent({
      request,
      startedAt,
      telemetry,
      actorId: securityContext.actorId,
      tenantId: securityContext.tenantId,
      evalRunId: id,
      reportId: report.id,
      source: "stored",
      valid: verification.valid,
    });

    return Response.json({
      verification,
      keyring: getReportSigningKeyMetadata(),
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "evaluation-report-verify");
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = verifySchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid evaluation report verification request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "evaluation_report",
      resourceId: parsed.data.reportId || id,
      metadata: {
        evalRunId: id,
        reportId: parsed.data.reportId,
        submittedReport: Boolean(parsed.data.report),
        verifier: true,
      },
    });
    const report = parsed.data.report
      ? parsed.data.report
      : parsed.data.reportId
        ? await getEvalReportSnapshot(parsed.data.reportId, { tenantId: securityContext.tenantId })
        : await getLatestEvalReportSnapshot(id, { tenantId: securityContext.tenantId });
    const verification = verifyEvalReportSnapshot(report);

    if (!verification.reportId && !parsed.data.report) {
      return Response.json({ error: "Evaluation report not found." }, { status: 404 });
    }

    if (verification.evalRunId && verification.evalRunId !== id) {
      return Response.json(
        {
          error: "Evaluation report does not belong to this run.",
          verification,
          keyring: getReportSigningKeyMetadata(),
        },
        { status: 400 },
      );
    }

    await recordVerificationEvent({
      request,
      startedAt,
      telemetry,
      actorId: securityContext.actorId,
      tenantId: securityContext.tenantId,
      evalRunId: id,
      reportId: verification.reportId,
      source: parsed.data.report ? "submitted" : "stored",
      valid: verification.valid,
    });

    return Response.json({
      verification,
      keyring: getReportSigningKeyMetadata(),
    });
  } catch (error) {
    if (error instanceof SecurityPolicyError) {
      return forbiddenResponse(error);
    }

    return Response.json(
      { error: error instanceof Error ? error.message : "Evaluation report verification failed." },
      { status: 500 },
    );
  }
}

async function recordVerificationEvent({
  request,
  startedAt,
  telemetry,
  actorId,
  tenantId,
  evalRunId,
  reportId,
  source,
  valid,
}: {
  request: Request;
  startedAt: number;
  telemetry: ReturnType<typeof createRequestTelemetry>;
  actorId: string;
  tenantId: string;
  evalRunId: string;
  reportId?: string;
  source: "stored" | "submitted";
  valid: boolean;
}) {
  await recordRuntimeEventSafely({
    category: "evaluation",
    action: "evaluation.report_verified",
    route: new URL(request.url).pathname,
    method: request.method,
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    requestId: telemetry.requestId,
    correlationId: telemetry.correlationId,
    tenantId,
    actorId,
    resourceType: "evaluation_report",
    resourceId: reportId || evalRunId,
    message: valid ? "Evaluation report signature verified." : "Evaluation report signature verification failed.",
    metadata: {
      evalRunId,
      reportId,
      source,
      valid,
    },
  });
}
