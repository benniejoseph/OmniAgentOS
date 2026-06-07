import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getEvaluationEvidenceBundle } from "@/lib/evaluations/evidence";
import { listEvalReportSnapshots, saveEvalReportSnapshot } from "@/lib/evaluations/store";
import type {
  EvalReportSignature,
  EvalReportReleaseGate,
  EvalReportSigningKeyMetadata,
  EvalReportSnapshot,
  EvalReportVerificationResult,
} from "@/lib/evaluations/types";

const reportVersion = "2026-06-07" as const;
const reportVerifier = "omniagent-eval-report-v1" as const;
const reportAlgorithm = "HMAC-SHA256" as const;

type EvalReportSigningKey = EvalReportSigningKeyMetadata & {
  secret: string;
};

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
  const summary = {
    totalCases: evidence.run.summary.total,
    passed: evidence.run.summary.passed,
    failed: evidence.run.summary.failed,
    warnings: evidence.run.summary.warnings,
    passRate: evidence.run.summary.total
      ? evidence.run.summary.passed / evidence.run.summary.total
      : 0,
    averageLatencyMs: evidence.run.summary.averageLatencyMs,
    estimatedCostUsd: evidence.run.summary.estimatedCostUsd,
  };
  const auditFilters = {
    failed: evidence.caseEvidence.filter((item) => item.result.status === "fail").map((item) => item.result.caseId),
    warned: evidence.caseEvidence.filter((item) => item.result.status === "warn").map((item) => item.result.caseId),
    gated: evidence.caseEvidence
      .filter((item) => item.governance?.production.requiresMutationApproval)
      .map((item) => item.result.caseId),
  };
  const signingKey = getActiveReportSigningKey();
  const report = {
    schema: "omniagent.eval_report",
    reportVersion,
    generatedAt,
    generatedBy: actorId || "system",
    tenantId: tenantId || "default",
    run: evidence.run,
    summary,
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
      releaseGate: evaluateReportReleaseGate({
        runStatus: evidence.run.status,
        totalCases: summary.totalCases,
        failedCases: summary.failed,
        signingKey,
      }),
      filters: auditFilters,
      evidenceCounts: {
        cases: evidence.caseEvidence.length,
        runtimeEvents: evidence.events.length,
      },
    },
  };
  const signature = signReport(report, generatedAt, signingKey);

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

export function getReportSigningKeyMetadata(): EvalReportSigningKeyMetadata[] {
  return getReportSigningKeys().map((key) => ({
    keyId: key.keyId,
    algorithm: key.algorithm,
    status: key.status,
    source: key.source,
    verifier: key.verifier,
    notBefore: key.notBefore,
    notAfter: key.notAfter,
  }));
}

export function verifyEvalReportSnapshot(candidate: unknown): EvalReportVerificationResult {
  const verifiedAt = new Date().toISOString();
  const report = normalizeReportSnapshot(candidate);
  const errors: string[] = [];

  if (!report) {
    return {
      valid: false,
      digestValid: false,
      signatureValid: false,
      verifiedAt,
      errors: ["Invalid evaluation report snapshot."],
    };
  }

  const signature = report.signature;
  const canonical = canonicalStringify(report.report);
  const actualDigest = createHash("sha256").update(canonical).digest("base64url");
  const expectedDigest = signature.digest || signature.canonicalHash;
  const digestValid = Boolean(expectedDigest && safeCompare(expectedDigest, actualDigest));

  if (signature.algorithm !== reportAlgorithm) {
    errors.push(`Unsupported signature algorithm: ${signature.algorithm || "unknown"}.`);
  }

  if (signature.verifier !== reportVerifier) {
    errors.push(`Unsupported verifier: ${signature.verifier || "unknown"}.`);
  }

  if (!digestValid) {
    errors.push("Report digest does not match the canonical report payload.");
  }

  const candidateKeys = getReportSigningKeys().filter((key) => key.keyId === signature.keyId);
  if (!candidateKeys.length) {
    errors.push(`Unknown report signing key: ${signature.keyId || "missing"}.`);
  }

  const matchedKey = candidateKeys.find((key) =>
    safeCompare(createHmac("sha256", key.secret).update(canonical).digest("base64url"), signature.signature),
  );
  const signatureValid = Boolean(matchedKey);

  if (!signatureValid) {
    errors.push("Report HMAC signature could not be verified with the configured keyring.");
  }

  return {
    valid: digestValid && signatureValid && errors.length === 0,
    releaseGate: evaluateSnapshotReleaseGate(report, matchedKey),
    reportId: report.id,
    evalRunId: report.evalRunId,
    reportVersion: report.reportVersion,
    algorithm: signature.algorithm,
    verifier: signature.verifier,
    keyId: signature.keyId,
    matchedKeyId: matchedKey?.keyId,
    keyStatus: matchedKey?.status,
    digestValid,
    signatureValid,
    canonicalHash: actualDigest,
    expectedDigest,
    actualDigest,
    signedAt: signature.signedAt,
    verifiedAt,
    errors,
  };
}

function signReport(report: Record<string, unknown>, signedAt: string, key = getActiveReportSigningKey()): EvalReportSignature {
  const canonical = canonicalStringify(report);
  const digest = createHash("sha256").update(canonical).digest("base64url");
  const signature = createHmac("sha256", key.secret).update(canonical).digest("base64url");

  return {
    algorithm: reportAlgorithm,
    keyId: key.keyId,
    digest,
    signature,
    canonicalHash: digest,
    signedAt,
    verifier: reportVerifier,
    keyStatus: key.status,
    keySource: key.source,
    keyNotBefore: key.notBefore,
    keyNotAfter: key.notAfter,
  };
}

function evaluateSnapshotReleaseGate(
  snapshot: EvalReportSnapshot,
  signingKey?: EvalReportSigningKeyMetadata,
): EvalReportReleaseGate {
  const run = readRecord(snapshot.report.run);
  const summary = readRecord(snapshot.report.summary);

  return evaluateReportReleaseGate({
    runStatus: typeof run?.status === "string" ? run.status : "unknown",
    totalCases: Number(summary?.totalCases || 0),
    failedCases: Number(summary?.failed || 0),
    signingKey,
  });
}

function evaluateReportReleaseGate({
  runStatus,
  totalCases,
  failedCases,
  signingKey,
}: {
  runStatus: string;
  totalCases: number;
  failedCases: number;
  signingKey?: EvalReportSigningKeyMetadata;
}): EvalReportReleaseGate {
  const productionRuntime = isProductionRuntime();
  const checks = {
    completedRun: runStatus === "completed",
    nonEmptySuite: totalCases > 0,
    noFailedCases: failedCases === 0,
    activeSigningKey: signingKey?.status === "active",
    productionSigningKey: !productionRuntime || Boolean(signingKey && signingKey.source !== "local_development"),
  };
  const reasons = [
    checks.completedRun ? "" : "Evaluation run is not completed.",
    checks.nonEmptySuite ? "" : "Evaluation suite did not execute any cases.",
    checks.noFailedCases ? "" : "Evaluation suite has failed cases.",
    checks.activeSigningKey ? "" : "Report was not signed with an active key.",
    checks.productionSigningKey ? "" : "Production release gate requires a non-local signing key.",
  ].filter(Boolean);
  const warnings = [
    signingKey?.source === "cron_fallback" ? "Report is signed with CRON_SECRET fallback; configure OMNIAGENT_REPORT_SIGNING_SECRET for release gates." : "",
  ].filter(Boolean);

  return {
    approved: reasons.length === 0,
    status: reasons.length === 0 ? "passed" : "blocked",
    checks,
    warnings,
    reasons,
  };
}

function getActiveReportSigningKey(): EvalReportSigningKey {
  const keys = getReportSigningKeys();
  return keys.find((key) => key.status === "active") || keys[0]!;
}

function getReportSigningKeys(): EvalReportSigningKey[] {
  const keys: EvalReportSigningKey[] = [];

  if (process.env.OMNIAGENT_REPORT_SIGNING_SECRET) {
    addSigningKey(keys, {
      secret: process.env.OMNIAGENT_REPORT_SIGNING_SECRET,
      keyId: process.env.OMNIAGENT_REPORT_SIGNING_KEY_ID || "omniagent-report-signing-secret",
      status: "active",
      source: "primary_env",
    });
  }

  for (const key of readRotationSigningKeys()) {
    addSigningKey(keys, key);
  }

  if (!keys.some((key) => key.status === "active")) {
    const firstRotatedKey = keys.find((key) => key.source === "rotation_env");
    if (firstRotatedKey) {
      firstRotatedKey.status = "active";
    }
  }

  if (process.env.CRON_SECRET) {
    addSigningKey(keys, {
      secret: process.env.CRON_SECRET,
      keyId: "cron-secret-fallback",
      status: keys.length ? "fallback" : "active",
      source: "cron_fallback",
    });
  }

  if (!keys.length) {
    addSigningKey(keys, {
      secret: "omniagent-local-eval-report-signing-secret",
      keyId: "local-development",
      status: "local_development",
      source: "local_development",
    });
  }

  return keys;
}

function addSigningKey(
  keys: EvalReportSigningKey[],
  key: Omit<EvalReportSigningKey, "algorithm" | "verifier">,
) {
  const keyId = key.keyId.trim();
  const secret = key.secret.trim();
  if (!keyId || !secret || keys.some((item) => item.keyId === keyId)) {
    return;
  }

  keys.push({
    ...key,
    keyId,
    secret,
    algorithm: reportAlgorithm,
    verifier: reportVerifier,
  });
}

function readRotationSigningKeys(): Array<Omit<EvalReportSigningKey, "algorithm" | "verifier">> {
  const raw = process.env.OMNIAGENT_REPORT_SIGNING_KEYS?.trim();
  if (!raw) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    const entries = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object"
        ? Object.entries(parsed as Record<string, unknown>).map(([keyId, value]) =>
            value && typeof value === "object" && !Array.isArray(value)
              ? { keyId, ...(value as Record<string, unknown>) }
              : { keyId, secret: value }
          )
        : [];

    return entries
      .map((entry) => readRotationSigningKey(entry))
      .filter((entry): entry is Omit<EvalReportSigningKey, "algorithm" | "verifier"> => Boolean(entry));
  } catch {
    return [];
  }
}

function readRotationSigningKey(value: unknown): Omit<EvalReportSigningKey, "algorithm" | "verifier"> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const keyId = typeof record.keyId === "string" ? record.keyId : "";
  const secret = typeof record.secret === "string" ? record.secret : "";
  if (!keyId || !secret) {
    return null;
  }

  return {
    keyId,
    secret,
    status: record.status === "active" ? "active" : "verify_only",
    source: "rotation_env",
    notBefore: typeof record.notBefore === "string" ? record.notBefore : undefined,
    notAfter: typeof record.notAfter === "string" ? record.notAfter : undefined,
  };
}

function normalizeReportSnapshot(value: unknown): EvalReportSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  const signature = readRecord(record.signature) as EvalReportSignature | undefined;
  const report = readRecord(record.report);

  if (!signature || !report) {
    return null;
  }

  return {
    id: typeof record.id === "string" ? record.id : "submitted-report",
    evalRunId: typeof record.evalRunId === "string" ? record.evalRunId : readEvalRunId(report),
    format: record.format === "json_audit_bundle" ? record.format : "json_audit_bundle",
    reportVersion: record.reportVersion === reportVersion ? record.reportVersion : reportVersion,
    report,
    signature,
    tenantId: typeof record.tenantId === "string" ? record.tenantId : undefined,
    createdBy: typeof record.createdBy === "string" ? record.createdBy : undefined,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : new Date(0).toISOString(),
  };
}

function readEvalRunId(report: Record<string, unknown>) {
  const run = readRecord(report.run);
  return typeof run?.id === "string" ? run.id : "unknown";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeCompare(left: string | undefined, right: string | undefined) {
  if (!left || !right) {
    return false;
  }

  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortForCanonicalJson(value));
}

function isProductionRuntime() {
  return Boolean(process.env.NODE_ENV === "production" || process.env.VERCEL || process.env.VERCEL_ENV === "production");
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
