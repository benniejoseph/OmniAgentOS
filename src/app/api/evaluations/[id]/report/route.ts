import { z } from "zod";
import { createEvalReportSnapshot, getLatestEvalReportSnapshot, reportDownloadFilename } from "@/lib/evaluations/reports";
import { getEvalReportSnapshot, listEvalReportSnapshots } from "@/lib/evaluations/store";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { SecurityPolicyError } from "@/lib/security/context";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

const reportSchema = z.object({
  reason: z.string().min(1).max(500).optional(),
});

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const url = new URL(request.url);
  const reportId = url.searchParams.get("reportId");
  const download = ["1", "true", "latest"].includes((url.searchParams.get("download") || "").toLowerCase());
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 5), 1), 25);

  try {
    await authorizeRequest({
      request,
      action: "read",
      resourceType: "evaluation_report",
      resourceId: reportId || id,
      metadata: { evalRunId: id, reportId, download, limit },
    });

    if (reportId || download) {
      const report = reportId ? await getEvalReportSnapshot(reportId) : await getLatestEvalReportSnapshot(id);
      if (!report || report.evalRunId !== id) {
        return Response.json({ error: "Evaluation report not found." }, { status: 404 });
      }

      if (download) {
        return Response.json(report, {
          headers: {
            "Content-Disposition": `attachment; filename="${reportDownloadFilename(report)}"`,
            "X-Omni-Report-Signature": report.signature.signature,
          },
        });
      }

      return Response.json({ report });
    }

    const reports = await listEvalReportSnapshots(id, limit);
    return Response.json({
      reports,
      latest: reports[0],
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
  const telemetry = createRequestTelemetry(request, "evaluation-report");
  const { id } = await context.params;
  const body = await request.json().catch(() => ({}));
  const parsed = reportSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid evaluation report request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const securityContext = await authorizeRequest({
      request,
      action: "run.evaluation",
      resourceType: "evaluation_report",
      resourceId: id,
      metadata: {
        evalRunId: id,
        reason: parsed.data.reason,
      },
    });
    const report = await createEvalReportSnapshot({
      runId: id,
      actorId: securityContext.actorId,
      tenantId: securityContext.tenantId,
    });

    if (!report) {
      return Response.json({ error: "Evaluation run not found." }, { status: 404 });
    }

    await recordRuntimeEventSafely({
      category: "evaluation",
      action: "evaluation.report_created",
      route: `/api/evaluations/${id}/report`,
      method: "POST",
      statusCode: 201,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: securityContext.tenantId,
      actorId: securityContext.actorId,
      resourceType: "evaluation_report",
      resourceId: report.id,
      message: "Evaluation report snapshot created.",
      metadata: {
        evalRunId: id,
        reportId: report.id,
        reportVersion: report.reportVersion,
        format: report.format,
        signature: report.signature,
        reason: parsed.data.reason,
      },
    });

    return Response.json({ report }, { status: 201 });
  } catch (error) {
    if (error instanceof SecurityPolicyError) {
      return forbiddenResponse(error);
    }

    await recordRuntimeEventSafely({
      level: "error",
      category: "evaluation",
      action: "evaluation.report_failed",
      route: `/api/evaluations/${id}/report`,
      method: "POST",
      statusCode: 500,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType: "evaluation_report",
      resourceId: id,
      message: "Evaluation report snapshot failed.",
      metadata: { error: error instanceof Error ? error.message : "Evaluation report failed." },
    });
    return Response.json(
      { error: error instanceof Error ? error.message : "Evaluation report failed." },
      { status: 500 },
    );
  }
}
