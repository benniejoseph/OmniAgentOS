import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createBuilderCheckpointReadinessEvidence,
  createBuilderDeploymentReadinessEvidence,
  createPendingBuilderReadinessEvidence,
  normalizeBuilderBrowserEvidence,
} from "@/lib/app-builder/verification";

describe("App Builder deterministic readiness evidence", () => {
  it("passes a checkpoint only when both fixed checks pass", () => {
    const result = createBuilderCheckpointReadinessEvidence([
      check("lint", "passed"),
      check("typecheck", "passed"),
    ]);

    expect(result).toMatchObject({
      status: "retired",
      captures: [],
      legacyField: true,
      replacement: {
        mode: "deterministic",
        phase: "checkpoint",
        status: "passed",
        signals: [
          { name: "lint", status: "passed" },
          { name: "typecheck", status: "passed" },
        ],
      },
    });
  });

  it("fails closed when a required checkpoint check is absent or failed", () => {
    const result = createBuilderCheckpointReadinessEvidence([
      check("lint", "passed"),
    ]);

    expect(result.replacement.status).toBe("failed");
    expect(result.replacement.summary).toContain("1 of 2 required checks passed");
    expect(result.captures).toEqual([]);
  });

  it("uses only build logs and non-empty passing route smokes for preview readiness", () => {
    const result = createBuilderDeploymentReadinessEvidence({
      phase: "preview",
      logs: { status: "captured", eventCount: 9, sha256: "a".repeat(64) },
      routeEvidence: {
        status: "passed",
        routes: [{ path: "/", status: "passed", statusCode: 200, durationMs: 21 }],
      },
    });

    expect(result.replacement).toMatchObject({
      phase: "preview",
      status: "passed",
      signals: [
        { name: "build_logs", status: "passed" },
        { name: "route_smokes", status: "passed" },
      ],
    });
    expect(result.replacement.summary).toContain("1 route smoke passed");
  });

  it("does not treat an empty route result or unavailable logs as passing", () => {
    const emptyRoutes = createBuilderDeploymentReadinessEvidence({
      phase: "release",
      logs: { status: "captured", eventCount: 1 },
      routeEvidence: { status: "passed", routes: [] },
    });
    const unavailableLogs = createBuilderDeploymentReadinessEvidence({
      phase: "release",
      logs: { status: "unavailable", eventCount: 0 },
      routeEvidence: { status: "passed", routes: [{ path: "/", status: "passed", durationMs: 10 }] },
    });

    expect(emptyRoutes.replacement.status).toBe("failed");
    expect(unavailableLogs.replacement.status).toBe("failed");
  });

  it("records pending work as retired browser evidence with a deterministic replacement", () => {
    const result = createPendingBuilderReadinessEvidence("preview");

    expect(result).toMatchObject({
      status: "retired",
      captures: [],
      replacement: { phase: "preview", status: "pending" },
    });
  });

  it("keeps historical browser evidence readable and labels it legacy", () => {
    const result = normalizeBuilderBrowserEvidence({
      status: "captured",
      captures: [{
        viewport: "desktop",
        width: 1440,
        height: 960,
        screenshotSha256: "b".repeat(64),
        mimeType: "image/png",
        byteLength: 123,
      }],
    });

    expect(result).toMatchObject({
      status: "captured",
      legacyField: true,
      captures: [{ viewport: "desktop", width: 1440 }],
    });
    expect(result.summary).toContain("not used for new readiness decisions");
  });

  it("has no App Builder runtime dependency on the retired browser connector", () => {
    const verificationSource = readFileSync("src/lib/app-builder/verification.ts", "utf8");
    const serviceSource = readFileSync("src/lib/app-services/app-builder.ts", "utf8");
    const runtimeSource = `${verificationSource}\n${serviceSource}`;

    expect(runtimeSource).not.toContain("captureBuilderBrowserEvidence");
    expect(runtimeSource).not.toContain("isAsaelPlaywrightMcpEndpoint");
    expect(runtimeSource).not.toContain("callMcpTool");
    expect(runtimeSource).not.toContain("browser_take_screenshot");
    expect(serviceSource).not.toContain('browserEvidence.status === "captured"');
    expect(serviceSource).not.toContain("captureCount");
    expect(serviceSource).toContain('deployment.logs.status !== "captured"');
    expect(serviceSource).toContain('deployment.routeEvidence.status !== "passed"');
  });
});

function check(command: "lint" | "typecheck", status: "passed" | "failed") {
  return {
    command,
    status,
    exitCode: status === "passed" ? 0 : 1,
    durationMs: 10,
    outputSha256: "c".repeat(64),
  } as const;
}

describe("focused verification receipts", () => {
  it("preserves exact selected tests and counts across receipt serialization", async () => {
    const { normalizeBuilderVerificationChecks } = await import("@/lib/app-builder/verification");
    const record = focusedCheck("regression", ["src/feature.test.ts"]);
    expect(normalizeBuilderVerificationChecks(JSON.parse(JSON.stringify([record])))).toEqual([record]);
  });

  it("requires independent adjacent tests and actual passing cases", () => {
    const checks = focusedChecks();
    expect(createBuilderCheckpointReadinessEvidence(checks).replacement.status).toBe("passed");
    expect(createBuilderCheckpointReadinessEvidence(checks.slice(0, 3)).replacement.status).toBe("failed");
    expect(createBuilderCheckpointReadinessEvidence(checks.map((item) => "purpose" in item && item.purpose === "regression" ? { ...item, testSummary: { ...item.testSummary!, passedTests: 0, pendingTests: 1, success: false } } : item)).replacement.status).toBe("failed");
  });

  it("reuses exact evidence without hiding a later failed run, source drift or expiry", async () => {
    const { reuseBuilderCommandCheck } = await import("@/lib/app-builder/verification");
    const { resolveBuilderCommandSpecification } = await import("@/lib/app-builder/contracts");
    const now = Date.parse("2026-10-26T10:00:00Z");
    const specification = resolveBuilderCommandSpecification({ command: "test_focused", paths: ["src/feature.test.ts"] });
    const receipt = {
      id: "old-pass", sessionId: "session", eventType: "app_builder.command.completed", payloadSha256: "a".repeat(64), occurredAt: new Date(now - 1000).toISOString(),
      detail: { command: "test_focused", specification, workspaceBeforeSha256: "b".repeat(64), workspaceAfterSha256: "b".repeat(64), workspaceUnchanged: true,
        exitCode: 0, durationMs: 5, outputSha256: "c".repeat(64), testSummary: focusedCheck("regression", specification.paths).testSummary },
    };
    const input = { activity: [receipt], command: "test_focused" as const, paths: specification.paths, purpose: "regression" as const, workspaceSha256: "b".repeat(64), now };
    expect(reuseBuilderCommandCheck(input)).toMatchObject({ status: "passed", sourceActivityId: "old-pass", testSummary: { passedTests: 1 } });
    const later = { ...receipt, id: "new-failure", occurredAt: new Date(now).toISOString(), detail: { ...receipt.detail, exitCode: 1, testSummary: { ...receipt.detail.testSummary!, passedTests: 0, failedTests: 1, success: false } } };
    expect(reuseBuilderCommandCheck({ ...input, activity: [receipt, later] })).toMatchObject({ status: "failed", sourceActivityId: "new-failure" });
    expect(() => reuseBuilderCommandCheck({ ...input, workspaceSha256: "d".repeat(64) })).toThrow(/missing or expired/);
    expect(() => reuseBuilderCommandCheck({ ...input, now: now + 4 * 60 * 60_000 })).toThrow(/expired/);
    expect(() => reuseBuilderCommandCheck({ ...input, activity: [{ ...later, detail: { ...later.detail, workspaceUnchanged: false } }] })).toThrow(/changed the workspace/);
  });
});

function focusedCheck(purpose: "regression" | "adjacent", paths: string[]) {
  return {
    command: "test_focused" as const, purpose, paths, status: "passed" as const, exitCode: 0, durationMs: 10, outputSha256: "c".repeat(64), policySha256: "a".repeat(64),
    testSummary: { totalTests: 1, passedTests: 1, failedTests: 0, pendingTests: 0, executedPaths: paths, success: true },
  };
}

function focusedChecks() {
  return [
    { ...check("lint", "passed"), command: "lint_focused" as const, paths: ["src/feature.ts"], policySha256: "a".repeat(64) },
    { ...check("typecheck", "passed"), command: "typecheck_direct" as const, policySha256: "b".repeat(64) },
    focusedCheck("regression", ["src/feature.test.ts"]),
    focusedCheck("adjacent", ["src/neighbor.test.ts"]),
  ];
}
