import { createHmac, randomUUID } from "node:crypto";
import {
  ALERT_SCHEDULER_CRON_PATH,
  ALERT_SCHEDULER_CRON_SCHEDULE,
  ALERT_SCHEDULER_DISPATCH_LIMIT,
  ALERT_SCHEDULER_QUEUE_LIMIT,
} from "@/lib/config";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import {
  getIncidentAlertTargets,
  recordIncidentEvent,
  type IncidentAlertTarget,
  type IncidentRecord,
  type IncidentSeverity,
} from "@/lib/diagnostics/incidents";
import { readResponseTextLimited } from "@/lib/http/body";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type AlertDeliveryChannel = IncidentAlertTarget["channel"];
export type AlertDeliveryStatus = "queued" | "running" | "delivered" | "failed" | "skipped";

export type AlertDeliveryRecord = {
  id: string;
  tenantId: string;
  incidentId: string;
  incidentEventId?: string;
  targetId: string;
  channel: AlertDeliveryChannel;
  status: AlertDeliveryStatus;
  severity: IncidentSeverity;
  dedupeKey: string;
  payload: Record<string, unknown>;
  response?: Record<string, unknown>;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  lockedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
};

export type AlertDeliveryPolicy = {
  id: string;
  name: string;
  minSeverity: IncidentSeverity;
  channels: AlertDeliveryChannel[];
  maxAttempts: number;
  retryBackoffSeconds: number[];
  escalationAfterMinutes: number;
};

export type AlertTargetProbeStatus = "healthy" | "missing_config" | "misconfigured";

export type AlertTargetHealth = {
  id: string;
  name: string;
  channel: AlertDeliveryChannel;
  targetStatus: IncidentAlertTarget["status"];
  probeStatus: AlertTargetProbeStatus;
  ready: boolean;
  configured: boolean;
  requiredEnv: string[];
  optionalEnv: string[];
  blockingReasons: string[];
  checkedAt: string;
  security: {
    secretValuesExposed: false;
    webhookSigned?: boolean;
  };
};

export type AlertSchedulerState = {
  enabled: boolean;
  path: string;
  schedule: string;
  cronSecretConfigured: boolean;
  queueLimit: number;
  dispatchLimit: number;
  readyTargets: number;
  configuredExternalTargets: number;
};

export type AlertDeliveryStats = {
  total: number;
  queued: number;
  running: number;
  delivered: number;
  failed: number;
  skipped: number;
  runnable: number;
  retryableFailed: number;
  readyTargets: number;
  configuredExternalTargets: number;
  blockedExternalTargets: number;
  byChannel: Record<string, number>;
  latest: AlertDeliveryRecord[];
  policies: AlertDeliveryPolicy[];
  targets: IncidentAlertTarget[];
  targetHealth: AlertTargetHealth[];
  scheduler: AlertSchedulerState;
};

export type ScheduledAlertDispatchResult = {
  trigger: string;
  enqueued: AlertDeliveryRecord[];
  dispatch: DispatchResult;
  stats: AlertDeliveryStats;
  scheduler: AlertSchedulerState;
};

type AlertDeliveryLedger = {
  deliveries: AlertDeliveryRecord[];
};

type EnqueueAlertOptions = {
  eventId?: string;
  reason?: string;
  includeUnconfigured?: boolean;
};

export type DispatchResult = {
  processed: AlertDeliveryRecord[];
  delivered: number;
  skipped: number;
  failed: number;
};

const alertPolicies: AlertDeliveryPolicy[] = [
  {
    id: "p1-critical",
    name: "Critical incident escalation",
    minSeverity: "critical",
    channels: ["dashboard", "ops", "webhook", "slack", "email"],
    maxAttempts: 5,
    retryBackoffSeconds: [30, 120, 300, 900],
    escalationAfterMinutes: 15,
  },
  {
    id: "p2-warning",
    name: "Warning incident routing",
    minSeverity: "warning",
    channels: ["dashboard", "ops", "webhook"],
    maxAttempts: 3,
    retryBackoffSeconds: [60, 300],
    escalationAfterMinutes: 60,
  },
];

const deliveryLeaseMs = 5 * 60 * 1000;
const alertNetworkDeadlineMs = 15_000;
const alertResponseMaxBytes = 16_000;

export function getAlertDeliveryPolicies() {
  return alertPolicies;
}

export function getAlertSchedulerState(targets = getIncidentAlertTargets("critical")): AlertSchedulerState {
  const readyTargets = targets.filter((target) => target.status === "ready");

  return {
    enabled: Boolean(process.env.CRON_SECRET?.trim()),
    path: ALERT_SCHEDULER_CRON_PATH,
    schedule: ALERT_SCHEDULER_CRON_SCHEDULE,
    cronSecretConfigured: Boolean(process.env.CRON_SECRET?.trim()),
    queueLimit: ALERT_SCHEDULER_QUEUE_LIMIT,
    dispatchLimit: ALERT_SCHEDULER_DISPATCH_LIMIT,
    readyTargets: readyTargets.length,
    configuredExternalTargets: readyTargets.filter((target) => !["dashboard", "ops"].includes(target.channel)).length,
  };
}

export function getAlertTargetHealth(targets = getIncidentAlertTargets("critical")): AlertTargetHealth[] {
  const checkedAt = new Date().toISOString();
  return targets.map((target) => createTargetHealth(target, checkedAt));
}

export async function enqueueAlertDeliveriesForIncident(
  incident: IncidentRecord,
  options: EnqueueAlertOptions = {},
) {
  const targets = (incident.alertTargets.length ? incident.alertTargets : getIncidentAlertTargets(incident.severity))
    .filter((target) => options.includeUnconfigured || target.status === "ready");
  const payload = createAlertPayload(incident, options.reason);
  const saved: AlertDeliveryRecord[] = [];

  for (const target of targets) {
    const delivery = createAlertDelivery({
      incident,
      target,
      payload,
      eventId: options.eventId,
      maxAttempts: policyForSeverity(incident.severity).maxAttempts,
    });
    saved.push(await saveAlertDelivery(delivery));
  }

  if (saved.length) {
    await recordIncidentEvent({
      tenantId: incident.tenantId,
      incidentId: incident.id,
      type: "alert_delivery_queued",
      message: `Queued ${saved.length} alert delivery target(s).`,
      metadata: {
        eventId: options.eventId,
        reason: options.reason,
        targetIds: saved.map((delivery) => delivery.targetId),
      },
    }).catch(() => undefined);
  }

  return saved;
}

export async function enqueueAlertDeliveriesForActiveIncidents(
  limit = 25,
  options: { tenantId?: string } = {},
) {
  const rows = await getSqlSafeListActiveIncidents(limit, options);
  const deliveries: AlertDeliveryRecord[] = [];

  for (const incident of rows) {
    deliveries.push(...await enqueueAlertDeliveriesForIncident(incident, {
      reason: "operator.enqueue_active",
    }));
  }

  return deliveries;
}

export async function dispatchAlertDeliveries(
  limit = 10,
  options: { tenantId?: string } = {},
): Promise<DispatchResult> {
  const tenantId = normalizeTenantId(options.tenantId);
  await repairExpiredAlertDeliveries({ tenantId });
  const deliveries = await leaseAlertDeliveries(limit, { tenantId });
  const processed: AlertDeliveryRecord[] = [];
  let delivered = 0;
  let skipped = 0;
  let failed = 0;

  for (const delivery of deliveries) {
    try {
      const result = await deliverAlert(delivery);
      if (result.status === "delivered") {
        const completed = await completeAlertDelivery(delivery, result.response);
        processed.push(completed);
        delivered += 1;
        await recordIncidentEvent({
          tenantId: delivery.tenantId,
          incidentId: delivery.incidentId,
          type: "alert_delivered",
          message: `Delivered alert to ${delivery.targetId}.`,
          metadata: { deliveryId: delivery.id, channel: delivery.channel },
        }).catch(() => undefined);
        continue;
      }

      if (result.status === "skipped") {
        const skippedDelivery = await skipAlertDelivery(
          delivery,
          result.error || "Alert target is not configured.",
        );
        processed.push(skippedDelivery);
        skipped += 1;
        continue;
      }

      const failedDelivery = await failAlertDelivery(
        delivery,
        result.error || "Alert delivery failed.",
      );
      processed.push(failedDelivery);
      failed += 1;
      await recordAlertFailureEvent(delivery, result.error);
    } catch (error) {
      failed += 1;
      const message = error instanceof Error ? error.message : "Alert delivery threw.";
      try {
        processed.push(await failAlertDelivery(delivery, message));
      } catch (stateError) {
        console.warn(
          "Alert delivery state update failed.",
          stateError instanceof Error ? stateError.message : stateError,
        );
      }
      await recordAlertFailureEvent(delivery, message);
    }
  }

  return { processed, delivered, skipped, failed };
}

export async function retryFailedAlertDeliveries({
  tenantId: requestedTenantId,
  limit = 25,
  includeSkipped = true,
}: {
  tenantId?: string;
  limit?: number;
  includeSkipped?: boolean;
} = {}) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 50);
  const readyTargetIds = getAlertTargetHealth()
    .filter((target) => target.ready)
    .map((target) => target.id);
  const retryStatuses: AlertDeliveryStatus[] = includeSkipped ? ["failed", "skipped"] : ["failed"];

  if (!readyTargetIds.length) {
    return [];
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql().query(
      `
      WITH retryable AS (
        SELECT id
        FROM omni_alert_deliveries
        WHERE tenant_id = $1
          AND status ${includeSkipped ? "IN ('failed', 'skipped')" : "= 'failed'"}
          AND target_id = ANY($2)
        ORDER BY updated_at ASC, created_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED
      )
      UPDATE omni_alert_deliveries deliveries
      SET status = 'queued',
          attempt = 0,
          run_at = NOW(),
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          delivered_at = NULL,
          updated_at = NOW()
      FROM retryable
      WHERE deliveries.id = retryable.id
      RETURNING deliveries.*
    `,
      [tenantId, readyTargetIds, boundedLimit],
    );
    return rows.map(alertDeliveryFromRow);
  }

  const retried: AlertDeliveryRecord[] = [];
  const now = new Date().toISOString();
  await mutateAlertLedger((ledger) => {
    const candidates = ledger.deliveries
      .filter((delivery) => alertTenantId(delivery) === tenantId)
      .filter((delivery) => retryStatuses.includes(delivery.status))
      .filter((delivery) => readyTargetIds.includes(delivery.targetId))
      .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
      .slice(0, boundedLimit);
    const ids = new Set(candidates.map((delivery) => delivery.id));
    ledger.deliveries = ledger.deliveries.map((delivery) => {
      if (!ids.has(delivery.id)) {
        return delivery;
      }
      const updated: AlertDeliveryRecord = {
        ...delivery,
        status: "queued",
        attempt: 0,
        runAt: now,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        deliveredAt: undefined,
        updatedAt: now,
      };
      retried.push(updated);
      return updated;
    });
    return trimAlertLedger(ledger);
  });
  return retried;
}

export async function runScheduledAlertDispatch({
  tenantId,
  trigger = "operator.scheduler",
  queueLimit = ALERT_SCHEDULER_QUEUE_LIMIT,
  dispatchLimit = ALERT_SCHEDULER_DISPATCH_LIMIT,
}: {
  tenantId?: string;
  trigger?: string;
  queueLimit?: number;
  dispatchLimit?: number;
} = {}): Promise<ScheduledAlertDispatchResult> {
  const boundedQueueLimit = Math.min(Math.max(queueLimit, 1), 50);
  const boundedDispatchLimit = Math.min(Math.max(dispatchLimit, 1), 50);
  const enqueued = await enqueueAlertDeliveriesForActiveIncidents(boundedQueueLimit, { tenantId });
  const dispatch = await dispatchAlertDeliveries(boundedDispatchLimit, { tenantId });
  const stats = await getAlertDeliveryStats({ tenantId });

  return {
    trigger,
    enqueued,
    dispatch,
    stats,
    scheduler: stats.scheduler,
  };
}

export async function listAlertDeliveries({
  tenantId: requestedTenantId,
  incidentId,
  status = "all",
  limit = 50,
}: {
  tenantId?: string;
  incidentId?: string;
  status?: AlertDeliveryStatus | "all";
  limit?: number;
} = {}) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (incidentId && status !== "all") {
      const rows = await getSql()`
        SELECT *
        FROM omni_alert_deliveries
        WHERE tenant_id = ${tenantId}
          AND incident_id = ${incidentId}
          AND status = ${status}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(alertDeliveryFromRow);
    }
    if (incidentId) {
      const rows = await getSql()`
        SELECT *
        FROM omni_alert_deliveries
        WHERE tenant_id = ${tenantId}
          AND incident_id = ${incidentId}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(alertDeliveryFromRow);
    }
    if (status !== "all") {
      const rows = await getSql()`
        SELECT *
        FROM omni_alert_deliveries
        WHERE tenant_id = ${tenantId}
          AND status = ${status}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(alertDeliveryFromRow);
    }
    const rows = await getSql()`
      SELECT *
      FROM omni_alert_deliveries
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(alertDeliveryFromRow);
  }

  const ledger = await readAlertLedger();
  return ledger.deliveries
    .filter((delivery) => alertTenantId(delivery) === tenantId)
    .filter((delivery) => !incidentId || delivery.incidentId === incidentId)
    .filter((delivery) => status === "all" || delivery.status === status)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, boundedLimit);
}

export async function getAlertDeliveryStats(
  options: { tenantId?: string } = {},
): Promise<AlertDeliveryStats> {
  const deliveries = await listAlertDeliveries({ ...options, limit: 500 });
  const now = Date.now();
  const targets = getIncidentAlertTargets("critical");
  const targetHealth = getAlertTargetHealth(targets);
  const scheduler = getAlertSchedulerState(targets);
  const readyTargetIds = new Set(targetHealth.filter((target) => target.ready).map((target) => target.id));

  return {
    total: deliveries.length,
    queued: deliveries.filter((delivery) => delivery.status === "queued").length,
    running: deliveries.filter((delivery) => delivery.status === "running").length,
    delivered: deliveries.filter((delivery) => delivery.status === "delivered").length,
    failed: deliveries.filter((delivery) => delivery.status === "failed").length,
    skipped: deliveries.filter((delivery) => delivery.status === "skipped").length,
    runnable: deliveries.filter((delivery) => delivery.status === "queued" && Date.parse(delivery.runAt) <= now).length,
    retryableFailed: deliveries.filter((delivery) =>
      (delivery.status === "failed" || delivery.status === "skipped") && readyTargetIds.has(delivery.targetId),
    ).length,
    readyTargets: targets.filter((target) => target.status === "ready").length,
    configuredExternalTargets: targets.filter((target) => target.status === "ready" && !["dashboard", "ops"].includes(target.channel)).length,
    blockedExternalTargets: targetHealth.filter((target) => !["dashboard", "ops"].includes(target.channel) && target.probeStatus !== "healthy").length,
    byChannel: deliveries.reduce<Record<string, number>>((acc, delivery) => {
      acc[delivery.channel] = (acc[delivery.channel] || 0) + 1;
      return acc;
    }, {}),
    latest: deliveries.slice(0, 8),
    policies: alertPolicies,
    targets,
    targetHealth,
    scheduler,
  };
}

export function createAlertWebhookSignature(body: string, secret = process.env.OMNIAGENT_ALERT_WEBHOOK_SECRET || "") {
  if (!secret.trim()) {
    return undefined;
  }
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function createAlertDelivery({
  incident,
  target,
  payload,
  eventId,
  maxAttempts,
}: {
  incident: IncidentRecord;
  target: IncidentAlertTarget;
  payload: Record<string, unknown>;
  eventId?: string;
  maxAttempts: number;
}): AlertDeliveryRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    tenantId: incident.tenantId,
    incidentId: incident.id,
    incidentEventId: eventId,
    targetId: target.id,
    channel: target.channel,
    status: "queued",
    severity: incident.severity,
    dedupeKey: `${incident.id}:${eventId || incident.lastCheckId || incident.updatedAt}:${target.id}`,
    payload: {
      ...payload,
      target: {
        id: target.id,
        channel: target.channel,
        status: target.status,
      },
    },
    attempt: 0,
    maxAttempts,
    runAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

function createAlertPayload(incident: IncidentRecord, reason?: string): Record<string, unknown> {
  return {
    type: "omniagent.incident.alert",
    reason,
    incident: {
      id: incident.id,
      componentId: incident.componentId,
      severity: incident.severity,
      status: incident.status,
      title: incident.title,
      message: incident.message,
      occurrenceCount: incident.occurrenceCount,
      firstSeenAt: incident.firstSeenAt,
      lastSeenAt: incident.lastSeenAt,
      playbookIds: incident.playbookIds,
    },
    emittedAt: new Date().toISOString(),
  };
}

function createTargetHealth(target: IncidentAlertTarget, checkedAt: string): AlertTargetHealth {
  if (target.channel === "dashboard" || target.channel === "ops") {
    return {
      id: target.id,
      name: target.name,
      channel: target.channel,
      targetStatus: target.status,
      probeStatus: "healthy",
      ready: true,
      configured: true,
      requiredEnv: [],
      optionalEnv: [],
      blockingReasons: [],
      checkedAt,
      security: {
        secretValuesExposed: false,
      },
    };
  }

  if (target.channel === "webhook") {
    const url = process.env.OMNIAGENT_ALERT_WEBHOOK_URL?.trim();
    const blockingReasons = [];
    if (!url) {
      blockingReasons.push("OMNIAGENT_ALERT_WEBHOOK_URL is not configured.");
    } else if (!isHttpsOrLocalUrl(url)) {
      blockingReasons.push("OMNIAGENT_ALERT_WEBHOOK_URL must be an absolute HTTPS URL, or localhost for development.");
    }
    return {
      id: target.id,
      name: target.name,
      channel: target.channel,
      targetStatus: target.status,
      probeStatus: blockingReasons.length ? (url ? "misconfigured" : "missing_config") : "healthy",
      ready: !blockingReasons.length,
      configured: Boolean(url && !blockingReasons.length),
      requiredEnv: ["OMNIAGENT_ALERT_WEBHOOK_URL"],
      optionalEnv: ["OMNIAGENT_ALERT_WEBHOOK_SECRET"],
      blockingReasons,
      checkedAt,
      security: {
        secretValuesExposed: false,
        webhookSigned: Boolean(process.env.OMNIAGENT_ALERT_WEBHOOK_SECRET?.trim()),
      },
    };
  }

  if (target.channel === "slack") {
    const url = process.env.SLACK_WEBHOOK_URL?.trim();
    const blockingReasons = [];
    if (!url) {
      blockingReasons.push("SLACK_WEBHOOK_URL is not configured.");
    } else if (!isHttpsUrl(url)) {
      blockingReasons.push("SLACK_WEBHOOK_URL must be an absolute HTTPS URL.");
    }
    return {
      id: target.id,
      name: target.name,
      channel: target.channel,
      targetStatus: target.status,
      probeStatus: blockingReasons.length ? (url ? "misconfigured" : "missing_config") : "healthy",
      ready: !blockingReasons.length,
      configured: Boolean(url && !blockingReasons.length),
      requiredEnv: ["SLACK_WEBHOOK_URL"],
      optionalEnv: [],
      blockingReasons,
      checkedAt,
      security: {
        secretValuesExposed: false,
      },
    };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.OMNIAGENT_ALERT_EMAIL_TO?.trim();
  const from = process.env.OMNIAGENT_ALERT_EMAIL_FROM?.trim();
  const blockingReasons = [];
  if (!apiKey) {
    blockingReasons.push("RESEND_API_KEY is not configured.");
  }
  if (!to) {
    blockingReasons.push("OMNIAGENT_ALERT_EMAIL_TO is not configured.");
  } else if (!isEmailish(to)) {
    blockingReasons.push("OMNIAGENT_ALERT_EMAIL_TO must look like an email address.");
  }
  if (from && !from.includes("@")) {
    blockingReasons.push("OMNIAGENT_ALERT_EMAIL_FROM must include an email address.");
  }

  return {
    id: target.id,
    name: target.name,
    channel: target.channel,
    targetStatus: target.status,
    probeStatus: blockingReasons.length ? (apiKey || to || from ? "misconfigured" : "missing_config") : "healthy",
    ready: !blockingReasons.length,
    configured: Boolean(apiKey && to && !blockingReasons.length),
    requiredEnv: ["RESEND_API_KEY", "OMNIAGENT_ALERT_EMAIL_TO"],
    optionalEnv: ["OMNIAGENT_ALERT_EMAIL_FROM"],
    blockingReasons,
    checkedAt,
    security: {
      secretValuesExposed: false,
    },
  };
}

function isHttpsUrl(value: string) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpsOrLocalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || ["localhost", "127.0.0.1", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

function isEmailish(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

async function deliverAlert(delivery: AlertDeliveryRecord): Promise<{
  status: "delivered" | "skipped" | "failed";
  response?: Record<string, unknown>;
  error?: string;
}> {
  if (delivery.channel === "dashboard" || delivery.channel === "ops") {
    return {
      status: "delivered",
      response: { channel: delivery.channel, persisted: true },
    };
  }

  if (delivery.channel === "webhook") {
    return deliverWebhookAlert(delivery);
  }

  if (delivery.channel === "slack") {
    return deliverSlackAlert(delivery);
  }

  if (delivery.channel === "email") {
    return deliverEmailAlert(delivery);
  }

  return { status: "skipped", error: `Unsupported alert channel ${delivery.channel}.` };
}

async function deliverWebhookAlert(delivery: AlertDeliveryRecord) {
  const url = process.env.OMNIAGENT_ALERT_WEBHOOK_URL?.trim();
  if (!url) {
    return { status: "skipped" as const, error: "OMNIAGENT_ALERT_WEBHOOK_URL is not configured." };
  }
  const body = JSON.stringify(delivery.payload);
  const signature = createAlertWebhookSignature(body);
  const { response, body: responseBody } = await fetchAlertResponse(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-omniagent-delivery-id": delivery.id,
      "Idempotency-Key": delivery.id,
      ...(signature ? { "x-omniagent-signature": signature } : {}),
    },
    body,
  });
  const text = responseBody.text;

  if (!response.ok) {
    return { status: "failed" as const, error: `Webhook returned ${response.status}: ${text.slice(0, 240)}` };
  }

  return {
    status: "delivered" as const,
    response: { status: response.status, bodyPreview: text.slice(0, 240), signed: Boolean(signature) },
  };
}

async function deliverSlackAlert(delivery: AlertDeliveryRecord) {
  const url = process.env.SLACK_WEBHOOK_URL?.trim();
  if (!url) {
    return { status: "skipped" as const, error: "SLACK_WEBHOOK_URL is not configured." };
  }
  const incident = delivery.payload.incident as { title?: string; message?: string; severity?: string } | undefined;
  const { response, body: responseBody } = await fetchAlertResponse(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": delivery.id,
    },
    body: JSON.stringify({
      text: `[${incident?.severity || delivery.severity}] ${incident?.title || "OmniAgent incident"}`,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${incident?.title || "OmniAgent incident"}*\\n${incident?.message || ""}`,
          },
        },
      ],
    }),
  });
  const text = responseBody.text;

  if (!response.ok) {
    return { status: "failed" as const, error: `Slack returned ${response.status}: ${text.slice(0, 240)}` };
  }

  return { status: "delivered" as const, response: { status: response.status, bodyPreview: text.slice(0, 240) } };
}

async function deliverEmailAlert(delivery: AlertDeliveryRecord) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = process.env.OMNIAGENT_ALERT_EMAIL_TO?.trim();
  if (!apiKey || !to) {
    return { status: "skipped" as const, error: "RESEND_API_KEY and OMNIAGENT_ALERT_EMAIL_TO are not configured." };
  }
  const incident = delivery.payload.incident as { title?: string; message?: string; severity?: string } | undefined;
  const { response, body: responseBody } = await fetchAlertResponse("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": delivery.id,
    },
    body: JSON.stringify({
      from: process.env.OMNIAGENT_ALERT_EMAIL_FROM || "OmniAgent OS <onboarding@resend.dev>",
      to: [to],
      subject: `[${incident?.severity || delivery.severity}] ${incident?.title || "OmniAgent incident"}`,
      text: `${incident?.message || "Incident alert"}\n\nDelivery: ${delivery.id}`,
    }),
  });
  const data = parseJsonObject(responseBody.text);

  if (!response.ok) {
    return { status: "failed" as const, error: `Email returned ${response.status}: ${JSON.stringify(data).slice(0, 240)}` };
  }

  return { status: "delivered" as const, response: { status: response.status, id: data.id } };
}

async function fetchAlertResponse(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`Alert provider timed out after ${alertNetworkDeadlineMs}ms.`)),
    alertNetworkDeadlineMs,
  );
  try {
    const response = await fetchPublicHttpUrl(url, {
      ...init,
      signal: controller.signal,
    }, "Alert provider URL");
    const body = await readResponseTextLimited(response, alertResponseMaxBytes);
    return { response, body };
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

async function recordAlertFailureEvent(delivery: AlertDeliveryRecord, error?: string) {
  await recordIncidentEvent({
    tenantId: delivery.tenantId,
    incidentId: delivery.incidentId,
    type: "alert_delivery_failed",
    message: `Alert delivery failed for ${delivery.targetId}.`,
    metadata: { deliveryId: delivery.id, channel: delivery.channel, error },
  }).catch(() => undefined);
}

async function saveAlertDelivery(record: AlertDeliveryRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_alert_deliveries (
        id, tenant_id, incident_id, incident_event_id, target_id, channel, status, severity,
        dedupe_key, payload, response, attempt, max_attempts, run_at, locked_at,
        lease_owner, lease_expires_at, last_error, created_at, updated_at, delivered_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.incidentId}, ${record.incidentEventId || null},
        ${record.targetId}, ${record.channel}, ${record.status}, ${record.severity},
        ${storageDedupeKey(record.tenantId, record.dedupeKey)}, ${JSON.stringify(record.payload)}::jsonb,
        ${JSON.stringify(record.response || null)}::jsonb, ${record.attempt},
        ${record.maxAttempts}, ${record.runAt}, ${record.lockedAt || null},
        ${record.leaseOwner || null}, ${record.leaseExpiresAt || null},
        ${record.lastError || null}, ${record.createdAt}, ${record.updatedAt},
        ${record.deliveredAt || null}
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        payload = EXCLUDED.payload,
        max_attempts = EXCLUDED.max_attempts,
        status = CASE
          WHEN omni_alert_deliveries.status IN ('delivered', 'skipped')
          THEN omni_alert_deliveries.status
          WHEN omni_alert_deliveries.status = 'running'
            AND omni_alert_deliveries.lease_expires_at > NOW()
          THEN omni_alert_deliveries.status
          ELSE 'queued'
        END,
        run_at = CASE
          WHEN omni_alert_deliveries.status IN ('delivered', 'skipped')
          THEN omni_alert_deliveries.run_at
          WHEN omni_alert_deliveries.status = 'running'
            AND omni_alert_deliveries.lease_expires_at > NOW()
          THEN omni_alert_deliveries.run_at
          ELSE EXCLUDED.run_at
        END,
        updated_at = NOW()
      RETURNING *
    `;
    return alertDeliveryFromRow(rows[0]);
  }

  let saved = record;
  await mutateAlertLedger((ledger) => {
    const existing = ledger.deliveries.find(
      (delivery) =>
        alertTenantId(delivery) === record.tenantId &&
        delivery.dedupeKey === record.dedupeKey,
    );
    if (existing) {
      const activeLease =
        existing.status === "running" &&
        Boolean(existing.leaseExpiresAt) &&
        Date.parse(existing.leaseExpiresAt || "") > Date.now();
      saved = ["delivered", "skipped"].includes(existing.status) || activeLease
        ? existing
        : { ...existing, payload: record.payload, status: "queued", runAt: record.runAt, updatedAt: new Date().toISOString() };
      ledger.deliveries = ledger.deliveries.map((delivery) =>
        delivery.id === existing.id && alertTenantId(delivery) === record.tenantId
          ? saved
          : delivery
      );
      return trimAlertLedger(ledger);
    }
    ledger.deliveries.unshift(record);
    return trimAlertLedger(ledger);
  });
  return saved;
}

async function leaseAlertDeliveries(
  limit = 10,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 25);
  const owner = `alerts:${randomUUID()}`;
  const leaseExpiresAt = new Date(Date.now() + deliveryLeaseMs).toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      WITH next_deliveries AS (
        SELECT id
        FROM omni_alert_deliveries
        WHERE tenant_id = ${tenantId}
          AND status = 'queued'
          AND run_at <= NOW()
        ORDER BY run_at ASC, created_at ASC
        LIMIT ${boundedLimit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE omni_alert_deliveries deliveries
      SET status = 'running',
          attempt = deliveries.attempt + 1,
          locked_at = NOW(),
          lease_owner = ${owner},
          lease_expires_at = ${leaseExpiresAt},
          last_error = NULL,
          updated_at = NOW()
      FROM next_deliveries
      WHERE deliveries.id = next_deliveries.id
      RETURNING deliveries.*
    `;
    return rows.map(alertDeliveryFromRow);
  }

  let leased: AlertDeliveryRecord[] = [];
  await mutateAlertLedger((ledger) => {
    const candidates = ledger.deliveries
      .filter((delivery) => alertTenantId(delivery) === tenantId)
      .filter((delivery) => delivery.status === "queued" && Date.parse(delivery.runAt) <= Date.now())
      .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt))
      .slice(0, boundedLimit);
    const ids = new Set(candidates.map((delivery) => delivery.id));
    ledger.deliveries = ledger.deliveries.map((delivery) => {
      if (!ids.has(delivery.id)) {
        return delivery;
      }
      return {
        ...delivery,
        status: "running",
        attempt: delivery.attempt + 1,
        lockedAt: new Date().toISOString(),
        leaseOwner: owner,
        leaseExpiresAt,
        lastError: undefined,
        updatedAt: new Date().toISOString(),
      };
    });
    leased = ledger.deliveries.filter((delivery) => ids.has(delivery.id));
    return trimAlertLedger(ledger);
  });
  return leased;
}

async function completeAlertDelivery(
  delivery: AlertDeliveryRecord,
  response?: Record<string, unknown>,
) {
  return updateAlertDelivery(delivery.id, {
    status: "delivered",
    response,
    deliveredAt: new Date().toISOString(),
    lockedAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: undefined,
  }, delivery.tenantId, delivery.leaseOwner);
}

async function skipAlertDelivery(delivery: AlertDeliveryRecord, error: string) {
  return updateAlertDelivery(delivery.id, {
    status: "skipped",
    lastError: error,
    lockedAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    deliveredAt: new Date().toISOString(),
  }, delivery.tenantId, delivery.leaseOwner);
}

async function failAlertDelivery(delivery: AlertDeliveryRecord, error: string) {
  const retry = delivery.attempt < delivery.maxAttempts;
  const nextDelay = retryBackoffSeconds(delivery.severity, delivery.attempt);
  return updateAlertDelivery(delivery.id, {
    status: retry ? "queued" : "failed",
    runAt: retry ? new Date(Date.now() + nextDelay * 1000).toISOString() : delivery.runAt,
    lockedAt: undefined,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    lastError: error,
    deliveredAt: retry ? undefined : new Date().toISOString(),
  }, delivery.tenantId, delivery.leaseOwner);
}

async function updateAlertDelivery(
  deliveryId: string,
  patch: Partial<AlertDeliveryRecord>,
  requestedTenantId?: string,
  leaseOwner?: string,
) {
  if (!leaseOwner) {
    throw new Error(`Alert delivery ${deliveryId} is missing its lease owner.`);
  }
  const tenantId = normalizeTenantId(requestedTenantId);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_alert_deliveries
      SET status = COALESCE(${patch.status || null}, status),
          payload = COALESCE(${patch.payload ? JSON.stringify(patch.payload) : null}::jsonb, payload),
          response = ${patch.response === undefined ? null : JSON.stringify(patch.response)}::jsonb,
          run_at = COALESCE(${patch.runAt || null}, run_at),
          locked_at = ${patch.lockedAt || null},
          lease_owner = ${patch.leaseOwner || null},
          lease_expires_at = ${patch.leaseExpiresAt || null},
          last_error = ${patch.lastError || null},
          delivered_at = ${patch.deliveredAt || null},
          updated_at = ${now}
      WHERE id = ${deliveryId}
        AND tenant_id = ${tenantId}
        AND status = 'running'
        AND lease_owner = ${leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING *
    `;
    if (!rows[0]) {
      throw new Error(`Alert delivery ${deliveryId} lease was lost before completion.`);
    }
    return alertDeliveryFromRow(rows[0]);
  }

  let saved: AlertDeliveryRecord | null = null;
  await mutateAlertLedger((ledger) => {
    ledger.deliveries = ledger.deliveries.map((delivery) => {
      if (
        delivery.id !== deliveryId ||
        alertTenantId(delivery) !== tenantId ||
        delivery.status !== "running" ||
        delivery.leaseOwner !== leaseOwner ||
        !delivery.leaseExpiresAt ||
        Date.parse(delivery.leaseExpiresAt) <= Date.now()
      ) {
        return delivery;
      }
      saved = {
        ...delivery,
        ...patch,
        updatedAt: now,
      };
      return saved;
    });
    return trimAlertLedger(ledger);
  });
  if (!saved) {
    throw new Error(`Alert delivery ${deliveryId} lease was lost before completion.`);
  }
  return saved;
}

async function repairExpiredAlertDeliveries(
  options: { tenantId?: string } = {},
) {
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_alert_deliveries
      SET status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
          run_at = CASE WHEN attempt < max_attempts THEN NOW() ELSE run_at END,
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Alert delivery lease expired.'),
          delivered_at = CASE WHEN attempt < max_attempts THEN NULL ELSE NOW() END,
          updated_at = NOW()
      WHERE status = 'running'
        AND tenant_id = ${tenantId}
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
    `;
    return;
  }

  await mutateAlertLedger((ledger) => {
    ledger.deliveries = ledger.deliveries.map((delivery) => {
      if (
        alertTenantId(delivery) !== tenantId ||
        delivery.status !== "running" ||
        !delivery.leaseExpiresAt ||
        Date.parse(delivery.leaseExpiresAt) > Date.now()
      ) {
        return delivery;
      }
      const retry = delivery.attempt < delivery.maxAttempts;
      return {
        ...delivery,
        status: retry ? "queued" : "failed",
        runAt: retry ? now : delivery.runAt,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: delivery.lastError || "Alert delivery lease expired.",
        deliveredAt: retry ? undefined : now,
        updatedAt: now,
      };
    });
    return trimAlertLedger(ledger);
  });
}

async function getSqlSafeListActiveIncidents(
  limit: number,
  options: { tenantId?: string } = {},
) {
  const { listIncidents } = await import("@/lib/diagnostics/incidents");
  return listIncidents({ ...options, status: "active", limit });
}

function policyForSeverity(severity: IncidentSeverity) {
  return severity === "critical" ? alertPolicies[0] : alertPolicies[1];
}

function retryBackoffSeconds(severity: IncidentSeverity, attempt: number) {
  const policy = policyForSeverity(severity);
  return policy.retryBackoffSeconds[Math.min(Math.max(attempt - 1, 0), policy.retryBackoffSeconds.length - 1)] || 300;
}

async function readAlertLedger() {
  const ledger = await readJsonFile<AlertDeliveryLedger>(getAlertFile(), {
    deliveries: [],
  });
  return {
    deliveries: ledger.deliveries.map((delivery) => ({
      ...delivery,
      tenantId: alertTenantId(delivery),
    })),
  };
}

async function mutateAlertLedger(mutator: (ledger: AlertDeliveryLedger) => AlertDeliveryLedger) {
  await updateJsonFile<AlertDeliveryLedger>(
    getAlertFile(),
    { deliveries: [] },
    (ledger) => trimAlertLedger(mutator({
      deliveries: ledger.deliveries.map((delivery) => ({
        ...delivery,
        tenantId: alertTenantId(delivery),
      })),
    })),
  );
}

function trimAlertLedger(ledger: AlertDeliveryLedger): AlertDeliveryLedger {
  const durable = ledger.deliveries.filter(
    (delivery) => delivery.status === "queued" || delivery.status === "running",
  );
  const terminal = ledger.deliveries.filter(
    (delivery) => delivery.status !== "queued" && delivery.status !== "running",
  );
  return {
    deliveries: [
      ...durable,
      ...terminal.slice(0, Math.max(0, 2000 - durable.length)),
    ],
  };
}

function alertDeliveryFromRow(row: Record<string, unknown>): AlertDeliveryRecord {
  const tenantId = storedTenantId(row.tenant_id ? String(row.tenant_id) : undefined);
  return {
    id: String(row.id),
    tenantId,
    incidentId: String(row.incident_id),
    incidentEventId: row.incident_event_id ? String(row.incident_event_id) : undefined,
    targetId: String(row.target_id),
    channel: normalizeChannel(row.channel),
    status: normalizeStatus(row.status),
    severity: normalizeSeverity(row.severity),
    dedupeKey: logicalDedupeKey(tenantId, String(row.dedupe_key)),
    payload: parseObject(row.payload) || {},
    response: parseObject(row.response),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 3),
    runAt: normalizeDate(row.run_at),
    lockedAt: row.locked_at ? normalizeDate(row.locked_at) : undefined,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseExpiresAt: row.lease_expires_at ? normalizeDate(row.lease_expires_at) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    deliveredAt: row.delivered_at ? normalizeDate(row.delivered_at) : undefined,
  };
}

function normalizeChannel(value: unknown): AlertDeliveryChannel {
  const channel = String(value || "dashboard");
  return ["dashboard", "ops", "webhook", "email", "slack"].includes(channel)
    ? (channel as AlertDeliveryChannel)
    : "dashboard";
}

function normalizeStatus(value: unknown): AlertDeliveryStatus {
  const status = String(value || "queued");
  return ["running", "delivered", "failed", "skipped"].includes(status)
    ? (status as AlertDeliveryStatus)
    : "queued";
}

function normalizeSeverity(value: unknown): IncidentSeverity {
  const severity = String(value || "warning");
  return severity === "critical" || severity === "info" ? severity : "warning";
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

function alertTenantId(delivery: { tenantId?: string }) {
  return storedTenantId(delivery.tenantId);
}

function storedTenantId(value?: string) {
  return normalizeTenantId(
    value || process.env.OMNIAGENT_DEFAULT_TENANT || "default",
  );
}

function storageDedupeKey(tenantId: string, dedupeKey: string) {
  return tenantId === "default" ? dedupeKey : `${tenantId}/${dedupeKey}`;
}

function logicalDedupeKey(tenantId: string, dedupeKey: string) {
  const prefix = `${tenantId}/`;
  return tenantId !== "default" && dedupeKey.startsWith(prefix)
    ? dedupeKey.slice(prefix.length)
    : dedupeKey;
}

function getAlertFile() {
  return getDataPath("alert-deliveries.json");
}
