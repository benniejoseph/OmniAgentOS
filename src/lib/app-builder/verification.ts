import "server-only";

import { resolveBuilderCommandSpecification, safeBuilderRelativePath } from "@/lib/app-builder/contracts";
import type {
  AppBuilderBrowserEvidence,
  AppBuilderActivity,
  AppBuilderDeployment,
  AppBuilderDeterministicReadinessEvidence,
  AppBuilderVerification,
  AppBuilderCommandKind,
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
  if (checks.some((check) => check.command.startsWith("macos_"))) {
    return createNativeCheckpointReadinessEvidence(checks);
  }
  const focused = checks.some((check) => ["lint_focused", "test_focused", "typecheck_direct"].includes(check.command));
  const signals: AppBuilderDeterministicReadinessEvidence["signals"] = focused ? [
    { name: "lint", status: passingFocusedCheck(checks, "lint_focused") ? "passed" : "failed" },
    { name: "typecheck", status: passingFocusedCheck(checks, "typecheck_direct") ? "passed" : "failed" },
    { name: "regression_tests", status: passingFocusedCheck(checks, "test_focused", "regression") ? "passed" : "failed" },
    { name: "adjacent_tests", status: passingFocusedCheck(checks, "test_focused", "adjacent") ? "passed" : "failed" },
  ] : (["lint", "typecheck"] as const).map((name) => ({
    name, status: checks.find((check) => check.command === name)?.status === "passed" ? "passed" as const : "failed" as const,
  }));
  const passedCount = signals.filter((signal) => signal.status === "passed").length;
  const status = passedCount === signals.length ? "passed" as const : "failed" as const;
  return retiredEvidence({
    mode: "deterministic", version: 1, phase: "checkpoint", status,
    summary: status === "passed"
      ? focused ? "Focused checkpoint verification passed: selected lint, direct typecheck, regression and adjacent tests passed." : "Deterministic checkpoint verification passed: lint and typecheck passed."
      : `Deterministic checkpoint verification failed: ${passedCount} of ${signals.length} required checks passed.`,
    signals,
  });
}

function passingFocusedCheck(checks: AppBuilderVerification["checks"], command: AppBuilderVerification["checks"][number]["command"], purpose?: "regression" | "adjacent") {
  const matching = checks.filter((check) => check.command === command && check.purpose === purpose);
  if (matching.length !== 1) return false;
  const check = matching[0];
  if (check.status !== "passed" || check.exitCode !== 0 || !/^[a-f0-9]{64}$/.test(check.policySha256 || "")) return false;
  if (command !== "test_focused" && command !== "macos_test_focused") return true;
  const summary = check.testSummary;
  return Boolean(summary?.success && summary.totalTests > 0 && summary.passedTests === summary.totalTests && summary.failedTests === 0 && summary.pendingTests === 0 &&
    check.paths?.length && new Set(check.paths).size === check.paths.length && new Set(summary.executedPaths).size === summary.executedPaths.length &&
    summary.executedPaths.length === check.paths.length && summary.executedPaths.every((path) => check.paths!.includes(path)));
}

function createNativeCheckpointReadinessEvidence(checks: AppBuilderVerification["checks"]): RetiredBrowserEvidence {
  const nativeOnly = checks.length === 4 && checks.every((check) => check.command.startsWith("macos_"));
  const passing = (command: AppBuilderVerification["checks"][number]["command"], purpose?: "regression" | "adjacent") =>
    nativeOnly && passingFocusedCheck(checks, command, purpose);
  const signals: AppBuilderDeterministicReadinessEvidence["signals"] = [
    { name: "lint", status: passing("macos_analyze") ? "passed" : "failed" },
    { name: "typecheck", status: passing("macos_analyze") ? "passed" : "failed" },
    { name: "regression_tests", status: passing("macos_test_focused", "regression") ? "passed" : "failed" },
    { name: "adjacent_tests", status: passing("macos_test_focused", "adjacent") ? "passed" : "failed" },
    { name: "build_logs", status: passing("macos_build") ? "passed" : "failed" },
  ];
  const status = signals.every((signal) => signal.status === "passed") ? "passed" : "failed";
  return retiredEvidence({ mode: "deterministic", version: 1, phase: "checkpoint", status, signals,
    summary: status === "passed"
      ? "Mac checkpoint verification passed: analysis, focused and adjacent tests, and the unsigned Mac build passed on the trusted Mac validator."
      : "Mac checkpoint verification is incomplete or failed. Web checks cannot substitute for Mac evidence.",
  });
}

/** Reuse only the newest exact-policy receipt; a later failed run cannot revive an older pass. */
export function reuseBuilderCommandCheck(input: {
  activity: readonly AppBuilderActivity[];
  command: Extract<AppBuilderVerification["checks"][number]["command"], AppBuilderCommandKind>;
  paths?: readonly string[];
  purpose?: "regression" | "adjacent";
  workspaceSha256: string;
  now?: number;
}): AppBuilderVerification["checks"][number] {
  const specification = resolveBuilderCommandSpecification(input);
  const now = input.now ?? Date.now();
  const ordered = [...input.activity].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id));
  const receipt = ordered.find((entry) => entry.eventType === "app_builder.command.completed" && entry.detail.command === input.command &&
    asRecord(entry.detail.specification).policySha256 === specification.policySha256 && entry.detail.workspaceBeforeSha256 === input.workspaceSha256);
  if (!receipt || !Number.isFinite(Date.parse(receipt.occurredAt)) || Date.parse(receipt.occurredAt) > now || now - Date.parse(receipt.occurredAt) > 4 * 60 * 60_000) {
    throw new Error("The exact completed validation receipt is missing or expired. Run this check before verifying the checkpoint.");
  }
  const detail = receipt.detail;
  if (detail.workspaceUnchanged !== true || detail.workspaceAfterSha256 !== input.workspaceSha256) throw new Error("The latest validation receipt changed the workspace and cannot be reused.");
  const [check] = normalizeBuilderVerificationChecks([{
    command: input.command, paths: specification.paths.length ? specification.paths : undefined, purpose: input.purpose,
    policySha256: specification.policySha256, sourceActivityId: receipt.id,
    status: detail.exitCode === 0 ? "passed" : "failed", exitCode: detail.exitCode, durationMs: detail.durationMs,
    outputSha256: detail.outputSha256, testSummary: detail.testSummary,
  }]);
  if (!check || input.command === "test_focused" && !check.testSummary) throw new Error("The completed validation receipt has incomplete execution evidence.");
  return check;
}

export function normalizeBuilderVerificationChecks(value: unknown): AppBuilderVerification["checks"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    if (!["lint", "typecheck", "typecheck_direct", "lint_focused", "test_focused", "macos_analyze", "macos_test_focused", "macos_build"].includes(String(record.command)) ||
        !["passed", "failed"].includes(String(record.status)) || !Number.isSafeInteger(record.exitCode) ||
        typeof record.durationMs !== "number" || !Number.isFinite(record.durationMs) || record.durationMs < 0 ||
        !/^[a-f0-9]{64}$/.test(String(record.outputSha256))) return [];
    let paths: string[] | undefined;
    if (record.paths !== undefined) {
      if (!Array.isArray(record.paths) || record.paths.length > 30 || !record.paths.every((path) => typeof path === "string")) return [];
      try { paths = record.paths.map((path) => safeBuilderRelativePath(path)); } catch { return []; }
    }
    const rawSummary = asRecord(record.testSummary);
    const counts = [rawSummary.totalTests, rawSummary.passedTests, rawSummary.failedTests, rawSummary.pendingTests];
    const testSummary = counts.every((count) => Number.isSafeInteger(count) && Number(count) >= 0 && Number(count) <= 10_000) &&
      rawSummary.totalTests === Number(rawSummary.passedTests) + Number(rawSummary.failedTests) + Number(rawSummary.pendingTests) &&
      typeof rawSummary.success === "boolean" && Array.isArray(rawSummary.executedPaths) && rawSummary.executedPaths.length <= 30 &&
      rawSummary.executedPaths.every((path) => typeof path === "string" && paths?.includes(path))
      ? { totalTests: Number(rawSummary.totalTests), passedTests: Number(rawSummary.passedTests), failedTests: Number(rawSummary.failedTests), pendingTests: Number(rawSummary.pendingTests), executedPaths: rawSummary.executedPaths as string[], success: rawSummary.success } : undefined;
    return [{
      command: record.command as AppBuilderVerification["checks"][number]["command"],
      status: record.status as "passed" | "failed", exitCode: Number(record.exitCode), durationMs: record.durationMs,
      outputSha256: String(record.outputSha256),
      ...(paths?.length ? { paths } : {}),
      ...(record.purpose === "regression" || record.purpose === "adjacent" ? { purpose: record.purpose } : {}),
      ...(typeof record.policySha256 === "string" && /^[a-f0-9]{64}$/.test(record.policySha256) ? { policySha256: record.policySha256 } : {}),
      ...(typeof record.sourceActivityId === "string" ? { sourceActivityId: record.sourceActivityId } : {}),
      ...(testSummary ? { testSummary } : {}),
    }];
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
  return value === "lint" || value === "typecheck" || value === "build_logs" || value === "route_smokes" || value === "regression_tests" || value === "adjacent_tests";
}
