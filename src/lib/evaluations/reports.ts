import { createHash, createHmac } from "node:crypto";
import { getEvaluationEvidenceBundle } from "@/lib/evaluations/evidence";
import { listEvalReportSnapshots, saveEvalReportSnapshot } from "@/lib/evaluations/store";
import type { EvalReportSignature, EvalReportSnapshot } from "@/lib/evaluations/types";

const reportVersion = "2026-06-07" as const;

export async function createEvalReportSnapshot({
  runId,
  actorId,
  tenantId,
}: {
  runId: string;
  actorId?: string;
  tenantId?: string;
}) {
  const evidence = await getEvaluationEvidenceBundle(runId);

  if (!evidence) {
    return null;
  }

  const generatedAt = new Date().toISOString();
  const report = {
    schema: "omniagent.eval_report",
    reportVersion,
    generatedAt,
    generatedBy: actorId || "system",
    tenantId: tenantId || "default",
    run: evidence.run,
    summary: {
      totalCases: evidence.run.summary.total,
      passed: evidence.run.summary.passed,
      failed: evidence.run.summary.failed,
      warnings: evidence.run.summary.warnings,
      passRate: evidence.run.summary.total
        ? evidence.run.summary.passed / evidence.run.summary.total
        : 0,
      averageLatencyMs: evidence.run.summary.averageLatencyMs,
      estimatedCostUsd: evidence.run.summary.estimatedCostUsd,
    },
    governance: evidence.governance,
    override: evidence.override || null,
    cases: evidence.caseEvidence.map((item) => ({
      result: item.result,
      case: item.definition
        ? {
            id: item.definition.id,
            name: item.definition.name,
            description: item.definition.description,
            type: item.definition.type,
            expected: item.definition.expected,
          }
        : undefined,
      governance: item.governance,
    })),
    events: evidence.events.map((event) => ({
      id: event.id,
      level: event.level,
      action: event.action,
      statusCode: event.statusCode,
      durationMs: event.durationMs,
      correlationId: event.correlationId,
      requestId: event.requestId,
      tenantId: event.tenantId,
      actorId: event.actorId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      message: event.message,
      metadata: event.metadata,
      createdAt: event.createdAt,
    })),
    auditBundle: {
      regressionReady: evidence.run.status === "completed",
      filters: {
        failed: evidence.caseEvidence.filter((item) => item.result.status === "fail").map((item) => item.result.caseId),
        warned: evidence.caseEvidence.filter((item) => item.result.status === "warn").map((item) => item.result.caseId),
        gated: evidence.caseEvidence
          .filter((item) => item.governance?.production.requiresMutationApproval)
          .map((item) => item.result.caseId),
      },
      evidenceCounts: {
        cases: evidence.caseEvidence.length,
        runtimeEvents: evidence.events.length,
      },
    },
  };
  const signature = signReport(report, generatedAt);

  return saveEvalReportSnapshot({
    evalRunId: runId,
    format: "json_audit_bundle",
    reportVersion,
    report,
    signature,
    tenantId,
    createdBy: actorId,
  });
}

export async function getLatestEvalReportSnapshot(runId: string) {
  const reports = await listEvalReportSnapshots(runId, 1);
  return reports[0] || null;
}

export function reportDownloadFilename(report: EvalReportSnapshot) {
  return `omniagent-eval-${report.evalRunId}-${report.id}.json`;
}

function signReport(report: Record<string, unknown>, signedAt: string): EvalReportSignature {
  const canonical = canonicalStringify(report);
  const digest = createHash("sha256").update(canonical).digest("base64url");
  const { secret, keyId } = getReportSigningKey();
  const signature = createHmac("sha256", secret).update(canonical).digest("base64url");

  return {
    algorithm: "HMAC-SHA256",
    keyId,
    digest,
    signature,
    canonicalHash: digest,
    signedAt,
    verifier: "omniagent-eval-report-v1",
  };
}

function getReportSigningKey() {
  if (process.env.OMNIAGENT_REPORT_SIGNING_SECRET) {
    return {
      secret: process.env.OMNIAGENT_REPORT_SIGNING_SECRET,
      keyId: process.env.OMNIAGENT_REPORT_SIGNING_KEY_ID || "omniagent-report-signing-secret",
    };
  }

  if (process.env.CRON_SECRET) {
    return {
      secret: process.env.CRON_SECRET,
      keyId: "cron-secret-fallback",
    };
  }

  return {
    secret: "omniagent-local-eval-report-signing-secret",
    keyId: "local-development",
  };
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortForCanonicalJson(item)]),
    );
  }

  return value;
}
