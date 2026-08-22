import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantIsolationReport: vi.fn(),
  getObservabilitySloSnapshot: vi.fn(),
  getRuntimeDatabaseRoleSafety: vi.fn(),
  getMaintenanceDatabaseRoleSafety: vi.fn(),
  getOpenAIReadiness: vi.fn(),
  getLatestWorkerHeartbeat: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  hasOpenAIKey: () => true,
}));
vi.mock("@/lib/security/isolation-report", () => ({
  getTenantIsolationReport: mocks.getTenantIsolationReport,
}));
vi.mock("@/lib/observability/slo-monitor", () => ({
  getObservabilitySloSnapshot: mocks.getObservabilitySloSnapshot,
}));
vi.mock("@/lib/db/client", () => ({
  getRuntimeDatabaseRoleSafety: mocks.getRuntimeDatabaseRoleSafety,
  getMaintenanceDatabaseRoleSafety: mocks.getMaintenanceDatabaseRoleSafety,
}));
vi.mock("@/lib/openai/client", () => ({
  getOpenAIReadiness: mocks.getOpenAIReadiness,
}));
vi.mock("@/lib/operations/worker-heartbeat", () => ({
  getLatestWorkerHeartbeat: mocks.getLatestWorkerHeartbeat,
}));

import { getReleaseEvidenceReport } from "@/lib/release/evidence";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("release evidence", () => {
  it("serializes collectors to keep shared database pool pressure bounded", async () => {
    const revision = "release-revision";
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", revision);
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "configured");
    vi.stubEnv("CRON_SECRET", "configured");

    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const collector = <T>(name: string, value: T) => async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return value;
    };

    mocks.getTenantIsolationReport.mockImplementation(collector("tenant", {
      tenantId: "default",
      checkedAt: new Date().toISOString(),
      storageBackend: "postgres",
      databaseConfigured: true,
      status: "passing",
      summary: {
        expectedTables: 1,
        protectedTables: 1,
        childTables: 0,
        failingTables: 0,
        missingTables: [],
        missingTenantColumns: [],
        rlsDisabled: [],
        forceRlsDisabled: [],
        missingPolicies: [],
      },
      tables: [],
      latestEval: {
        runId: "eval-run",
        runStatus: "completed",
        resultStatus: "pass",
        score: 1,
        createdAt: new Date().toISOString(),
      },
      recommendations: [],
    }));
    mocks.getObservabilitySloSnapshot.mockImplementation(collector("observability", {
      checkedAt: new Date().toISOString(),
      healthy: true,
      policies: [],
      evaluations: [],
      breaches: [],
      stats: {
        total: 0,
        sloEligibleEvents: 0,
        sloExcludedEvents: 0,
        syntheticEvents: 0,
        routeFailures: 0,
        authFailures: 0,
        authenticationChallenges: 0,
        policyBlocks: 0,
        connectorFailures: 0,
        slo: {
          availability: 1,
          errorRate: 0,
          latencyP95Ms: 0,
        },
      },
    }));
    mocks.getRuntimeDatabaseRoleSafety.mockImplementation(collector("runtime-role", {
      configured: true,
      safe: true,
    }));
    mocks.getMaintenanceDatabaseRoleSafety.mockImplementation(collector("maintenance-role", {
      configured: true,
      safe: true,
      sameDatabase: true,
    }));
    mocks.getOpenAIReadiness.mockImplementation(collector("openai", {
      configured: true,
      reachable: true,
      model: "test-model",
      checkedAt: new Date().toISOString(),
    }));
    mocks.getLatestWorkerHeartbeat.mockImplementation(collector("heartbeat", {
      instanceId: "worker",
      revision,
      recordedAt: new Date().toISOString(),
    }));

    const report = await getReleaseEvidenceReport("default");

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "tenant",
      "observability",
      "runtime-role",
      "maintenance-role",
      "openai",
      "heartbeat",
    ]);
    expect(report.releaseGate.approved).toBe(true);
  });
});
