import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const requiredPreviousGates = [
  "tenant_isolation_database",
  "latest_tenant_isolation_eval",
  "internal_smoke_auth",
  "openai_provider",
  "cron_auth",
  "runtime_database_role",
  "dedicated_worker",
  "observability_slo",
  "eval_report_signing",
];

type Gate = { id: string; status: string; summary: string; name?: string; details?: unknown };
const exceptionReason = "Owner-authorized measured agent-run fix.";

function budgetDetails(runVerdict = "exhausted", toolVerdict = "within", measured = true) {
  return {
    measured,
    exception: { reason: exceptionReason, applied: true },
    objectives: [
      { id: "agent_runs", objective: 0.95, verdict: runVerdict, budgetSpent: 2 },
      { id: "tool_calls", objective: 0.9, verdict: toolVerdict, budgetSpent: 0.1 },
    ],
    ignoredSensitiveData: "never copied to the local artifact",
  };
}

function passingReport(budgetStatus?: string, budgetEvidence?: unknown) {
  return {
    tenantId: "production_smoke",
    releaseGate: { approved: true, status: "passed", reasons: [] as string[], warnings: [] as string[] },
    gates: [
      ...requiredPreviousGates.map((id) => ({ id, status: "pass", summary: "Ready." })),
      ...(budgetStatus === undefined ? [] : [{
        id: "agent_error_budget",
        status: budgetStatus,
        summary: "Budget observation.",
        ...(budgetEvidence === undefined ? {} : { details: budgetEvidence }),
      }]),
    ] as Gate[],
  };
}

describe("release evidence smoke across the first error-budget upgrade", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "asael-smoke-evidence-"));
  const artifactFile = path.join(directory, "evidence.json");
  const requestsFile = path.join(directory, "requests.log");
  const fetchStub = path.join(directory, "fetch-stub.mjs");
  writeFileSync(fetchStub, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
  appendFileSync(process.env.FAKE_REQUESTS, String(url) + "\\n");
  return new Response(process.env.FAKE_EVIDENCE, {
    status: Number(process.env.FAKE_STATUS),
    headers: { "content-type": "application/json" },
  });
};
`);
  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function smoke(report: ReturnType<typeof passingReport>, previousRelease = false, status = 200, reason?: string) {
    rmSync(requestsFile, { force: true });
    const result = spawnSync(process.execPath, [
      "--import", pathToFileURL(fetchStub).href,
      path.resolve("scripts/smoke-release-evidence.mjs"),
      ...(previousRelease ? ["--previous-release"] : []),
    ], {
      encoding: "utf8",
      timeout: 20_000,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        BASE_URL: "https://asael.example",
        SMOKE_INTERNAL_AUTH_SECRET: "internal-test-secret",
        RELEASE_EVIDENCE_OUTPUT: artifactFile,
        FAKE_REQUESTS: requestsFile,
        FAKE_STATUS: String(status),
        FAKE_EVIDENCE: JSON.stringify({ report }),
        ...(reason ? { OMNIAGENT_RELEASE_ERROR_BUDGET_EXCEPTION: reason } : {}),
      },
    });
    return {
      code: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      artifact: JSON.parse(readFileSync(artifactFile, "utf8")),
      requested: readFileSync(requestsFile, "utf8").trim().split("\n"),
    };
  }

  it("requires the new budget gate by default for staged, canonical, and scheduled checks", () => {
    const result = smoke(passingReport());

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL agent error budget gate passes - missing gate");
    expect(result.artifact).not.toHaveProperty("previousReleaseCompatibility");
  });

  it("rejects a report from a different tenant than the synthetic request", () => {
    const result = smoke({ ...passingReport("pass"), tenantId: "another_tenant" });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL release evidence tenant matches request scope");
    expect(result.artifact.tenantId).toBe("another_tenant");
  });

  it("permits only the absent budget gate when explicitly checking the previous release", () => {
    const result = smoke(passingReport(), true);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("PASS previous release predates the agent error budget gate");
    expect(result.requested).toEqual(["https://asael.example/api/release/evidence?refresh=true"]);
    expect(result.artifact.previousReleaseCompatibility).toEqual({ missingAgentErrorBudget: true });
    expect(result.artifact.gates).not.toContainEqual(expect.objectContaining({ id: "agent_error_budget" }));
  });

  it("keeps the exact blocked prior-report metadata available for audited recovery", () => {
    const report = {
      ...passingReport("pass"),
      checkedAt: "2026-10-05T10:44:22.372Z",
      releaseGate: {
        approved: false,
        status: "blocked",
        reasons: ["Database tenant isolation: Tenant isolation schema evidence is incomplete."],
        warnings: [],
      },
      gates: passingReport("pass").gates.map((gate) => gate.id === "tenant_isolation_database"
        ? { ...gate, status: "fail", name: "Database tenant isolation", summary: "Tenant isolation schema evidence is incomplete." }
        : gate),
      tenantIsolation: {
        status: "degraded",
        summary: { expectedTables: 265, protectedTables: 265, failingTables: 0,
          unclassifiedTables: ["omni_native_openapi_import_preparations"] },
      },
    };
    const result = smoke(report, true);

    expect(result.code).toBe(1);
    expect(result.artifact).toMatchObject({
      httpStatus: 200,
      reportCheckedAt: report.checkedAt,
      tenantIsolationStatus: "degraded",
      tenantIsolation: report.tenantIsolation.summary,
      releaseGate: report.releaseGate,
    });
  });

  it.each([false, true])("checks a present passing budget gate in previous-release mode %s", (previousRelease) => {
    const result = smoke(passingReport("pass"), previousRelease);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS agent error budget gate passes");
    expect(result.stdout).not.toContain("previous release predates");
    expect(result.artifact).not.toHaveProperty("previousReleaseCompatibility");
  });

  it.each(["fail", "warn", "", "unknown"])("refuses a present non-passing budget gate (%s), even on the previous release", (status) => {
    const result = smoke(passingReport(status), true);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL agent error budget gate passes");
    expect(result.stdout).not.toContain("previous release predates");
  });

  it("records only bounded measured agent-run-only proof for an applied exception", () => {
    const result = smoke(passingReport("pass", budgetDetails()), true, 200, exceptionReason);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS agent error budget exception has measured agent-run-only scope");
    expect(new URL(result.requested[0]).searchParams.get("errorBudgetException"))
      .toBe(exceptionReason);
    expect(result.artifact.errorBudgetProof).toEqual({
      measured: true,
      exception: { reason: exceptionReason, applied: true },
      objectives: [
        { id: "agent_runs", objective: 0.95, verdict: "exhausted" },
        { id: "tool_calls", objective: 0.9, verdict: "within" },
      ],
    });
    expect(JSON.stringify(result.artifact)).not.toContain("ignoredSensitiveData");
  });

  it("accepts the exact recorded reason after both measured objectives recover", () => {
    const details = budgetDetails("recovering", "insufficient");
    details.exception.applied = false;
    const result = smoke(passingReport("pass", details), false, 200, exceptionReason);

    expect(result.code).toBe(0);
    expect(result.artifact.errorBudgetProof).toMatchObject({
      measured: true,
      exception: { reason: exceptionReason, applied: false },
      objectives: [
        { id: "agent_runs", verdict: "recovering" },
        { id: "tool_calls", verdict: "insufficient" },
      ],
    });
  });

  it.each([
    ["unread telemetry", budgetDetails("exhausted", "within", false)],
    ["tool-call exhaustion", budgetDetails("exhausted", "exhausted")],
    ["tool-call-only exhaustion", budgetDetails("within", "exhausted")],
    ["wrong objective", { ...budgetDetails(), objectives: [
      { id: "agent_runs", objective: 0.95, verdict: "exhausted" },
      { id: "tool_calls", objective: 0.95, verdict: "within" },
    ] }],
    ["missing objective", { ...budgetDetails(), objectives: budgetDetails().objectives.slice(0, 1) }],
    ["wrong reason", { ...budgetDetails(), exception: { reason: "Different reason.", applied: true } }],
  ])("rejects an old server's applied exception with %s", (_label, details) => {
    const result = smoke(passingReport("pass", details), true, 200, exceptionReason);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL agent error budget exception has measured agent-run-only scope");
  });

  it("refuses an applied exception without an operator reason on candidate smokes", () => {
    const result = smoke(passingReport("pass", budgetDetails()));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL agent error budget exception has measured agent-run-only scope");
  });

  it("rejects a falsely recovered report while tool calls remain exhausted", () => {
    const details = budgetDetails("within", "exhausted");
    details.exception.applied = false;
    const result = smoke(passingReport("pass", details), false, 200, exceptionReason);
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("FAIL agent error budget exception has measured agent-run-only scope");
  });

  it.each(requiredPreviousGates)("still requires the previous release's %s gate", (id) => {
    for (const absent of [false, true]) {
      const report = passingReport();
      report.gates = absent
        ? report.gates.filter((gate) => gate.id !== id)
        : report.gates.map((gate) => gate.id === id ? { ...gate, status: "fail" } : gate);

      expect(smoke(report, true).code).toBe(1);
    }
  });

  it("still requires an approved, fully passed report and a successful response", () => {
    const unapproved = passingReport();
    unapproved.releaseGate.approved = false;
    expect(smoke(unapproved, true).code).toBe(1);
    const degraded = passingReport();
    degraded.releaseGate.status = "warning";
    expect(smoke(degraded, true).code).toBe(1);
    expect(smoke(passingReport(), true, 503).code).toBe(1);
  });
});
