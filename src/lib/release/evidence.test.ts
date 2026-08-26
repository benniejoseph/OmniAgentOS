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
    expect(mocks.getLatestWorkerHeartbeats).toHaveBeenCalledWith({
      protocol: "1",
      revision,
      target: "https://release.example.test",
    });
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

  it("blocks post-activation evidence when every worker tick fails before publishing an active heartbeat", async () => {
    const revision = "active-gate-release";
    const activationMs = Date.now() - 5_000;
    const activationStartedAt = new Date(activationMs).toISOString();
    const startupHeartbeats = ["fast", "background", "maintenance"].map(
      (lane) => ({
        instanceId: "worker",
        lane,
        phase: "startup",
        protocol: "1",
        revision,
        target: "https://release.example.test",
        recordedAt: new Date(activationMs + 1_000).toISOString(),
      }),
    );
    configurePassingEvidence(revision, startupHeartbeats);

    const defaultReport = await getReleaseEvidenceReport(
      "active-heartbeat-cache-isolation",
      {
        force: true,
        expectedWorkerTarget: "https://release.example.test",
      },
    );
    expect(defaultReport.releaseGate.approved).toBe(true);

    const strictReport = await getReleaseEvidenceReport(
      "active-heartbeat-cache-isolation",
      {
        expectedWorkerTarget: "https://release.example.test",
        requireActiveWorkerHeartbeats: true,
        workerHeartbeatNotBefore: activationStartedAt,
      },
    );

    expect(mocks.getLatestWorkerHeartbeats).toHaveBeenCalledTimes(2);
    expect(strictReport.releaseGate.approved).toBe(false);
    expect(
      strictReport.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "fail",
      summary:
        "Dedicated worker fast and background lanes have not both completed successful post-activation ticks.",
      details: {
        requireActiveHeartbeats: true,
        activeHeartbeatRequiredLanes: ["fast", "background"],
        heartbeatNotBefore: activationStartedAt,
        heartbeatNotBeforeProvided: true,
        heartbeatNotBeforeValid: true,
        activePhaseMatches: false,
        heartbeatNotBeforeMatches: true,
        lanes: [
          {
            lane: "fast",
            requiredPhase: "active",
            phaseMatches: false,
            recordedAtOrAfterNotBefore: true,
            ready: false,
          },
          {
            lane: "background",
            requiredPhase: "active",
            phaseMatches: false,
            recordedAtOrAfterNotBefore: true,
            ready: false,
          },
          {
            lane: "maintenance",
            phaseMatches: true,
            recordedAtOrAfterNotBefore: true,
            ready: true,
          },
        ],
      },
    });
  });

  it("fails closed when the active-heartbeat cutoff is missing or invalid", async () => {
    const revision = "invalid-active-cutoff-release";
    configurePassingEvidence(
      revision,
      ["fast", "background", "maintenance"].map((lane) => ({
        instanceId: "worker",
        lane,
        phase: lane === "maintenance" ? "startup" : "active",
        protocol: "1",
        revision,
        target: "https://release.example.test",
        recordedAt: new Date().toISOString(),
      })),
    );

    for (const [tenantId, workerHeartbeatNotBefore] of [
      ["missing-active-cutoff", undefined],
      ["invalid-active-cutoff", "not-a-timestamp"],
    ] as const) {
      const report = await getReleaseEvidenceReport(tenantId, {
        force: true,
        expectedWorkerTarget: "https://release.example.test",
        requireActiveWorkerHeartbeats: true,
        workerHeartbeatNotBefore,
      });

      expect(report.releaseGate.approved).toBe(false);
      expect(
        report.gates.find((gate) => gate.id === "dedicated_worker"),
      ).toMatchObject({
        status: "fail",
        summary:
          "Post-activation worker evidence requires a valid heartbeat not-before timestamp.",
        details: {
          requireActiveHeartbeats: true,
          heartbeatNotBeforeProvided: Boolean(workerHeartbeatNotBefore),
          heartbeatNotBeforeValid: false,
          heartbeatNotBeforeMatches: false,
        },
      });
    }
  });

  it("requires active fast and background heartbeats after activation while allowing startup maintenance", async () => {
    const revision = "successful-active-gate-release";
    const activationMs = Date.now() - 5_000;
    const activationStartedAt = new Date(activationMs).toISOString();
    const heartbeat = (
      lane: "fast" | "background" | "maintenance",
      recordedAt: string,
    ) => ({
      instanceId: "worker",
      lane,
      phase: lane === "maintenance" ? "startup" : "active",
      protocol: "1",
      revision,
      target: "https://release.example.test",
      recordedAt,
    });
    configurePassingEvidence(revision, [
      heartbeat("fast", new Date(activationMs - 1_000).toISOString()),
      heartbeat("background", new Date(activationMs - 1_000).toISOString()),
      heartbeat("maintenance", new Date(activationMs - 2_000).toISOString()),
    ]);

    const beforeCutoff = await getReleaseEvidenceReport(
      "active-heartbeat-cutoff",
      {
        force: true,
        expectedWorkerTarget: "https://release.example.test",
        requireActiveWorkerHeartbeats: true,
        workerHeartbeatNotBefore: activationStartedAt,
      },
    );
    expect(beforeCutoff.releaseGate.approved).toBe(false);
    expect(
      beforeCutoff.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      details: {
        activePhaseMatches: true,
        heartbeatNotBeforeMatches: false,
      },
    });

    mocks.getLatestWorkerHeartbeats.mockResolvedValue([
      heartbeat("fast", new Date(activationMs + 1_000).toISOString()),
      heartbeat("background", new Date(activationMs + 1_000).toISOString()),
      heartbeat("maintenance", new Date(activationMs - 2_000).toISOString()),
    ]);
    const ready = await getReleaseEvidenceReport(
      "active-heartbeat-cutoff",
      {
        force: true,
        expectedWorkerTarget: "https://release.example.test",
        requireActiveWorkerHeartbeats: true,
        workerHeartbeatNotBefore: activationStartedAt,
      },
    );

    expect(ready.releaseGate.approved).toBe(true);
    expect(
      ready.gates.find((gate) => gate.id === "dedicated_worker"),
    ).toMatchObject({
      status: "pass",
      details: {
        activePhaseMatches: true,
        heartbeatNotBeforeMatches: true,
        lanes: [
          { lane: "fast", ready: true },
          { lane: "background", ready: true },
          {
            lane: "maintenance",
            heartbeat: { phase: "startup" },
            ready: true,
          },
        ],
      },
    });
  });
});

function configurePassingEvidence(
  revision: string,
  heartbeats: Array<Record<string, unknown>>,
) {
  const gatewayToken = "gateway_token_abcdefghijklmnopqrstuvwxyz123456";
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
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({
      status: "healthy",
      service: "asael-openai-egress",
      region: "iad",
      revision,
      protocol: "1",
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
  mocks.getTenantIsolationReport.mockResolvedValue({
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
  });
  mocks.getObservabilitySloSnapshot.mockResolvedValue({
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
      slo: { availability: 1, errorRate: 0, latencyP95Ms: 0 },
    },
  });
  mocks.getRuntimeDatabaseRoleSafety.mockResolvedValue({
    configured: true,
    safe: true,
  });
  mocks.getMaintenanceDatabaseRoleSafety.mockResolvedValue({
    configured: true,
    safe: true,
    sameDatabase: true,
  });
  mocks.getOpenAIReadiness.mockResolvedValue({
    configured: true,
    reachable: true,
    model: "test-model",
    checkedAt: new Date().toISOString(),
  });
  mocks.getLatestWorkerHeartbeats.mockResolvedValue(heartbeats);
}
