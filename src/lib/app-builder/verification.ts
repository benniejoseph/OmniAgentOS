import "server-only";

import type {
  AppBuilderBrowserEvidence,
  AppBuilderDeployment,
  AppBuilderDeterministicReadinessEvidence,
  AppBuilderVerification,
} from "@/lib/app-builder/contracts";

const RETIRED_BROWSER_SUMMARY =
  "Browser capture is retired. This legacy field is retained for historical records and is not used for readiness.";
const LEGACY_BROWSER_SUMMARY =
  "Legacy browser evidence is retained for history and is not used for new readiness decisions.";

type RetiredBrowserEvidence = Readonly<{
  status: "retired";
  captures: readonly [];
  legacyField: true;
  summary: string;
  replacement: AppBuilderDeterministicReadinessEvidence;
}>;

export function createBuilderCheckpointReadinessEvidence(
  checks: AppBuilderVerification["checks"],
): RetiredBrowserEvidence {
  const signals = (["lint", "typecheck"] as const).map((name) => ({
    name,
    status: checks.find((check) => check.command === name)?.status === "passed"
      ? "passed" as const
      : "failed" as const,
  }));
  const passedCount = signals.filter((signal) => signal.status === "passed").length;
  const status = passedCount === signals.length ? "passed" as const : "failed" as const;
  return retiredEvidence({
    mode: "deterministic",
    version: 1,
    phase: "checkpoint",
    status,
    summary: status === "passed"
      ? "Deterministic checkpoint verification passed: lint and typecheck passed."
      : `Deterministic checkpoint verification failed: ${passedCount} of ${signals.length} required checks passed.`,
    signals,
  });
}

export function createBuilderDeploymentReadinessEvidence(input: {
  phase: "preview" | "release";
  logs: AppBuilderDeployment["logs"];
  routeEvidence: AppBuilderDeployment["routeEvidence"];
}): RetiredBrowserEvidence {
  const logStatus = input.logs.status === "captured"
    ? "passed" as const
    : input.logs.status === "pending"
      ? "pending" as const
      : "failed" as const;
  const routeStatus = input.routeEvidence.status === "pending"
    ? "pending" as const
    : input.routeEvidence.status === "passed" &&
        input.routeEvidence.routes.length > 0 &&
        input.routeEvidence.routes.every((route) => route.status === "passed")
      ? "passed" as const
      : "failed" as const;
  const signals = [
    { name: "build_logs" as const, status: logStatus },
    { name: "route_smokes" as const, status: routeStatus },
  ];
  const status = signals.some((signal) => signal.status === "failed")
    ? "failed" as const
    : signals.every((signal) => signal.status === "passed")
      ? "passed" as const
      : "pending" as const;
  const passedRoutes = input.routeEvidence.routes.filter((route) => route.status === "passed").length;
  const label = input.phase === "preview" ? "preview" : "production";
  const summary = status === "passed"
    ? `Deterministic ${label} verification passed: build logs were captured and ${passedRoutes} route smoke${passedRoutes === 1 ? "" : "s"} passed.`
    : status === "pending"
      ? `Deterministic ${label} verification is pending build-log and route-smoke results.`
      : `Deterministic ${label} verification failed: build logs are ${input.logs.status} and ${passedRoutes} of ${input.routeEvidence.routes.length} route smokes passed.`;
  return retiredEvidence({
    mode: "deterministic",
    version: 1,
    phase: input.phase,
    status,
    summary,
    signals,
  });
}

export function createPendingBuilderReadinessEvidence(
  phase: "preview" | "release",
): RetiredBrowserEvidence {
  return createBuilderDeploymentReadinessEvidence({
    phase,
    logs: { status: "pending", eventCount: 0 },
    routeEvidence: { status: "pending", routes: [] },
  });
}

export function normalizeBuilderBrowserEvidence(value: unknown): AppBuilderBrowserEvidence {
  const record = asRecord(value);
  const rawStatus = typeof record.status === "string" ? record.status : "unavailable";
  const status = isBrowserEvidenceStatus(rawStatus) ? rawStatus : "unavailable";
  if (status === "retired") {
    const replacement = normalizeDeterministicEvidence(record.replacement);
    return {
      status,
      captures: [],
      legacyField: true,
      summary: typeof record.summary === "string" ? record.summary : RETIRED_BROWSER_SUMMARY,
      ...(replacement ? { replacement } : {}),
    };
  }
  return {
    status,
    captures: normalizeCaptures(record.captures),
    legacyField: true,
    summary: LEGACY_BROWSER_SUMMARY,
    ...(typeof record.errorCode === "string" ? { errorCode: record.errorCode } : {}),
  };
}

function retiredEvidence(
  replacement: AppBuilderDeterministicReadinessEvidence,
): RetiredBrowserEvidence {
  return Object.freeze({
    status: "retired",
    captures: [] as const,
    legacyField: true,
    summary: RETIRED_BROWSER_SUMMARY,
    replacement,
  });
}

function normalizeDeterministicEvidence(
  value: unknown,
): AppBuilderDeterministicReadinessEvidence | undefined {
  const record = asRecord(value);
  if (
    record.mode !== "deterministic" || record.version !== 1 ||
    !isReadinessPhase(record.phase) || !isReadinessStatus(record.status) ||
    typeof record.summary !== "string" || !Array.isArray(record.signals)
  ) return undefined;
  const signals = record.signals.flatMap((value) => {
    const signal = asRecord(value);
    return isReadinessSignalName(signal.name) && isReadinessStatus(signal.status)
      ? [{ name: signal.name, status: signal.status }]
      : [];
  });
  return {
    mode: "deterministic",
    version: 1,
    phase: record.phase,
    status: record.status,
    summary: record.summary,
    signals,
  };
}

function normalizeCaptures(value: unknown): AppBuilderBrowserEvidence["captures"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const capture = asRecord(item);
    if (capture.viewport !== "desktop" && capture.viewport !== "mobile") return [];
    if (
      typeof capture.screenshotSha256 !== "string" ||
      typeof capture.mimeType !== "string"
    ) return [];
    return [{
      viewport: capture.viewport,
      width: Number(capture.width),
      height: Number(capture.height),
      screenshotSha256: capture.screenshotSha256,
      mimeType: capture.mimeType,
      byteLength: Number(capture.byteLength),
    }];
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function isBrowserEvidenceStatus(value: string): value is AppBuilderBrowserEvidence["status"] {
  return ["pending", "captured", "unavailable", "failed", "retired"].includes(value);
}

function isReadinessPhase(value: unknown): value is AppBuilderDeterministicReadinessEvidence["phase"] {
  return value === "checkpoint" || value === "preview" || value === "release";
}

function isReadinessStatus(value: unknown): value is AppBuilderDeterministicReadinessEvidence["status"] {
  return value === "pending" || value === "passed" || value === "failed";
}

function isReadinessSignalName(
  value: unknown,
): value is AppBuilderDeterministicReadinessEvidence["signals"][number]["name"] {
  return value === "lint" || value === "typecheck" || value === "build_logs" || value === "route_smokes";
}
