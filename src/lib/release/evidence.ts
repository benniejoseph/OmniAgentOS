import { getObservabilitySloSnapshot } from "@/lib/observability/slo-monitor";
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
      routeFailures: number;
      authFailures: number;
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

export async function getReleaseEvidenceReport(tenantId: string): Promise<ReleaseEvidenceReport> {
  const checkedAt = new Date().toISOString();
  const [tenantIsolation, observabilitySlo] = await Promise.all([
    getTenantIsolationReport(tenantId),
    getObservabilitySloSnapshot({ tenantId }),
  ]);

  const deployment = getDeploymentEvidence();
  const criticalBlockingBreaches = observabilitySlo.breaches.filter(
    (breach) => breach.severity === "critical" && !advisorySloPolicyIds.has(breach.policy.id),
  );

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
        routeFailures: observabilitySlo.stats.routeFailures,
        authFailures: observabilitySlo.stats.authFailures,
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

function getDeploymentEvidence(): ReleaseEvidenceReport["deployment"] {
  const vercelUrl = process.env.VERCEL_URL?.trim();
  return {
    provider: process.env.VERCEL ? "vercel" : "local",
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    url: vercelUrl ? `https://${vercelUrl}` : process.env.NEXT_PUBLIC_APP_URL,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA,
    branch: process.env.VERCEL_GIT_COMMIT_REF,
    region: process.env.VERCEL_REGION,
  };
}

function buildReleaseRecommendations(gates: ReleaseEvidenceGate[], tenantIsolationRecommendations: string[]) {
  const recommendations = gates
    .filter((gate) => gate.status !== "pass")
    .map((gate) => gate.summary);
  return [...new Set([...recommendations, ...tenantIsolationRecommendations])];
}
