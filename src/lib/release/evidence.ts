import { hasOpenAIKey } from "@/lib/config";
import {
  getMaintenanceDatabaseRoleSafety,
  getRuntimeDatabaseRoleSafety,
} from "@/lib/db/client";
import { getObservabilitySloSnapshot } from "@/lib/observability/slo-monitor";
import { getOpenAIReadiness } from "@/lib/openai/client";
import { getLatestWorkerHeartbeats } from "@/lib/operations/worker-heartbeat";
import { WORKER_PROTOCOL_VERSION } from "@/lib/operations/worker-request";
import { getTenantIsolationReport, type TenantIsolationReport } from "@/lib/security/isolation-report";

export type ReleaseEvidenceGateStatus = "pass" | "warn" | "fail";

export type ReleaseEvidenceGate = {
  id: string;
  name: string;
  status: ReleaseEvidenceGateStatus;
  summary: string;
  details: Record<string, unknown>;
};

export type ReleaseEvidenceReport = {
  tenantId: string;
  checkedAt: string;
  deployment: {
    provider: "vercel" | "local";
    environment: string;
    url?: string;
    commitSha?: string;
    branch?: string;
    region?: string;
  };
  releaseGate: {
    approved: boolean;
    status: "passed" | "warning" | "blocked";
    reasons: string[];
    warnings: string[];
    summary: {
      total: number;
      passed: number;
      warnings: number;
      failures: number;
    };
  };
  gates: ReleaseEvidenceGate[];
  tenantIsolation: TenantIsolationReport;
  observability: {
    checkedAt: string;
    healthy: boolean;
    policies: number;
    breaches: {
      policyId: string;
      name: string;
      severity?: string;
      message: string;
      value: number;
      threshold?: number;
    }[];
    stats: {
      total: number;
      sloEligibleEvents: number;
      sloExcludedEvents: number;
      syntheticEvents: number;
      routeFailures: number;
      authFailures: number;
      authenticationChallenges: number;
      policyBlocks: number;
      connectorFailures: number;
      availability: number;
      errorRate: number;
      latencyP95Ms: number;
    };
  };
  recommendations: string[];
};

const advisorySloPolicyIds = new Set([
  "auth_failure_pressure",
  "security_policy_blocks",
]);
const releaseEvidenceCache = new Map<
  string,
  { expiresAt: number; report: ReleaseEvidenceReport }
>();
const releaseEvidenceInFlight = new Map<
  string,
  Promise<ReleaseEvidenceReport>
>();

export async function getReleaseEvidenceReport(
  tenantId: string,
  options: { force?: boolean; expectedWorkerTarget?: string } = {},
): Promise<ReleaseEvidenceReport> {
  const expectedWorkerTarget = normalizeWorkerTarget(
    options.expectedWorkerTarget || getDeploymentEvidence().url,
  );
  const cacheKey = `${tenantId}\n${expectedWorkerTarget || "unknown-target"}`;
  const inFlight = releaseEvidenceInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }
  const cached = releaseEvidenceCache.get(cacheKey);
  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.report;
  }

  const collection = collectReleaseEvidenceReport(
    tenantId,
    expectedWorkerTarget,
  )
    .then((report) => {
      releaseEvidenceCache.set(cacheKey, {
        expiresAt: Date.now() + releaseEvidenceTtlMs(),
        report,
      });
      return report;
    })
    .finally(() => {
      if (releaseEvidenceInFlight.get(cacheKey) === collection) {
        releaseEvidenceInFlight.delete(cacheKey);
      }
    });
  releaseEvidenceInFlight.set(cacheKey, collection);
  return collection;
}

async function collectReleaseEvidenceReport(
  tenantId: string,
  expectedWorkerTarget?: string,
): Promise<ReleaseEvidenceReport> {
  const checkedAt = new Date().toISOString();
  const deployment = getDeploymentEvidence();
  // Keep release checks ordered to minimize pool pressure and ensure one
  // collector cannot reserve runtime and maintenance connections while another
  // collector waits for them under production load.
  const tenantIsolation = await getTenantIsolationReport(tenantId);
  const observabilitySlo = await getObservabilitySloSnapshot({ tenantId });
  const databaseRole = await getRuntimeDatabaseRoleSafety();
  const maintenanceDatabaseRole = await getMaintenanceDatabaseRoleSafety();
  const openAi = deployment.environment === "production"
    ? await getOpenAIReadiness()
    : {
        configured: hasOpenAIKey(),
        reachable: hasOpenAIKey(),
        model: process.env.OMNIAGENT_AGENT_MODEL || "configured model",
        checkedAt,
      };
  const workerHeartbeats = await getLatestWorkerHeartbeats();

  const criticalBlockingBreaches = observabilitySlo.breaches.filter(
    (breach) => breach.severity === "critical" && !advisorySloPolicyIds.has(breach.policy.id),
  );
  const workerHeartbeatMaxAgeMs = normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_HEARTBEAT_MAX_AGE_MS,
    2_100_000,
  );
  const expectedWorkerProtocol =
    process.env.OMNIAGENT_WORKER_PROTOCOL_VERSION?.trim() ||
    WORKER_PROTOCOL_VERSION;
  const requiredWorkerLanes = ["fast", "background", "maintenance"] as const;
  const workerLaneReadiness = requiredWorkerLanes.map((lane) => {
    const heartbeat = workerHeartbeats.find((item) => item.lane === lane);
    const ageMs = heartbeat
      ? Date.now() - Date.parse(heartbeat.recordedAt)
      : Number.POSITIVE_INFINITY;
    return {
      lane,
      heartbeat,
      ageMs,
      protocolMatches: heartbeat?.protocol === expectedWorkerProtocol,
      revisionMatches: Boolean(
        heartbeat?.revision &&
          deployment.commitSha &&
          heartbeat.revision === deployment.commitSha,
      ),
      targetMatches: Boolean(
        heartbeat?.target &&
          expectedWorkerTarget &&
          normalizeWorkerTarget(heartbeat.target) === expectedWorkerTarget,
      ),
      ready:
        Number.isFinite(ageMs) &&
        ageMs <= workerHeartbeatMaxAgeMs &&
        heartbeat?.protocol === expectedWorkerProtocol &&
        Boolean(
          heartbeat?.revision &&
            deployment.commitSha &&
            heartbeat.revision === deployment.commitSha,
        ) &&
        Boolean(
          heartbeat?.target &&
            expectedWorkerTarget &&
            normalizeWorkerTarget(heartbeat.target) === expectedWorkerTarget,
        ),
    };
  });
  const workerProtocolMatches = workerLaneReadiness.every(
    (item) => item.protocolMatches,
  );
  const workerRevisionMatches = workerLaneReadiness.every(
    (item) => item.revisionMatches,
  );
  const workerTargetMatches = workerLaneReadiness.every(
    (item) => item.targetMatches,
  );
  const workerReady = workerLaneReadiness.every((item) => item.ready);

  const gates: ReleaseEvidenceGate[] = [
    {
      id: "deployment_environment",
      name: "Production deployment metadata",
      status: deployment.environment === "production" ? "pass" : "warn",
      summary: deployment.environment === "production"
        ? "Running with Vercel production deployment metadata."
        : "Release evidence is not running in the Vercel production environment.",
      details: deployment,
    },
    {
      id: "internal_smoke_auth",
      name: "Internal smoke credential",
      status: process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim() ? "pass" : "fail",
      summary: process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim()
        ? "Generated internal smoke credential is configured for trusted CI probes."
        : "OMNIAGENT_INTERNAL_AUTH_SECRET is missing; tenant smoke cannot prove cross-tenant isolation.",
      details: {
        configured: Boolean(process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim()),
        connectorRefsBlocked: true,
      },
    },
    {
      id: "openai_provider",
      name: "OpenAI provider readiness",
      status: openAi.configured && openAi.reachable ? "pass" : "fail",
      summary:
        openAi.configured && openAi.reachable
          ? `OpenAI model ${openAi.model} is reachable.`
          : openAi.configured
            ? "OpenAI is configured but the bounded provider probe failed."
            : "OPENAI_API_KEY is not configured.",
      details: {
        configured: openAi.configured,
        reachable: openAi.reachable,
        model: openAi.model,
        checkedAt: openAi.checkedAt,
      },
    },
    {
      id: "cron_auth",
      name: "Scheduled maintenance authentication",
      status: process.env.CRON_SECRET?.trim() ? "pass" : "fail",
      summary: process.env.CRON_SECRET?.trim()
        ? "CRON_SECRET is configured for authenticated scheduled maintenance."
        : "CRON_SECRET is missing; scheduled maintenance cannot authenticate.",
      details: {
        configured: Boolean(process.env.CRON_SECRET?.trim()),
      },
    },
    {
      id: "runtime_database_role",
      name: "Runtime database role",
      status: databaseRole.safe ? "pass" : "fail",
      summary: databaseRole.safe
        ? "Runtime database role is a non-owner without superuser or BYPASSRLS privileges."
        : "Runtime database role can bypass tenant enforcement or could not be verified.",
      details: databaseRole,
    },
    {
      id: "maintenance_database_role",
      name: "Maintenance database role",
      status: maintenanceDatabaseRole.safe ? "pass" : "fail",
      summary: maintenanceDatabaseRole.safe
        ? "Audited system work uses a dedicated BYPASSRLS role bound to this database."
        : "The maintenance role is missing, unsafe, or points at a different database.",
      details: maintenanceDatabaseRole,
    },
    {
      id: "dedicated_worker",
      name: "Dedicated worker readiness",
      status: workerReady ? "pass" : "fail",
      summary: workerReady
        ? "Dedicated worker heartbeat is fresh and matches this release revision, target, and worker protocol."
        : "Dedicated worker heartbeat is missing, stale, target/revision-mismatched, or uses an unsupported protocol.",
      details: {
        expectedProtocol: expectedWorkerProtocol,
        expectedRevision: deployment.commitSha,
        expectedTarget: expectedWorkerTarget,
        heartbeats: workerHeartbeats,
        lanes: workerLaneReadiness.map((item) => ({
          ...item,
          ageMs: Number.isFinite(item.ageMs) ? item.ageMs : undefined,
        })),
        maxAgeMs: workerHeartbeatMaxAgeMs,
        protocolMatches: workerProtocolMatches,
        revisionMatches: workerRevisionMatches,
        targetMatches: workerTargetMatches,
      },
    },
    {
      id: "tenant_isolation_database",
      name: "Database tenant isolation",
      status: tenantIsolation.status === "passing" ? "pass" : "fail",
      summary: tenantIsolation.status === "passing"
        ? "All tracked tenant tables have tenant columns, forced RLS, and isolation policies."
        : "Tenant isolation schema evidence is incomplete.",
      details: {
        storageBackend: tenantIsolation.storageBackend,
        databaseConfigured: tenantIsolation.databaseConfigured,
        expectedTables: tenantIsolation.summary.expectedTables,
        protectedTables: tenantIsolation.summary.protectedTables,
        failingTables: tenantIsolation.summary.failingTables,
        missingTables: tenantIsolation.summary.missingTables,
        rlsDisabled: tenantIsolation.summary.rlsDisabled,
        forceRlsDisabled: tenantIsolation.summary.forceRlsDisabled,
        missingPolicies: tenantIsolation.summary.missingPolicies,
      },
    },
    {
      id: "latest_tenant_isolation_eval",
      name: "Tenant isolation evaluation",
      status: tenantIsolation.latestEval?.resultStatus === "pass"
        ? "pass"
        : tenantIsolation.latestEval?.resultStatus === "fail"
          ? "fail"
          : "warn",
      summary: tenantIsolation.latestEval
        ? `Latest security.tenant_isolation evaluation is ${tenantIsolation.latestEval.resultStatus}.`
        : "No security.tenant_isolation evaluation run is recorded for this tenant.",
      details: tenantIsolation.latestEval || { caseId: "security.tenant_isolation", present: false },
    },
    {
      id: "observability_slo",
      name: "Observability SLO snapshot",
      status: criticalBlockingBreaches.length
        ? "fail"
        : observabilitySlo.breaches.length
          ? "warn"
          : "pass",
      summary: criticalBlockingBreaches.length
        ? `${criticalBlockingBreaches.length} blocking critical SLO breach(es) are active.`
        : observabilitySlo.breaches.length
          ? `${observabilitySlo.breaches.length} advisory SLO breach(es) are active.`
          : "No active SLO breaches.",
      details: {
        healthy: observabilitySlo.healthy,
        policies: observabilitySlo.policies.length,
        breaches: observabilitySlo.breaches.map((breach) => ({
          policyId: breach.policy.id,
          severity: breach.severity,
          message: breach.message,
        })),
        advisoryPolicyIds: [...advisorySloPolicyIds],
      },
    },
    {
      id: "eval_report_signing",
      name: "Evaluation report signing",
      status: process.env.OMNIAGENT_REPORT_SIGNING_SECRET?.trim() ? "pass" : "warn",
      summary: process.env.OMNIAGENT_REPORT_SIGNING_SECRET?.trim()
        ? "Production evaluation report signing secret is configured."
        : "Evaluation report signing falls back outside the dedicated production signing key.",
      details: {
        configured: Boolean(process.env.OMNIAGENT_REPORT_SIGNING_SECRET?.trim()),
      },
    },
  ];

  const failures = gates.filter((gate) => gate.status === "fail");
  const warnings = gates.filter((gate) => gate.status === "warn");
  const releaseStatus = failures.length ? "blocked" : warnings.length ? "warning" : "passed";

  return {
    tenantId,
    checkedAt,
    deployment,
    releaseGate: {
      approved: failures.length === 0,
      status: releaseStatus,
      reasons: failures.map((gate) => `${gate.name}: ${gate.summary}`),
      warnings: warnings.map((gate) => `${gate.name}: ${gate.summary}`),
      summary: {
        total: gates.length,
        passed: gates.filter((gate) => gate.status === "pass").length,
        warnings: warnings.length,
        failures: failures.length,
      },
    },
    gates,
    tenantIsolation,
    observability: {
      checkedAt: observabilitySlo.checkedAt,
      healthy: observabilitySlo.healthy,
      policies: observabilitySlo.policies.length,
      breaches: observabilitySlo.breaches.map((breach) => ({
        policyId: breach.policy.id,
        name: breach.policy.name,
        severity: breach.severity,
        message: breach.message,
        value: breach.value,
        threshold: breach.threshold,
      })),
      stats: {
        total: observabilitySlo.stats.total,
        sloEligibleEvents: observabilitySlo.stats.sloEligibleEvents,
        sloExcludedEvents: observabilitySlo.stats.sloExcludedEvents,
        syntheticEvents: observabilitySlo.stats.syntheticEvents,
        routeFailures: observabilitySlo.stats.routeFailures,
        authFailures: observabilitySlo.stats.authFailures,
        authenticationChallenges: observabilitySlo.stats.authenticationChallenges,
        policyBlocks: observabilitySlo.stats.policyBlocks,
        connectorFailures: observabilitySlo.stats.connectorFailures,
        availability: observabilitySlo.stats.slo.availability,
        errorRate: observabilitySlo.stats.slo.errorRate,
        latencyP95Ms: observabilitySlo.stats.slo.latencyP95Ms,
      },
    },
    recommendations: buildReleaseRecommendations(gates, tenantIsolation.recommendations),
  };
}

function releaseEvidenceTtlMs() {
  return normalizePositiveInteger(
    process.env.OMNIAGENT_RELEASE_EVIDENCE_TTL_MS,
    30_000,
  );
}

function getDeploymentEvidence(): ReleaseEvidenceReport["deployment"] {
  const vercelUrl = process.env.VERCEL_URL?.trim();
  return {
    provider: process.env.VERCEL ? "vercel" : "local",
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    url: vercelUrl ? `https://${vercelUrl}` : process.env.NEXT_PUBLIC_APP_URL,
    commitSha:
      process.env.VERCEL_GIT_COMMIT_SHA ||
      process.env.OMNIAGENT_RELEASE_SHA,
    branch: process.env.VERCEL_GIT_COMMIT_REF,
    region: process.env.VERCEL_REGION,
  };
}

function normalizePositiveInteger(
  value: string | undefined,
  fallback: number,
) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeWorkerTarget(value?: string) {
  if (!value?.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function buildReleaseRecommendations(gates: ReleaseEvidenceGate[], tenantIsolationRecommendations: string[]) {
  const recommendations = gates
    .filter((gate) => gate.status !== "pass")
    .map((gate) => gate.summary);
  return [...new Set([...recommendations, ...tenantIsolationRecommendations])];
}
