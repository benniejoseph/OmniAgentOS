import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import type { HealthIncident, SystemHealthRecord } from "@/lib/diagnostics/health";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type IncidentSeverity = "info" | "warning" | "critical";
export type IncidentStatus = "open" | "acknowledged" | "resolved";
export type IncidentEventType =
  | "opened"
  | "observed"
  | "reopened"
  | "acknowledged"
  | "resolved"
  | "playbook_run"
  | "alert_routed"
  | "alert_delivery_queued"
  | "alert_delivered"
  | "alert_delivery_failed";

export type IncidentAlertTarget = {
  id: string;
  name: string;
  channel: "dashboard" | "ops" | "webhook" | "email" | "slack";
  status: "ready" | "requires_config";
  targetEnv?: string;
  description: string;
};

export type IncidentPlaybook = {
  id: string;
  name: string;
  description: string;
  componentIds: string[];
  automation: "diagnostics_repair" | "health_recheck" | "manual";
  autoRunnable: boolean;
  riskLevel: 0 | 1 | 2 | 3;
};

export type IncidentRecord = {
  id: string;
  tenantId: string;
  fingerprint: string;
  componentId: string;
  severity: IncidentSeverity;
  status: IncidentStatus;
  title: string;
  message: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckId?: string;
  occurrenceCount: number;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  acknowledgementReason?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  alertTargets: IncidentAlertTarget[];
  playbookIds: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type IncidentEventRecord = {
  id: string;
  tenantId: string;
  incidentId: string;
  type: IncidentEventType;
  actorId?: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type IncidentLedger = {
  incidents: IncidentRecord[];
  events: IncidentEventRecord[];
};

export type IncidentStats = {
  total: number;
  open: number;
  acknowledged: number;
  resolved: number;
  active: number;
  criticalOpen: number;
  warningOpen: number;
  byComponent: Record<string, number>;
  latest: IncidentRecord[];
  latestEvents: IncidentEventRecord[];
  playbooks: IncidentPlaybook[];
  alertTargets: IncidentAlertTarget[];
};

type ListIncidentOptions = {
  tenantId?: string;
  status?: IncidentStatus | "active" | "all";
  limit?: number;
};

type IncidentSyncResult = {
  incidents: IncidentRecord[];
  events: IncidentEventRecord[];
};

const playbooks: IncidentPlaybook[] = [
  {
    id: "diagnostics.repair_runtime",
    name: "Repair runtime leases",
    description: "Run diagnostics repair to release expired queue leases and requeue stale workflows.",
    componentIds: ["operation_queue", "workflows"],
    automation: "diagnostics_repair",
    autoRunnable: true,
    riskLevel: 1,
  },
  {
    id: "diagnostics.recheck",
    name: "Recheck health",
    description: "Run a fresh diagnostics pass and persist updated component evidence.",
    componentIds: ["*"],
    automation: "health_recheck",
    autoRunnable: true,
    riskLevel: 0,
  },
  {
    id: "connectors.review_credentials",
    name: "Review connector credentials",
    description: "Inspect connector env-var references, failed imports, and external API reachability.",
    componentIds: ["connectors"],
    automation: "manual",
    autoRunnable: false,
    riskLevel: 2,
  },
  {
    id: "vector_store.rebuild_index",
    name: "Rebuild vector index",
    description: "Verify pgvector extension state, embedding dimensions, vector columns, and HNSW indexes.",
    componentIds: ["vector_store"],
    automation: "manual",
    autoRunnable: false,
    riskLevel: 2,
  },
  {
    id: "evaluations.run_regression",
    name: "Run regression suite",
    description: "Run focused evaluations to isolate degraded quality, latency, or workflow regressions.",
    componentIds: ["evaluations", "planner", "tools", "triggers"],
    automation: "manual",
    autoRunnable: false,
    riskLevel: 1,
  },
];

export function getIncidentPlaybooks() {
  return playbooks;
}

export function getIncidentAlertTargets(severity: IncidentSeverity = "warning"): IncidentAlertTarget[] {
  const targets: IncidentAlertTarget[] = [
    {
      id: "dashboard",
      name: "Command center",
      channel: "dashboard",
      status: "ready",
      description: "Show active incidents in the operations center.",
    },
    {
      id: "ops-ledger",
      name: "Ops ledger",
      channel: "ops",
      status: "ready",
      description: "Persist incident events, acknowledgements, resolutions, and playbook runs.",
    },
    {
      id: "webhook",
      name: "Webhook route",
      channel: "webhook",
      status: process.env.OMNIAGENT_ALERT_WEBHOOK_URL ? "ready" : "requires_config",
      targetEnv: "OMNIAGENT_ALERT_WEBHOOK_URL",
      description: "Route critical incident notifications to an external incident webhook.",
    },
    {
      id: "email",
      name: "Email route",
      channel: "email",
      status: process.env.OMNIAGENT_ALERT_EMAIL_TO && process.env.RESEND_API_KEY ? "ready" : "requires_config",
      targetEnv: "OMNIAGENT_ALERT_EMAIL_TO",
      description: "Route incident summaries to an operator email address.",
    },
    {
      id: "slack",
      name: "Slack route",
      channel: "slack",
      status: process.env.SLACK_WEBHOOK_URL ? "ready" : "requires_config",
      targetEnv: "SLACK_WEBHOOK_URL",
      description: "Route incident summaries to a Slack incoming webhook.",
    },
  ];

  if (severity === "critical") {
    return targets;
  }

  return targets.filter((target) => target.channel === "dashboard" || target.channel === "ops");
}

export async function syncIncidentsFromHealthCheck(check: SystemHealthRecord): Promise<IncidentSyncResult> {
  const tenantId = normalizeTenantId(check.tenantId);
  const now = new Date().toISOString();
  const activeFingerprints = new Set(check.incidents.map(createIncidentFingerprint));
  const checkedComponentIds = new Set(check.components.map((component) => component.id));
  const changedIncidents: IncidentRecord[] = [];
  const events: IncidentEventRecord[] = [];

  for (const healthIncident of check.incidents) {
    const component = check.components.find((item) => item.id === healthIncident.componentId);
    const fingerprint = createIncidentFingerprint(healthIncident);
    const existing = await getIncidentByFingerprint(fingerprint, tenantId);
    const selectedPlaybookIds = selectPlaybookIds(healthIncident.componentId);
    const alertTargets = getIncidentAlertTargets(healthIncident.severity);

    if (!existing) {
      const record: IncidentRecord = {
        id: randomUUID(),
        tenantId,
        fingerprint,
        componentId: healthIncident.componentId,
        severity: healthIncident.severity,
        status: "open",
        title: component ? `${component.name} ${healthIncident.severity}` : `${healthIncident.componentId} ${healthIncident.severity}`,
        message: healthIncident.message,
        firstSeenAt: check.createdAt,
        lastSeenAt: check.createdAt,
        lastCheckId: check.id,
        occurrenceCount: 1,
        alertTargets,
        playbookIds: selectedPlaybookIds,
        metadata: {
          healthIncidentId: healthIncident.id,
          componentMetrics: component?.metrics || healthIncident.metadata || {},
          checkStatus: check.status,
        },
        createdAt: now,
        updatedAt: now,
      };
      await saveIncident(record);
      changedIncidents.push(record);
      events.push(await recordIncidentEvent({
        tenantId,
        incidentId: record.id,
        type: "opened",
        message: `Opened ${record.severity} incident for ${record.componentId}.`,
        metadata: { checkId: check.id, fingerprint },
      }));
      const alertEvent = await recordIncidentEvent({
        tenantId,
        incidentId: record.id,
        type: "alert_routed",
        message: `Routed incident to ${alertTargets.filter((target) => target.status === "ready").length} ready target(s).`,
        metadata: { targets: alertTargets },
      });
      events.push(alertEvent);
      await enqueueAlertDeliverySafely(record, alertEvent.id, "incident.opened");
      continue;
    }

    const wasResolved = existing.status === "resolved";
    const record: IncidentRecord = {
      ...existing,
      severity: healthIncident.severity,
      status: wasResolved ? "open" : existing.status,
      message: healthIncident.message,
      lastSeenAt: check.createdAt,
      lastCheckId: check.id,
      occurrenceCount: existing.occurrenceCount + 1,
      resolvedAt: wasResolved ? undefined : existing.resolvedAt,
      resolvedBy: wasResolved ? undefined : existing.resolvedBy,
      resolution: wasResolved ? undefined : existing.resolution,
      alertTargets,
      playbookIds: selectedPlaybookIds,
      metadata: {
        ...existing.metadata,
        healthIncidentId: healthIncident.id,
        componentMetrics: component?.metrics || healthIncident.metadata || {},
        checkStatus: check.status,
      },
      updatedAt: now,
    };
    await saveIncident(record);
    changedIncidents.push(record);
    const observedEvent = await recordIncidentEvent({
      tenantId,
      incidentId: record.id,
      type: wasResolved ? "reopened" : "observed",
      message: wasResolved
        ? `Reopened incident for ${record.componentId}.`
        : `Observed incident for ${record.componentId}.`,
      metadata: { checkId: check.id, fingerprint, status: record.status },
    });
    events.push(observedEvent);
    if (wasResolved || record.severity === "critical") {
      await enqueueAlertDeliverySafely(record, observedEvent.id, wasResolved ? "incident.reopened" : "incident.observed");
    }
  }

  const activeIncidents = await listIncidents({ tenantId, status: "active", limit: 500 });
  for (const incident of activeIncidents) {
    if (!checkedComponentIds.has(incident.componentId) || activeFingerprints.has(incident.fingerprint)) {
      continue;
    }
    const resolved = await resolveIncident(incident.id, {
      tenantId,
      actorId: "system",
      resolution: `Resolved by health check ${check.id}.`,
      metadata: { checkId: check.id },
    });
    if (resolved) {
      changedIncidents.push(resolved.incident);
      events.push(resolved.event);
    }
  }

  return { incidents: changedIncidents, events };
}

async function enqueueAlertDeliverySafely(incident: IncidentRecord, eventId: string, reason: string) {
  try {
    const { enqueueAlertDeliveriesForIncident } = await import("@/lib/diagnostics/alerts");
    await enqueueAlertDeliveriesForIncident(incident, { eventId, reason });
  } catch (error) {
    console.warn("Alert delivery enqueue failed.", error instanceof Error ? error.message : error);
  }
}

export async function listIncidents(options: ListIncidentOptions = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 50, 1), 500);
  const status = options.status || "active";

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = status === "all"
      ? await getSql()`
          SELECT *
          FROM omni_incidents
          WHERE tenant_id = ${tenantId}
          ORDER BY updated_at DESC
          LIMIT ${limit}
        `
      : status === "active"
        ? await getSql()`
            SELECT *
            FROM omni_incidents
            WHERE tenant_id = ${tenantId}
              AND status IN ('open', 'acknowledged')
            ORDER BY updated_at DESC
            LIMIT ${limit}
          `
        : await getSql()`
            SELECT *
            FROM omni_incidents
            WHERE tenant_id = ${tenantId}
              AND status = ${status}
            ORDER BY updated_at DESC
            LIMIT ${limit}
          `;
    return rows.map(incidentFromRow);
  }

  const ledger = await readIncidentLedger();
  return ledger.incidents
    .filter((incident) => incidentTenantId(incident) === tenantId)
    .filter((incident) => status === "all" || (status === "active" ? incident.status !== "resolved" : incident.status === status))
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, limit);
}

export async function getIncident(
  incidentId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_incidents
      WHERE id = ${incidentId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return rows[0] ? incidentFromRow(rows[0]) : null;
  }

  const ledger = await readIncidentLedger();
  return ledger.incidents.find(
    (incident) => incident.id === incidentId && incidentTenantId(incident) === tenantId,
  ) || null;
}

export async function getIncidentDetail(
  incidentId: string,
  options: { tenantId?: string } = {},
) {
  const incident = await getIncident(incidentId, options);
  if (!incident) {
    return null;
  }

  return {
    incident,
    events: await listIncidentEvents(incidentId, 100, options),
    playbooks: playbooks.filter((playbook) => incident.playbookIds.includes(playbook.id)),
  };
}

export async function listIncidentEvents(
  incidentId: string,
  limit = 50,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_incident_events
      WHERE incident_id = ${incidentId}
        AND tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(incidentEventFromRow);
  }

  const ledger = await readIncidentLedger();
  return ledger.events
    .filter(
      (event) => event.incidentId === incidentId && incidentEventTenantId(event) === tenantId,
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, boundedLimit);
}

export async function getIncidentStats(
  options: { tenantId?: string } = {},
): Promise<IncidentStats> {
  const [incidents, latestEvents] = await Promise.all([
    listIncidents({ ...options, status: "all", limit: 500 }),
    listLatestIncidentEvents(10, options),
  ]);
  const active = incidents.filter((incident) => incident.status !== "resolved");

  return {
    total: incidents.length,
    open: incidents.filter((incident) => incident.status === "open").length,
    acknowledged: incidents.filter((incident) => incident.status === "acknowledged").length,
    resolved: incidents.filter((incident) => incident.status === "resolved").length,
    active: active.length,
    criticalOpen: active.filter((incident) => incident.severity === "critical").length,
    warningOpen: active.filter((incident) => incident.severity === "warning").length,
    byComponent: active.reduce<Record<string, number>>((acc, incident) => {
      acc[incident.componentId] = (acc[incident.componentId] || 0) + 1;
      return acc;
    }, {}),
    latest: active.slice(0, 5),
    latestEvents,
    playbooks,
    alertTargets: getIncidentAlertTargets("critical"),
  };
}

export async function acknowledgeIncident(
  incidentId: string,
  input: {
    tenantId?: string;
    actorId: string;
    reason?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const incident = await getIncident(incidentId, { tenantId: input.tenantId });
  if (!incident) {
    return null;
  }

  const now = new Date().toISOString();
  const next: IncidentRecord = {
    ...incident,
    status: incident.status === "resolved" ? "resolved" : "acknowledged",
    acknowledgedAt: incident.status === "resolved" ? incident.acknowledgedAt : now,
    acknowledgedBy: incident.status === "resolved" ? incident.acknowledgedBy : input.actorId,
    acknowledgementReason: input.reason || incident.acknowledgementReason,
    updatedAt: now,
  };
  await saveIncident(next);
  const event = await recordIncidentEvent({
    tenantId: incident.tenantId,
    incidentId,
    type: "acknowledged",
    actorId: input.actorId,
    message: input.reason ? `Acknowledged: ${input.reason}` : "Acknowledged incident.",
    metadata: input.metadata || {},
  });

  return { incident: next, event };
}

export async function resolveIncident(
  incidentId: string,
  input: {
    tenantId?: string;
    actorId: string;
    resolution?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const incident = await getIncident(incidentId, { tenantId: input.tenantId });
  if (!incident) {
    return null;
  }

  const now = new Date().toISOString();
  const next: IncidentRecord = {
    ...incident,
    status: "resolved",
    resolvedAt: now,
    resolvedBy: input.actorId,
    resolution: input.resolution || "Resolved by operator.",
    updatedAt: now,
  };
  await saveIncident(next);
  const event = await recordIncidentEvent({
    tenantId: incident.tenantId,
    incidentId,
    type: "resolved",
    actorId: input.actorId,
    message: next.resolution || "Resolved incident.",
    metadata: input.metadata || {},
  });

  return { incident: next, event };
}

export async function upsertIncidentFromSignal(input: {
  tenantId?: string;
  fingerprint: string;
  componentId: string;
  severity: IncidentSeverity;
  title: string;
  message: string;
  actorId?: string;
  metadata?: Record<string, unknown>;
  playbookIds?: string[];
  alertTargets?: IncidentAlertTarget[];
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const now = new Date().toISOString();
  const existing = await getIncidentByFingerprint(input.fingerprint, tenantId);
  const alertTargets = input.alertTargets || getIncidentAlertTargets(input.severity);
  const playbookIds = input.playbookIds || selectPlaybookIds(input.componentId);

  if (!existing) {
    const incident: IncidentRecord = {
      id: randomUUID(),
      tenantId,
      fingerprint: input.fingerprint,
      componentId: input.componentId,
      severity: input.severity,
      status: "open",
      title: input.title,
      message: input.message,
      firstSeenAt: now,
      lastSeenAt: now,
      occurrenceCount: 1,
      alertTargets,
      playbookIds,
      metadata: input.metadata || {},
      createdAt: now,
      updatedAt: now,
    };
    await saveIncident(incident);
    const event = await recordIncidentEvent({
      tenantId,
      incidentId: incident.id,
      type: "opened",
      actorId: input.actorId,
      message: `Opened ${incident.severity} incident for ${incident.componentId}.`,
      metadata: { fingerprint: input.fingerprint, ...(input.metadata || {}) },
    });
    await recordIncidentEvent({
      tenantId,
      incidentId: incident.id,
      type: "alert_routed",
      actorId: input.actorId,
      message: `Routed incident to ${alertTargets.filter((target) => target.status === "ready").length} ready target(s).`,
      metadata: { targets: alertTargets },
    }).catch(() => undefined);
    return {
      incident,
      event,
      created: true,
      reopened: false,
      severityChanged: false,
    };
  }

  const severityChanged = existing.severity !== input.severity;
  const escalated = severityRank(input.severity) > severityRank(existing.severity);
  const reopened = existing.status === "resolved";
  const incident: IncidentRecord = {
    ...existing,
    severity: input.severity,
    status: reopened || escalated ? "open" : existing.status,
    title: input.title,
    message: input.message,
    lastSeenAt: now,
    occurrenceCount: existing.occurrenceCount + 1,
    resolvedAt: reopened ? undefined : existing.resolvedAt,
    resolvedBy: reopened ? undefined : existing.resolvedBy,
    resolution: reopened ? undefined : existing.resolution,
    alertTargets,
    playbookIds,
    metadata: {
      ...existing.metadata,
      ...(input.metadata || {}),
    },
    updatedAt: now,
  };
  await saveIncident(incident);
  const event = await recordIncidentEvent({
    tenantId,
    incidentId: incident.id,
    type: reopened ? "reopened" : "observed",
    actorId: input.actorId,
    message: reopened
      ? `Reopened incident for ${incident.componentId}.`
      : `Observed incident for ${incident.componentId}.`,
    metadata: {
      fingerprint: input.fingerprint,
      severityChanged,
      previousSeverity: existing.severity,
      ...(input.metadata || {}),
    },
  });

  return {
    incident,
    event,
    created: false,
    reopened,
    severityChanged,
  };
}

export async function resolveIncidentByFingerprint(
  fingerprint: string,
  input: {
    tenantId?: string;
    actorId: string;
    resolution?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const incident = await getIncidentByFingerprint(fingerprint, input.tenantId);
  if (!incident || incident.status === "resolved") {
    return null;
  }

  return resolveIncident(incident.id, input);
}

export async function updateIncidentMetadata(
  incidentId: string,
  metadata: Record<string, unknown>,
  options: { tenantId?: string } = {},
) {
  const incident = await getIncident(incidentId, options);
  if (!incident) {
    return null;
  }

  const next: IncidentRecord = {
    ...incident,
    metadata: {
      ...incident.metadata,
      ...metadata,
    },
    updatedAt: new Date().toISOString(),
  };
  await saveIncident(next);
  return next;
}

export async function recordIncidentEvent(input: {
  tenantId?: string;
  incidentId: string;
  type: IncidentEventType;
  actorId?: string;
  message: string;
  metadata?: Record<string, unknown>;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const event: IncidentEventRecord = {
    id: randomUUID(),
    tenantId,
    incidentId: input.incidentId,
    type: input.type,
    actorId: input.actorId,
    message: input.message,
    metadata: input.metadata || {},
    createdAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_incident_events (
        id, tenant_id, incident_id, type, actor_id, message, metadata, created_at
      )
      VALUES (
        ${event.id}, ${tenantId}, ${event.incidentId}, ${event.type}, ${event.actorId || null},
        ${event.message}, ${JSON.stringify(event.metadata)}::jsonb, ${event.createdAt}
      )
    `;
    return event;
  }

  await mutateIncidentLedger((ledger) => {
    ledger.events.unshift(event);
    return trimIncidentLedger(ledger);
  });
  return event;
}

async function getIncidentByFingerprint(fingerprint: string, requestedTenantId?: string) {
  const tenantId = normalizeTenantId(requestedTenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_incidents
      WHERE fingerprint = ${storageFingerprint(tenantId, fingerprint)}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    return rows[0] ? incidentFromRow(rows[0]) : null;
  }

  const ledger = await readIncidentLedger();
  return ledger.incidents.find(
    (incident) =>
      incidentTenantId(incident) === tenantId &&
      incident.fingerprint === fingerprint,
  ) || null;
}

async function saveIncident(record: IncidentRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_incidents (
        id, tenant_id, fingerprint, component_id, severity, status, title, message,
        first_seen_at, last_seen_at, last_check_id, occurrence_count,
        acknowledged_at, acknowledged_by, acknowledgement_reason,
        resolved_at, resolved_by, resolution, alert_targets, playbook_ids,
        metadata, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${storageFingerprint(record.tenantId, record.fingerprint)}, ${record.componentId}, ${record.severity},
        ${record.status}, ${record.title}, ${record.message}, ${record.firstSeenAt},
        ${record.lastSeenAt}, ${record.lastCheckId || null}, ${record.occurrenceCount},
        ${record.acknowledgedAt || null}, ${record.acknowledgedBy || null},
        ${record.acknowledgementReason || null}, ${record.resolvedAt || null},
        ${record.resolvedBy || null}, ${record.resolution || null},
        ${JSON.stringify(record.alertTargets)}::jsonb, ${record.playbookIds},
        ${JSON.stringify(record.metadata)}::jsonb, ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
        fingerprint = EXCLUDED.fingerprint,
        component_id = EXCLUDED.component_id,
        severity = EXCLUDED.severity,
        status = EXCLUDED.status,
        title = EXCLUDED.title,
        message = EXCLUDED.message,
        first_seen_at = EXCLUDED.first_seen_at,
        last_seen_at = EXCLUDED.last_seen_at,
        last_check_id = EXCLUDED.last_check_id,
        occurrence_count = EXCLUDED.occurrence_count,
        acknowledged_at = EXCLUDED.acknowledged_at,
        acknowledged_by = EXCLUDED.acknowledged_by,
        acknowledgement_reason = EXCLUDED.acknowledgement_reason,
        resolved_at = EXCLUDED.resolved_at,
        resolved_by = EXCLUDED.resolved_by,
        resolution = EXCLUDED.resolution,
        alert_targets = EXCLUDED.alert_targets,
        playbook_ids = EXCLUDED.playbook_ids,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at
    `;
    return record;
  }

  await mutateIncidentLedger((ledger) => {
    ledger.incidents = [
      record,
      ...ledger.incidents.filter(
        (incident) =>
          incident.id !== record.id || incidentTenantId(incident) !== record.tenantId,
      ),
    ];
    return trimIncidentLedger(ledger);
  });
  return record;
}

async function listLatestIncidentEvents(
  limit = 10,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_incident_events
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(incidentEventFromRow);
  }

  const ledger = await readIncidentLedger();
  return ledger.events
    .filter((event) => incidentEventTenantId(event) === tenantId)
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, boundedLimit);
}

async function readIncidentLedger() {
  const ledger = await readJsonFile<IncidentLedger>(getIncidentFile(), {
    incidents: [],
    events: [],
  });
  return {
    incidents: ledger.incidents.map((incident) => ({
      ...incident,
      tenantId: incidentTenantId(incident),
    })),
    events: ledger.events.map((event) => ({
      ...event,
      tenantId: incidentEventTenantId(event),
    })),
  };
}

async function mutateIncidentLedger(mutator: (ledger: IncidentLedger) => IncidentLedger) {
  await updateJsonFile<IncidentLedger>(
    getIncidentFile(),
    { incidents: [], events: [] },
    (ledger) => trimIncidentLedger(mutator(ledger)),
  );
}

function trimIncidentLedger(ledger: IncidentLedger): IncidentLedger {
  return {
    incidents: ledger.incidents.slice(0, 1000),
    events: ledger.events.slice(0, 3000),
  };
}

function createIncidentFingerprint(incident: HealthIncident) {
  return `${incident.componentId}:${incident.id}`;
}

function selectPlaybookIds(componentId: string) {
  return playbooks
    .filter((playbook) => playbook.componentIds.includes("*") || playbook.componentIds.includes(componentId))
    .map((playbook) => playbook.id);
}

function severityRank(severity: IncidentSeverity) {
  return severity === "critical" ? 3 : severity === "warning" ? 2 : 1;
}

function incidentFromRow(row: Record<string, unknown>): IncidentRecord {
  const tenantId = storedTenantId(row.tenant_id ? String(row.tenant_id) : undefined);
  return {
    id: String(row.id),
    tenantId,
    fingerprint: logicalFingerprint(tenantId, String(row.fingerprint)),
    componentId: String(row.component_id),
    severity: normalizeSeverity(row.severity),
    status: normalizeStatus(row.status),
    title: String(row.title),
    message: String(row.message),
    firstSeenAt: normalizeDate(row.first_seen_at),
    lastSeenAt: normalizeDate(row.last_seen_at),
    lastCheckId: row.last_check_id ? String(row.last_check_id) : undefined,
    occurrenceCount: Number(row.occurrence_count || 1),
    acknowledgedAt: row.acknowledged_at ? normalizeDate(row.acknowledged_at) : undefined,
    acknowledgedBy: row.acknowledged_by ? String(row.acknowledged_by) : undefined,
    acknowledgementReason: row.acknowledgement_reason ? String(row.acknowledgement_reason) : undefined,
    resolvedAt: row.resolved_at ? normalizeDate(row.resolved_at) : undefined,
    resolvedBy: row.resolved_by ? String(row.resolved_by) : undefined,
    resolution: row.resolution ? String(row.resolution) : undefined,
    alertTargets: parseArray(row.alert_targets) as IncidentAlertTarget[],
    playbookIds: parseStringArray(row.playbook_ids),
    metadata: parseObject(row.metadata) || {},
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function incidentEventFromRow(row: Record<string, unknown>): IncidentEventRecord {
  return {
    id: String(row.id),
    tenantId: storedTenantId(row.tenant_id ? String(row.tenant_id) : undefined),
    incidentId: String(row.incident_id),
    type: normalizeEventType(row.type),
    actorId: row.actor_id ? String(row.actor_id) : undefined,
    message: String(row.message),
    metadata: parseObject(row.metadata) || {},
    createdAt: normalizeDate(row.created_at),
  };
}

function normalizeSeverity(value: unknown): IncidentSeverity {
  const severity = String(value || "warning");
  if (severity === "critical" || severity === "info") {
    return severity;
  }
  return "warning";
}

function normalizeStatus(value: unknown): IncidentStatus {
  const status = String(value || "open");
  if (status === "acknowledged" || status === "resolved") {
    return status;
  }
  return "open";
}

function normalizeEventType(value: unknown): IncidentEventType {
  const type = String(value || "observed");
  const allowed: IncidentEventType[] = [
    "opened",
    "observed",
    "reopened",
    "acknowledged",
    "resolved",
    "playbook_run",
    "alert_routed",
    "alert_delivery_queued",
    "alert_delivered",
    "alert_delivery_failed",
  ];
  return allowed.includes(type as IncidentEventType) ? (type as IncidentEventType) : "observed";
}

function parseArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function incidentTenantId(incident: { tenantId?: string }) {
  return storedTenantId(incident.tenantId);
}

function incidentEventTenantId(event: { tenantId?: string }) {
  return storedTenantId(event.tenantId);
}

function storedTenantId(value?: string) {
  return normalizeTenantId(
    value || process.env.OMNIAGENT_DEFAULT_TENANT || "default",
  );
}

function storageFingerprint(tenantId: string, fingerprint: string) {
  return tenantId === "default" ? fingerprint : `${tenantId}/${fingerprint}`;
}

function logicalFingerprint(tenantId: string, fingerprint: string) {
  const prefix = `${tenantId}/`;
  return tenantId !== "default" && fingerprint.startsWith(prefix)
    ? fingerprint.slice(prefix.length)
    : fingerprint;
}

function getIncidentFile() {
  return getDataPath("incidents.json");
}
