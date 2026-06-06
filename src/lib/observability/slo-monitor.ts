import { enqueueAlertDeliveriesForIncident, type AlertDeliveryRecord } from "@/lib/diagnostics/alerts";
import {
  resolveIncidentByFingerprint,
  upsertIncidentFromSignal,
  type IncidentEventRecord,
  type IncidentRecord,
  type IncidentSeverity,
} from "@/lib/diagnostics/incidents";
import { getObservabilityStats, recordRuntimeEventSafely, type ObservabilityStats } from "@/lib/observability/store";

export type SloMetric = "errorRate" | "availability" | "latencyP95Ms" | "routeFailures";
export type SloComparator = "greater_than" | "greater_than_or_equal" | "less_than" | "less_than_or_equal";

export type ObservabilitySloPolicy = {
  id: string;
  name: string;
  description: string;
  metric: SloMetric;
  comparator: SloComparator;
  warningThreshold: number;
  criticalThreshold: number;
  unit: "ratio" | "ms" | "count";
  componentId: string;
  enabled: boolean;
};

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
  alertDeliveries: AlertDeliveryRecord[];
};

export type ObservabilitySloMonitorResult = ObservabilitySloSnapshot & {
  trigger: string;
  actorId: string;
  queuedAlerts: number;
  incidentActions: ObservabilitySloIncidentAction[];
};

export const observabilitySloIncidentPrefix = "observability:slo";

export function getDefaultObservabilitySloPolicies(): ObservabilitySloPolicy[] {
  return [
    {
      id: "error_budget",
      name: "Error budget burn",
      description: "Runtime error events must stay within a 2% operating budget across the recent event window.",
      metric: "errorRate",
      comparator: "greater_than",
      warningThreshold: 0.02,
      criticalThreshold: 0.1,
      unit: "ratio",
      componentId: "observability",
      enabled: true,
    },
    {
      id: "availability_floor",
      name: "Availability floor",
      description: "Route-level availability should stay at or above 99.5% across the recent event window.",
      metric: "availability",
      comparator: "less_than",
      warningThreshold: 0.995,
      criticalThreshold: 0.98,
      unit: "ratio",
      componentId: "observability",
      enabled: true,
    },
    {
      id: "route_failures",
      name: "Route failure budget",
      description: "Any route failure is surfaced immediately; five or more recent failures escalate to critical.",
      metric: "routeFailures",
      comparator: "greater_than_or_equal",
      warningThreshold: 1,
      criticalThreshold: 5,
      unit: "count",
      componentId: "observability",
      enabled: true,
    },
    {
      id: "latency_p95",
      name: "P95 latency ceiling",
      description: "The recent runtime event P95 latency should stay below eight seconds.",
      metric: "latencyP95Ms",
      comparator: "greater_than",
      warningThreshold: 8000,
      criticalThreshold: 15000,
      unit: "ms",
      componentId: "observability",
      enabled: true,
    },
  ];
}

export async function getObservabilitySloSnapshot({
  policies = getDefaultObservabilitySloPolicies(),
}: {
  policies?: ObservabilitySloPolicy[];
} = {}): Promise<ObservabilitySloSnapshot> {
  const stats = await getObservabilityStats();
  const enabledPolicies = policies.filter((policy) => policy.enabled);
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
}: {
  trigger?: string;
  actorId?: string;
  correlationId?: string;
  queueAlerts?: boolean;
  resolveRecovered?: boolean;
  policies?: ObservabilitySloPolicy[];
} = {}): Promise<ObservabilitySloMonitorResult> {
  const snapshot = await getObservabilitySloSnapshot({ policies });
  const incidentActions: ObservabilitySloIncidentAction[] = [];
  let queuedAlerts = 0;

  for (const evaluation of snapshot.evaluations) {
    const fingerprint = createSloIncidentFingerprint(evaluation.policy);
    if (!evaluation.breached || !evaluation.severity) {
      if (resolveRecovered) {
        const resolved = await resolveIncidentByFingerprint(fingerprint, {
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
      fingerprint,
      componentId: evaluation.policy.componentId,
      severity: evaluation.severity,
      title: `Observability SLO breach: ${evaluation.policy.name}`,
      message: evaluation.message,
      actorId,
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
          errorRate: snapshot.stats.slo.errorRate,
          availability: snapshot.stats.slo.availability,
          latencyP95Ms: snapshot.stats.slo.latencyP95Ms,
        },
      },
    });
    let alertDeliveries: AlertDeliveryRecord[] = [];
    if (queueAlerts && shouldQueueAlert(upserted)) {
      alertDeliveries = await enqueueAlertDeliveriesForIncident(upserted.incident, {
        eventId: upserted.event.id,
        reason: `observability.slo.${evaluation.policy.id}`,
      });
      queuedAlerts += alertDeliveries.length;
    }
    incidentActions.push({
      policyId: evaluation.policy.id,
      fingerprint,
      incident: upserted.incident,
      event: upserted.event,
      created: upserted.created,
      reopened: upserted.reopened,
      severityChanged: upserted.severityChanged,
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

export function createSloIncidentFingerprint(policy: ObservabilitySloPolicy) {
  return `${observabilitySloIncidentPrefix}:${policy.id}`;
}

function evaluateSloPolicy(policy: ObservabilitySloPolicy, stats: ObservabilityStats): ObservabilitySloEvaluation {
  const value = metricValue(policy.metric, stats);
  const critical = compare(value, policy.comparator, policy.criticalThreshold);
  const warning = compare(value, policy.comparator, policy.warningThreshold);
  const severity: IncidentSeverity | undefined = critical ? "critical" : warning ? "warning" : undefined;
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
}) {
  return input.created || input.reopened || input.severityChanged;
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
