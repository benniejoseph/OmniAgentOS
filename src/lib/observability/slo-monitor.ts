import { enqueueAlertDeliveriesForIncident, type AlertDeliveryRecord } from "@/lib/diagnostics/alerts";
import {
  getDatabaseTenantContext,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import {
  getIncidentAlertTargets,
  resolveIncidentByFingerprint,
  updateIncidentMetadata,
  upsertIncidentFromSignal,
  type IncidentEventRecord,
  type IncidentRecord,
  type IncidentSeverity,
} from "@/lib/diagnostics/incidents";
import {
  listObservabilitySloPolicies,
  type ObservabilitySloPolicy,
  type SloComparator,
  type SloMetric,
} from "@/lib/observability/slo-policy-store";
import { getObservabilityStats, recordRuntimeEventSafely, type ObservabilityStats } from "@/lib/observability/store";

export { getDefaultObservabilitySloPolicies } from "@/lib/observability/slo-policy-store";
export type { ObservabilitySloPolicy, SloComparator, SloMetric } from "@/lib/observability/slo-policy-store";

export type ObservabilitySloEvaluation = {
  policy: ObservabilitySloPolicy;
  value: number;
  breached: boolean;
  severity?: IncidentSeverity;
  threshold?: number;
  margin: number;
  message: string;
};

export type ObservabilitySloSnapshot = {
  checkedAt: string;
  healthy: boolean;
  stats: ObservabilityStats;
  policies: ObservabilitySloPolicy[];
  evaluations: ObservabilitySloEvaluation[];
  breaches: ObservabilitySloEvaluation[];
};

export type ObservabilitySloIncidentAction = {
  policyId: string;
  fingerprint: string;
  incident?: IncidentRecord;
  event?: IncidentEventRecord;
  created?: boolean;
  reopened?: boolean;
  severityChanged?: boolean;
  resolved?: boolean;
  alertSuppressed?: boolean;
  alertDeliveries: AlertDeliveryRecord[];
};

export type ObservabilitySloMonitorResult = ObservabilitySloSnapshot & {
  trigger: string;
  actorId: string;
  queuedAlerts: number;
  incidentActions: ObservabilitySloIncidentAction[];
};

export const observabilitySloIncidentPrefix = "observability:slo";

export async function getObservabilitySloSnapshot({
  policies,
  tenantId,
}: {
  policies?: ObservabilitySloPolicy[];
  tenantId?: string;
} = {}): Promise<ObservabilitySloSnapshot> {
  const scopedTenantId = normalizeTenantId(tenantId);
  return runWithDatabaseTenantScope(scopedTenantId, () =>
    getObservabilitySloSnapshotForTenant({
      policies,
      tenantId: scopedTenantId,
    }),
  );
}

async function getObservabilitySloSnapshotForTenant({
  policies,
  tenantId,
}: {
  policies?: ObservabilitySloPolicy[];
  tenantId: string;
}): Promise<ObservabilitySloSnapshot> {
  const stats = await getObservabilityStats({ tenantId });
  const enabledPolicies = (policies || await listObservabilitySloPolicies({
    tenantId,
    includeDisabled: false,
  }))
    .filter((policy) => policy.enabled);
  const evaluations = enabledPolicies.map((policy) => evaluateSloPolicy(policy, stats));
  const breaches = evaluations.filter((evaluation) => evaluation.breached);

  return {
    checkedAt: new Date().toISOString(),
    healthy: breaches.length === 0,
    stats,
    policies: enabledPolicies,
    evaluations,
    breaches,
  };
}

export async function runObservabilitySloMonitor({
  trigger = "operator",
  actorId = "system",
  correlationId,
  queueAlerts = true,
  resolveRecovered = true,
  policies,
  tenantId,
}: {
  trigger?: string;
  actorId?: string;
  correlationId?: string;
  queueAlerts?: boolean;
  resolveRecovered?: boolean;
  policies?: ObservabilitySloPolicy[];
  tenantId?: string;
} = {}): Promise<ObservabilitySloMonitorResult> {
  const scopedTenantId = normalizeTenantId(tenantId);
  return runWithDatabaseTenantScope(scopedTenantId, () =>
    runObservabilitySloMonitorForTenant({
      trigger,
      actorId,
      correlationId,
      queueAlerts,
      resolveRecovered,
      policies,
      tenantId: scopedTenantId,
    }),
  );
}

async function runObservabilitySloMonitorForTenant({
  trigger,
  actorId,
  correlationId,
  queueAlerts,
  resolveRecovered,
  policies,
  tenantId,
}: {
  trigger: string;
  actorId: string;
  correlationId?: string;
  queueAlerts: boolean;
  resolveRecovered: boolean;
  policies?: ObservabilitySloPolicy[];
  tenantId: string;
}): Promise<ObservabilitySloMonitorResult> {
  const snapshot = await getObservabilitySloSnapshot({ policies, tenantId });
  const incidentActions: ObservabilitySloIncidentAction[] = [];
  let queuedAlerts = 0;

  for (const evaluation of snapshot.evaluations) {
    const fingerprint = createSloIncidentFingerprint(evaluation.policy);
    if (!evaluation.breached || !evaluation.severity) {
      if (resolveRecovered) {
        const resolved = await resolveIncidentByFingerprint(fingerprint, {
          tenantId,
          actorId,
          resolution: `${evaluation.policy.name} recovered inside SLO.`,
          metadata: {
            trigger,
            policyId: evaluation.policy.id,
            value: evaluation.value,
            threshold: evaluation.threshold,
            checkedAt: snapshot.checkedAt,
          },
        });
        if (resolved) {
          incidentActions.push({
            policyId: evaluation.policy.id,
            fingerprint,
            incident: resolved.incident,
            event: resolved.event,
            resolved: true,
            alertDeliveries: [],
          });
        }
      }
      continue;
    }

    const upserted = await upsertIncidentFromSignal({
      tenantId,
      fingerprint,
      componentId: evaluation.policy.componentId,
      severity: evaluation.severity,
      title: `Observability SLO breach: ${evaluation.policy.name}`,
      message: evaluation.message,
      actorId,
      alertTargets: alertTargetsForPolicy(evaluation.policy, evaluation.severity),
      metadata: {
        source: "observability_slo_monitor",
        trigger,
        policyId: evaluation.policy.id,
        metric: evaluation.policy.metric,
        comparator: evaluation.policy.comparator,
        value: evaluation.value,
        threshold: evaluation.threshold,
        margin: evaluation.margin,
        checkedAt: snapshot.checkedAt,
        stats: {
          total: snapshot.stats.total,
          routeFailures: snapshot.stats.routeFailures,
          authFailures: snapshot.stats.authFailures,
          policyBlocks: snapshot.stats.policyBlocks,
          connectorFailures: snapshot.stats.connectorFailures,
          errorRate: snapshot.stats.slo.errorRate,
          availability: snapshot.stats.slo.availability,
          latencyP95Ms: snapshot.stats.slo.latencyP95Ms,
        },
      },
    });
    let alertDeliveries: AlertDeliveryRecord[] = [];
    const alertDecision = shouldQueueAlert({
      ...upserted,
      policy: evaluation.policy,
      checkedAt: snapshot.checkedAt,
      severity: evaluation.severity,
    });
    if (queueAlerts && alertDecision.queue) {
      alertDeliveries = await enqueueAlertDeliveriesForIncident(upserted.incident, {
        eventId: upserted.event.id,
        reason: `observability.slo.${evaluation.policy.id}`,
      });
      queuedAlerts += alertDeliveries.length;
      await updateIncidentMetadata(upserted.incident.id, {
        sloLastAlertedAt: snapshot.checkedAt,
        sloLastAlertPolicyId: evaluation.policy.id,
        sloLastAlertSeverity: evaluation.severity,
      }, { tenantId }).catch(() => undefined);
    }
    incidentActions.push({
      policyId: evaluation.policy.id,
      fingerprint,
      incident: upserted.incident,
      event: upserted.event,
      created: upserted.created,
      reopened: upserted.reopened,
      severityChanged: upserted.severityChanged,
      alertSuppressed: alertDecision.suppressed,
      alertDeliveries,
    });
  }

  await recordRuntimeEventSafely({
    level: snapshot.healthy ? "info" : "warn",
    category: "alert",
    action: "observability.slo_monitor",
    correlationId,
    resourceType: "observability_slo",
    message: snapshot.healthy
      ? "Observability SLO monitor completed without breaches."
      : `Observability SLO monitor detected ${snapshot.breaches.length} breach(es).`,
    metadata: {
      trigger,
      actorId,
      healthy: snapshot.healthy,
      breaches: snapshot.breaches.map((evaluation) => ({
        policyId: evaluation.policy.id,
        severity: evaluation.severity,
        value: evaluation.value,
        threshold: evaluation.threshold,
        metric: evaluation.policy.metric,
        suppressionMinutes: evaluation.policy.suppressionMinutes,
        alertTargetIds: evaluation.policy.alertTargetIds,
      })),
      queuedAlerts,
      incidentActions: incidentActions.length,
    },
  });

  return {
    ...snapshot,
    trigger,
    actorId,
    queuedAlerts,
    incidentActions,
  };
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

export function createSloIncidentFingerprint(policy: ObservabilitySloPolicy) {
  return `${observabilitySloIncidentPrefix}:${policy.id}`;
}

function evaluateSloPolicy(policy: ObservabilitySloPolicy, stats: ObservabilityStats): ObservabilitySloEvaluation {
  const value = metricValue(policy.metric, stats);
  const critical = compare(value, policy.comparator, policy.criticalThreshold);
  const warning = compare(value, policy.comparator, policy.warningThreshold);
  const severity: IncidentSeverity | undefined = critical
    ? policy.criticalSeverity
    : warning
      ? policy.warningSeverity
      : undefined;
  const threshold = critical ? policy.criticalThreshold : warning ? policy.warningThreshold : undefined;

  return {
    policy,
    value,
    breached: Boolean(severity),
    severity,
    threshold,
    margin: threshold === undefined ? 0 : roundMetric(Math.abs(value - threshold)),
    message: severity
      ? `${policy.name} breached: ${formatMetric(value, policy.unit)} ${describeComparator(policy.comparator)} ${formatMetric(threshold!, policy.unit)}.`
      : `${policy.name} is inside SLO at ${formatMetric(value, policy.unit)}.`,
  };
}

function shouldQueueAlert(input: {
  created: boolean;
  reopened: boolean;
  severityChanged: boolean;
  incident: IncidentRecord;
  policy: ObservabilitySloPolicy;
  checkedAt: string;
  severity: IncidentSeverity;
}) {
  if (input.created || input.reopened || input.severityChanged) {
    return { queue: true, suppressed: false };
  }

  const lastAlertedAt = typeof input.incident.metadata.sloLastAlertedAt === "string"
    ? Date.parse(input.incident.metadata.sloLastAlertedAt)
    : 0;
  const suppressionMs = input.policy.suppressionMinutes * 60 * 1000;
  const suppressed = suppressionMs > 0 && lastAlertedAt > 0 && Date.parse(input.checkedAt) - lastAlertedAt < suppressionMs;
  return {
    queue: input.severity === "critical" && !suppressed,
    suppressed,
  };
}

function alertTargetsForPolicy(policy: ObservabilitySloPolicy, severity: IncidentSeverity) {
  const targets = getIncidentAlertTargets(severity);
  if (!policy.alertTargetIds.length) {
    return targets;
  }
  const allowed = new Set(policy.alertTargetIds);
  return targets.filter((target) => allowed.has(target.id));
}

function metricValue(metric: SloMetric, stats: ObservabilityStats) {
  if (metric === "errorRate") {
    return roundMetric(stats.slo.errorRate);
  }
  if (metric === "availability") {
    return roundMetric(stats.slo.availability);
  }
  if (metric === "latencyP95Ms") {
    return stats.slo.latencyP95Ms;
  }
  if (metric === "authFailures") {
    return stats.authFailures;
  }
  if (metric === "policyBlocks") {
    return stats.policyBlocks;
  }
  if (metric === "connectorFailures") {
    return stats.connectorFailures;
  }
  return stats.routeFailures;
}

function compare(value: number, comparator: SloComparator, threshold: number) {
  if (comparator === "greater_than") {
    return value > threshold;
  }
  if (comparator === "greater_than_or_equal") {
    return value >= threshold;
  }
  if (comparator === "less_than") {
    return value < threshold;
  }
  return value <= threshold;
}

function describeComparator(comparator: SloComparator) {
  if (comparator === "greater_than") {
    return "is greater than";
  }
  if (comparator === "greater_than_or_equal") {
    return "is at least";
  }
  if (comparator === "less_than") {
    return "is less than";
  }
  return "is at most";
}

function formatMetric(value: number, unit: ObservabilitySloPolicy["unit"]) {
  if (unit === "ratio") {
    return `${Math.round(value * 10000) / 100}%`;
  }
  if (unit === "ms") {
    return `${value}ms`;
  }
  return `${value}`;
}

function roundMetric(value: number) {
  return Math.round(value * 10000) / 10000;
}
