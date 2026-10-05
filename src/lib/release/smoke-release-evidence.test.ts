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

function passingReport(budgetStatus?: string) {
  return {
    releaseGate: { approved: true, status: "passed", reasons: [] as string[], warnings: [] as string[] },
    gates: [
      ...requiredPreviousGates.map((id) => ({ id, status: "pass", summary: "Ready." })),
      ...(budgetStatus === undefined ? [] : [{
        id: "agent_error_budget",
        status: budgetStatus,
        summary: "Budget observation.",
      }]),
    ],
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

  function smoke(report: ReturnType<typeof passingReport>, previousRelease = false, status = 200) {
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
