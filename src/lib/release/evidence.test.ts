import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantIsolationReport: vi.fn(),
  getObservabilitySloSnapshot: vi.fn(),
  getRuntimeDatabaseRoleSafety: vi.fn(),
  getMaintenanceDatabaseRoleSafety: vi.fn(),
  getOpenAIReadiness: vi.fn(),
  getLatestWorkerHeartbeats: vi.fn(),
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
  getLatestWorkerHeartbeats: mocks.getLatestWorkerHeartbeats,
}));

import { getReleaseEvidenceReport } from "@/lib/release/evidence";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("release evidence", () => {
  it("serializes collectors to keep shared database pool pressure bounded", async () => {
    const revision = "release-revision";
    const workerRevision = revision;
    const gatewayToken =
      "gateway_token_abcdefghijklmnopqrstuvwxyz123456";
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_REGION", "sin1");
    vi.stubEnv("VERCEL_URL", "release.example.test");
    vi.stubEnv("VERCEL_GIT_COMMIT_SHA", revision);
    vi.stubEnv(
      "OMNIAGENT_OPENAI_GATEWAY_URL",
      "https://omniagent-os-worker.fly.dev/v1",
    );
    vi.stubEnv("OMNIAGENT_OPENAI_GATEWAY_TOKEN", gatewayToken);
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "configured");
    vi.stubEnv("CRON_SECRET", "configured");

    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    let gatewayRevision = revision;
    let gatewayRegion = "iad";
    let observedGatewayToken: string | undefined;
    const gatewayFetch = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      order.push("gateway");
      observedGatewayToken = new Headers(init?.headers).get(
        "x-asael-gateway-token",
      ) || undefined;
      expect(String(input)).toBe(
        "https://omniagent-os-worker.fly.dev/healthz",
      );
      return new Response(JSON.stringify({
        status: "healthy",
        service: "asael-openai-egress",
        region: gatewayRegion,
        revision: gatewayRevision,
        protocol: "1",
        secret: gatewayToken,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", gatewayFetch);
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
    mocks.getLatestWorkerHeartbeats.mockImplementation(
      collector(
        "heartbeat",
        ["fast", "background", "maintenance"].map((lane) => ({
          instanceId: "worker",
          lane,
          protocol: "1",
          revision: workerRevision,
          target: "https://release.example.test",
          recordedAt: new Date().toISOString(),
        })),
      ),
    );

    const [report, duplicate] = await Promise.all([
      getReleaseEvidenceReport("default"),
      getReleaseEvidenceReport("default"),
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual([
      "tenant",
      "observability",
      "runtime-role",
      "maintenance-role",
      "gateway",
      "openai",
      "heartbeat",
    ]);
    expect(duplicate.checkedAt).toBe(report.checkedAt);
    expect(mocks.getTenantIsolationReport).toHaveBeenCalledTimes(1);
    expect(report.releaseGate.approved).toBe(true);
    expect(observedGatewayToken).toBe(gatewayToken);
    expect(
      report.gates.find((gate) => gate.id === "openai_us_egress_gateway"),
    ).toMatchObject({
      status: "pass",
      details: {
        required: true,
        configured: true,
        safeConfiguration: true,
        reachable: true,
        regionMatches: true,
        revisionMatches: true,
        protocolMatches: true,
        ready: true,
      },
    });
    expect(JSON.stringify(report)).not.toContain(gatewayToken);
    expect(
      report.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "pass",
      details: {
        protocolMatches: true,
        revisionMatches: true,
        targetMatches: true,
      },
    });

    gatewayRevision = "different-release";
    gatewayRegion = "sin";
    const gatewayMismatch = await getReleaseEvidenceReport(
      "gateway-mismatch",
    );
    expect(gatewayMismatch.releaseGate.approved).toBe(false);
    expect(
      gatewayMismatch.gates.find(
        (gate) => gate.id === "openai_us_egress_gateway",
      ),
    ).toMatchObject({
      status: "fail",
      details: {
        configured: true,
        reachable: true,
        regionMatches: false,
        revisionMatches: false,
        ready: false,
      },
    });
    expect(JSON.stringify(gatewayMismatch)).not.toContain(gatewayToken);
    gatewayRevision = revision;
    gatewayRegion = "iad";

    const gatewayFetchesBeforeSpoof = gatewayFetch.mock.calls.length;
    vi.stubEnv(
      "OMNIAGENT_OPENAI_GATEWAY_URL",
      "https://omniagent-os-worker.fly.dev.attacker.example/v1",
    );
    const gatewaySpoof = await getReleaseEvidenceReport("gateway-spoof");
    expect(gatewaySpoof.releaseGate.approved).toBe(false);
    expect(
      gatewaySpoof.gates.find(
        (gate) => gate.id === "openai_us_egress_gateway",
      ),
    ).toMatchObject({
      status: "fail",
      details: {
        configured: true,
        safeConfiguration: false,
        reachable: false,
        ready: false,
      },
    });
    expect(gatewayFetch).toHaveBeenCalledTimes(gatewayFetchesBeforeSpoof);
    vi.stubEnv(
      "OMNIAGENT_OPENAI_GATEWAY_URL",
      "https://omniagent-os-worker.fly.dev/v1",
    );

    mocks.getLatestWorkerHeartbeats.mockResolvedValue(
      ["fast", "background", "maintenance"].map((lane) => ({
        instanceId: "worker",
        lane,
        protocol: "1",
        revision: "different-release",
        target: "https://release.example.test",
        recordedAt: new Date().toISOString(),
      })),
    );
    const mismatched = await getReleaseEvidenceReport("revision-mismatch");
    expect(mismatched.releaseGate.approved).toBe(false);
    expect(
      mismatched.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "fail",
      details: {
        protocolMatches: true,
        revisionMatches: false,
        targetMatches: true,
      },
    });

    mocks.getLatestWorkerHeartbeats.mockResolvedValue(
      ["fast", "background", "maintenance"].map((lane) => ({
        instanceId: "worker",
        lane,
        protocol: "1",
        revision,
        target: "https://staged.example.test",
        recordedAt: new Date().toISOString(),
      })),
    );
    const stagedReady = await getReleaseEvidenceReport(
      "target-cache-isolation",
      { expectedWorkerTarget: "https://staged.example.test" },
    );
    expect(stagedReady.releaseGate.approved).toBe(true);
    expect(
      stagedReady.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "pass",
      details: { targetMatches: true },
    });

    const canonicalMismatch = await getReleaseEvidenceReport(
      "target-cache-isolation",
      { expectedWorkerTarget: "https://release.example.test" },
    );
    expect(canonicalMismatch.releaseGate.approved).toBe(false);
    expect(
      canonicalMismatch.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "fail",
      details: {
        protocolMatches: true,
        revisionMatches: true,
        targetMatches: false,
      },
    });

    mocks.getLatestWorkerHeartbeats.mockResolvedValue(
      ["fast", "background", "maintenance"].map((lane) => ({
        instanceId: "worker",
        lane,
        protocol: "1",
        revision,
        target: "https://release.example.test",
        recordedAt: new Date().toISOString(),
      })),
    );
    const canonicalTarget = await getReleaseEvidenceReport(
      "target-cache-isolation",
      {
        force: true,
        expectedWorkerTarget: "https://release.example.test",
      },
    );
    expect(canonicalTarget.releaseGate.approved).toBe(true);
    expect(
      canonicalTarget.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "pass",
      details: {
        protocolMatches: true,
        revisionMatches: true,
        targetMatches: true,
      },
    });
  });
});
