import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import {
  redactSensitive,
  validateTriggerSecretEnvName,
} from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { enqueueWorkflowRunTick } from "@/lib/workflows/queue";
import { appendWorkflowEvent, createWorkflowRun } from "@/lib/workflows/store";
import type {
  WorkflowTriggerAuthMode,
  WorkflowTriggerEventRecord,
  WorkflowTriggerEventStatus,
  WorkflowTriggerRecord,
  WorkflowTriggerStats,
} from "@/lib/workflows/types";

type WorkflowTriggerLedger = {
  triggers: WorkflowTriggerRecord[];
  events: WorkflowTriggerEventRecord[];
};

type CreateWorkflowTriggerInput = {
  tenantId?: string;
  name: string;
  source?: string;
  status?: WorkflowTriggerRecord["status"];
  authMode?: WorkflowTriggerAuthMode;
  secretEnvVar?: string;
  goalTemplate?: string;
  workflowMode?: WorkflowTriggerRecord["workflowMode"];
  requireApproval?: boolean;
  metadata?: Record<string, unknown>;
};

type DispatchWorkflowTriggerInput = {
  triggerId: string;
  bodyText: string;
  headers?: Headers | Record<string, string | undefined>;
  scheduleDrain?: boolean;
};

type SignatureVerification = {
  verified: boolean;
  error?: string;
};

export class WorkflowTriggerNotFoundError extends Error {
  constructor() {
    super("Workflow trigger not found.");
    this.name = "WorkflowTriggerNotFoundError";
  }
}

const defaultGoalTemplate = "Handle {{event.type}} from {{event.source}}: {{payload.summary}}";
const signatureMaxAgeMs = 5 * 60 * 1000;

export async function createWorkflowTrigger(input: CreateWorkflowTriggerInput) {
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(input.tenantId || getDatabaseTenantContext());
  const authMode = input.authMode || (input.secretEnvVar ? "hmac_sha256" : "none");
  const secretEnvVar = normalizeOptional(input.secretEnvVar);
  if (secretEnvVar && !validateTriggerSecretEnvName(secretEnvVar)) {
    throw new Error(
      "Trigger secret env var must use the OMNIAGENT_TRIGGER_ prefix or the deployer allowlist.",
    );
  }
  if (secretEnvVar && !process.env[secretEnvVar]) {
    throw new Error(
      `Trigger secret environment variable ${secretEnvVar} is not configured in this deployment.`,
    );
  }
  if (authMode === "hmac_sha256" && !secretEnvVar) {
    throw new Error("HMAC triggers require a secretEnvVar reference.");
  }
  if (authMode === "none" && isProductionRuntime()) {
    throw new Error("Unauthenticated workflow triggers are disabled in production.");
  }

  const record: WorkflowTriggerRecord = {
    id: randomUUID(),
    tenantId,
    name: input.name.trim().slice(0, 120),
    source: slugify(input.source || input.name),
    status: input.status || "active",
    authMode,
    secretEnvVar,
    goalTemplate: (input.goalTemplate || defaultGoalTemplate).trim().slice(0, 1200),
    workflowMode: input.workflowMode || "orchestrate",
    requireApproval: input.requireApproval ?? true,
    metadata: redactSensitive(input.metadata || {}) as Record<string, unknown>,
    triggerCount: 0,
    failureCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  return runWithDatabaseTenantScope(tenantId, () => saveWorkflowTrigger(record));
}

export async function listWorkflowTriggers(
  limit = 50,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    return runWithDatabaseTenantScope(tenantId, async () => {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT *
        FROM omni_workflow_triggers
        WHERE tenant_id = ${tenantId}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(workflowTriggerFromRow);
    });
  }

  const ledger = await readTriggerLedger();
  return ledger.triggers
    .filter((trigger) => triggerTenantId(trigger) === tenantId)
    .map((trigger) => ({ ...trigger, tenantId }))
    .slice(0, boundedLimit);
}

export async function getWorkflowTrigger(
  triggerId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  if (hasDatabaseUrl()) {
    return runWithDatabaseTenantScope(tenantId, async () => {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT *
        FROM omni_workflow_triggers
        WHERE id = ${triggerId}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      return rows[0] ? workflowTriggerFromRow(rows[0]) : null;
    });
  }

  const ledger = await readTriggerLedger();
  const trigger = ledger.triggers.find(
    (item) => item.id === triggerId && triggerTenantId(item) === tenantId,
  );
  return trigger ? { ...trigger, tenantId } : null;
}

export async function listWorkflowTriggerEvents(
  limit = 50,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    return runWithDatabaseTenantScope(tenantId, async () => {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT *
        FROM omni_workflow_trigger_events
        WHERE tenant_id = ${tenantId}
        ORDER BY received_at DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(workflowTriggerEventFromRow);
    });
  }

  const ledger = await readTriggerLedger();
  return ledger.events
    .filter((event) => normalizeTenantId(event.tenantId) === tenantId)
    .map((event) => ({ ...event, tenantId }))
    .slice(0, boundedLimit);
}

export async function getWorkflowTriggerStats(
  options: { tenantId?: string } = {},
): Promise<WorkflowTriggerStats> {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const [triggers, events] = await Promise.all([
    listWorkflowTriggers(500, { tenantId }),
    listWorkflowTriggerEvents(500, { tenantId }),
  ]);
  const byStatus = triggers.reduce<Record<string, number>>((acc, trigger) => {
    acc[trigger.status] = (acc[trigger.status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: triggers.length,
    active: triggers.filter((trigger) => trigger.status === "active").length,
    byStatus,
    events: events.length,
    acceptedEvents: events.filter((event) => event.status === "accepted").length,
    rejectedEvents: events.filter((event) => event.status === "rejected").length,
    enqueuedEvents: events.filter((event) => event.status === "enqueued").length,
    failedEvents: events.filter((event) => event.status === "failed").length,
    latestTriggers: triggers.slice(0, 5),
    latestEvents: events.slice(0, 5),
  };
}

export async function dispatchWorkflowTrigger(input: DispatchWorkflowTriggerInput) {
  const trigger = await getWorkflowTriggerForDispatch(input.triggerId);
  if (!trigger) {
    throw new WorkflowTriggerNotFoundError();
  }
  return runWithDatabaseTenantScope(trigger.tenantId, () =>
    dispatchWorkflowTriggerForTenant(input, trigger),
  );
}

async function dispatchWorkflowTriggerForTenant(
  input: DispatchWorkflowTriggerInput,
  trigger: WorkflowTriggerRecord,
) {
  const headers = normalizeHeaders(input.headers);
  const payload = parsePayload(input.bodyText);
  const eventType = inferEventType(payload, headers);
  const verification = verifyTriggerSignature(trigger, input.bodyText, headers);
  const delivery = triggerDeliveryIdentity(trigger, input.bodyText, headers);
  const rejectedPayload = rejectedTriggerPayloadEvidence(input.bodyText, payload);

  if (trigger.status !== "active") {
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      tenantId: trigger.tenantId,
      trigger,
      status: "rejected",
      signatureVerified: verification.verified,
      signatureDigest: delivery.signatureDigest,
      payload: rejectedPayload,
      headers,
      eventType,
      error: "Trigger is paused.",
    }));
    await incrementTriggerCounters(trigger.id, { failed: true });
    return { trigger, event, workflow: null, queueJob: null, replayed: false };
  }

  if (!verification.verified) {
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      tenantId: trigger.tenantId,
      trigger,
      status: "rejected",
      signatureVerified: false,
      signatureDigest: delivery.signatureDigest,
      payload: rejectedPayload,
      headers,
      eventType,
      error: verification.error || "Signature verification failed.",
    }));
    await incrementTriggerCounters(trigger.id, { failed: true });
    return { trigger, event, workflow: null, queueJob: null, replayed: false };
  }

  if (trigger.authMode === "none" && isProductionRuntime()) {
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      tenantId: trigger.tenantId,
      trigger,
      status: "rejected",
      signatureVerified: false,
      signatureDigest: delivery.signatureDigest,
      payload: rejectedPayload,
      headers,
      eventType,
      error: "Unauthenticated workflow triggers are disabled in production.",
    }));
    await incrementTriggerCounters(trigger.id, { failed: true }, trigger.tenantId);
    return { trigger, event, workflow: null, queueJob: null, replayed: false };
  }

  const claim = await claimWorkflowTriggerDelivery(createTriggerEvent({
    tenantId: trigger.tenantId,
    trigger,
    status: "accepted",
    signatureVerified: true,
    ...delivery,
    payload,
    headers,
    eventType,
  }));
  if (!claim.created) {
    return {
      trigger,
      event: claim.event,
      workflow: null,
      queueJob: null,
      replayed: true,
    };
  }

  const tenantId = trigger.tenantId;
  try {
    const goal = renderGoalTemplate(trigger, payload, eventType);
    const workflow = await createWorkflowRun({
      tenantId,
      idempotencyKey: `trigger:${trigger.id}:${delivery.deliveryKey}`,
      goal,
      mode: trigger.workflowMode,
      requireApproval: trigger.requireApproval,
      metadata: {
        source: "webhook",
        triggerId: trigger.id,
        triggerSource: trigger.source,
        eventType,
      },
    });
    const queueJob = await enqueueWorkflowRunTick(
      workflow.run.id,
      `webhook:${trigger.id}`,
      undefined,
      tenantId,
    );
    await appendWorkflowEvent(workflow.run.id, "workflow.trigger.received", {
      triggerId: trigger.id,
      source: trigger.source,
      eventType,
      queueJobId: queueJob.id,
    }).catch(() => undefined);
    const event = await saveWorkflowTriggerEvent({
      ...claim.event,
      status: "enqueued",
      workflowRunId: workflow.run.id,
      queueJobId: queueJob.id,
    });
    await incrementTriggerCounters(trigger.id, { triggered: true }, tenantId);
    return { trigger, event, workflow, queueJob, replayed: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trigger dispatch failed.";
    const event = await saveWorkflowTriggerEvent({
      ...claim.event,
      status: "failed",
      error: message,
    });
    await incrementTriggerCounters(trigger.id, { failed: true }, tenantId);
    return { trigger, event, workflow: null, queueJob: null, replayed: false };
  }
}

export function signWorkflowTriggerPayload({
  secret,
  bodyText,
  timestamp = String(Date.now()),
}: {
  secret: string;
  bodyText: string;
  timestamp?: string;
}) {
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${bodyText}`)
    .digest("hex");
  return {
    timestamp,
    signature: `sha256=${signature}`,
  };
}

async function saveWorkflowTrigger(record: WorkflowTriggerRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_triggers (
        id, tenant_id, name, source, status, auth_mode, secret_env_var, goal_template,
        workflow_mode, require_approval, metadata, trigger_count, failure_count,
        last_triggered_at, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.name}, ${record.source}, ${record.status},
        ${record.authMode}, ${record.secretEnvVar || null}, ${record.goalTemplate},
        ${record.workflowMode}, ${record.requireApproval},
        ${JSON.stringify(record.metadata || {})}::jsonb,
        ${record.triggerCount}, ${record.failureCount}, ${record.lastTriggeredAt || null},
        ${record.createdAt}, ${record.updatedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        name = EXCLUDED.name,
        source = EXCLUDED.source,
        status = EXCLUDED.status,
        auth_mode = EXCLUDED.auth_mode,
        secret_env_var = EXCLUDED.secret_env_var,
        goal_template = EXCLUDED.goal_template,
        workflow_mode = EXCLUDED.workflow_mode,
        require_approval = EXCLUDED.require_approval,
        metadata = EXCLUDED.metadata,
        trigger_count = EXCLUDED.trigger_count,
        failure_count = EXCLUDED.failure_count,
        last_triggered_at = EXCLUDED.last_triggered_at,
        updated_at = EXCLUDED.updated_at
    `;
    return record;
  }

  await mutateTriggerLedger((ledger) => {
    ledger.triggers = [record, ...ledger.triggers.filter((trigger) => trigger.id !== record.id)];
    return trimTriggerLedger(ledger);
  });
  return record;
}

async function getWorkflowTriggerForDispatch(triggerId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      `Resolve public workflow trigger ${triggerId} to its owning tenant.`,
      async () => {
        const rows = await getSql()`
          SELECT *
          FROM omni_workflow_triggers
          WHERE id = ${triggerId}
          LIMIT 1
        `;
        return rows[0] ? workflowTriggerFromRow(rows[0]) : null;
      },
    );
  }

  const trigger = (await readTriggerLedger()).triggers.find((item) => item.id === triggerId);
  return trigger ? { ...trigger, tenantId: triggerTenantId(trigger) } : null;
}

async function claimWorkflowTriggerDelivery(record: WorkflowTriggerEventRecord) {
  if (!record.deliveryKey) {
    return { created: true, event: await saveWorkflowTriggerEvent(record) };
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_workflow_trigger_events (
        id, tenant_id, trigger_id, delivery_key, signature_digest,
        status, source, event_type, signature_verified,
        workflow_run_id, queue_job_id, payload, headers, error, received_at
      )
      VALUES (
        ${record.id}, ${record.tenantId}, ${record.triggerId}, ${record.deliveryKey},
        ${record.signatureDigest || null}, ${record.status}, ${record.source},
        ${record.eventType || null}, ${record.signatureVerified},
        ${record.workflowRunId || null}, ${record.queueJobId || null},
        ${JSON.stringify(record.payload || {})}::jsonb,
        ${JSON.stringify(record.headers || {})}::jsonb,
        ${record.error || null}, ${record.receivedAt}
      )
      ON CONFLICT (tenant_id, trigger_id, delivery_key)
      WHERE delivery_key IS NOT NULL
      DO NOTHING
      RETURNING *
    `;
    if (rows[0]) {
      return { created: true, event: workflowTriggerEventFromRow(rows[0]) };
    }
    const existing = await getSql()`
      SELECT *
      FROM omni_workflow_trigger_events
      WHERE tenant_id = ${record.tenantId}
        AND trigger_id = ${record.triggerId}
        AND delivery_key = ${record.deliveryKey}
      LIMIT 1
    `;
    if (!existing[0]) {
      throw new Error("Workflow trigger delivery claim could not be resolved.");
    }
    const reclaimed = await getSql()`
      UPDATE omni_workflow_trigger_events
      SET status = 'accepted',
          error = NULL,
          received_at = NOW()
      WHERE tenant_id = ${record.tenantId}
        AND trigger_id = ${record.triggerId}
        AND delivery_key = ${record.deliveryKey}
        AND (
          status = 'failed'
          OR (status = 'accepted' AND received_at < NOW() - INTERVAL '5 minutes')
        )
      RETURNING *
    `;
    if (reclaimed[0]) {
      return { created: true, event: workflowTriggerEventFromRow(reclaimed[0]) };
    }
    return { created: false, event: workflowTriggerEventFromRow(existing[0]) };
  }

  let claimed = record;
  let created = true;
  await mutateTriggerLedger((ledger) => {
    const existing = ledger.events.find(
      (event) =>
        normalizeTenantId(event.tenantId) === record.tenantId &&
        event.triggerId === record.triggerId &&
        event.deliveryKey === record.deliveryKey,
    );
    if (existing) {
      const staleAccepted =
        existing.status === "accepted" &&
        Date.parse(existing.receivedAt) < Date.now() - 5 * 60_000;
      if (existing.status === "failed" || staleAccepted) {
        claimed = {
          ...existing,
          tenantId: record.tenantId,
          status: "accepted",
          error: undefined,
          receivedAt: new Date().toISOString(),
        };
        ledger.events = ledger.events.map((event) =>
          event.id === existing.id ? claimed : event
        );
        created = true;
        return ledger;
      }
      claimed = { ...existing, tenantId: record.tenantId };
      created = false;
      return ledger;
    }
    ledger.events.unshift(record);
    return trimTriggerLedger(ledger);
  });
  return { created, event: claimed };
}

async function saveWorkflowTriggerEvent(record: WorkflowTriggerEventRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_trigger_events (
        id, tenant_id, trigger_id, delivery_key, signature_digest,
        status, source, event_type, signature_verified,
        workflow_run_id, queue_job_id, payload, headers, error, received_at
      )
      VALUES (
        ${record.id}, ${normalizeTenantId(record.tenantId)}, ${record.triggerId},
        ${record.deliveryKey || null}, ${record.signatureDigest || null},
        ${record.status}, ${record.source},
        ${record.eventType || null}, ${record.signatureVerified},
        ${record.workflowRunId || null}, ${record.queueJobId || null},
        ${JSON.stringify(record.payload || {})}::jsonb,
        ${JSON.stringify(record.headers || {})}::jsonb,
        ${record.error || null}, ${record.receivedAt}
      )
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        signature_verified = EXCLUDED.signature_verified,
        workflow_run_id = EXCLUDED.workflow_run_id,
        queue_job_id = EXCLUDED.queue_job_id,
        payload = EXCLUDED.payload,
        headers = EXCLUDED.headers,
        error = EXCLUDED.error
    `;
    return record;
  }

  await mutateTriggerLedger((ledger) => {
    ledger.events = [record, ...ledger.events.filter((event) => event.id !== record.id)];
    return trimTriggerLedger(ledger);
  });
  return record;
}

async function incrementTriggerCounters(
  triggerId: string,
  input: { triggered?: boolean; failed?: boolean },
  tenantId = currentTenantId(),
) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_workflow_triggers
      SET
        trigger_count = trigger_count + ${input.triggered ? 1 : 0},
        failure_count = failure_count + ${input.failed ? 1 : 0},
        last_triggered_at = CASE
          WHEN ${Boolean(input.triggered)} THEN ${now}
          ELSE last_triggered_at
        END,
        updated_at = ${now}
      WHERE id = ${triggerId}
        AND tenant_id = ${normalizedTenantId}
      RETURNING *
    `;
    return rows[0] ? workflowTriggerFromRow(rows[0]) : null;
  }

  let updated: WorkflowTriggerRecord | null = null;
  await mutateTriggerLedger((ledger) => {
    ledger.triggers = ledger.triggers.map((trigger) => {
      if (
        trigger.id !== triggerId ||
        normalizeTenantId(trigger.tenantId) !== normalizedTenantId
      ) {
        return trigger;
      }
      updated = {
        ...trigger,
        tenantId: normalizedTenantId,
        triggerCount: trigger.triggerCount + (input.triggered ? 1 : 0),
        failureCount: trigger.failureCount + (input.failed ? 1 : 0),
        lastTriggeredAt: input.triggered ? now : trigger.lastTriggeredAt,
        updatedAt: now,
      };
      return updated;
    });
    return trimTriggerLedger(ledger);
  });
  return updated;
}

function createTriggerEvent({
  tenantId,
  trigger,
  status,
  signatureVerified,
  deliveryKey,
  signatureDigest,
  payload,
  headers,
  eventType,
  workflowRunId,
  queueJobId,
  error,
}: {
  tenantId?: string;
  trigger: WorkflowTriggerRecord;
  status: WorkflowTriggerEventStatus;
  signatureVerified: boolean;
  deliveryKey?: string;
  signatureDigest?: string;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  eventType?: string;
  workflowRunId?: string;
  queueJobId?: string;
  error?: string;
}): WorkflowTriggerEventRecord {
  return {
    id: randomUUID(),
    tenantId: normalizeTenantId(tenantId),
    triggerId: trigger.id,
    deliveryKey,
    signatureDigest,
    status,
    source: trigger.source,
    eventType,
    signatureVerified,
    workflowRunId,
    queueJobId,
    payload: redactSensitive(payload) as Record<string, unknown>,
    headers: redactTriggerHeaders(headers),
    error,
    receivedAt: new Date().toISOString(),
  };
}

function verifyTriggerSignature(
  trigger: WorkflowTriggerRecord,
  bodyText: string,
  headers: Record<string, unknown>,
): SignatureVerification {
  if (trigger.authMode === "none") {
    return isProductionRuntime()
      ? {
          verified: false,
          error: "Unauthenticated workflow triggers are disabled in production.",
        }
      : { verified: true };
  }

  if (!validateTriggerSecretEnvName(trigger.secretEnvVar)) {
    return {
      verified: false,
      error: "Trigger secret environment variable is not permitted.",
    };
  }

  const secret = trigger.secretEnvVar ? process.env[trigger.secretEnvVar] : undefined;
  if (!secret) {
    return { verified: false, error: "Trigger secret env var is not configured." };
  }

  const githubSignature = String(headers["x-hub-signature-256"] || "");
  if (githubSignature) {
    const expected = `sha256=${createHmac("sha256", secret)
      .update(bodyText)
      .digest("hex")}`;
    return safeEqual(githubSignature, expected)
      ? { verified: true }
      : { verified: false, error: "GitHub webhook signature mismatch." };
  }

  const timestamp = String(headers["x-omni-timestamp"] || headers["x-webhook-timestamp"] || "");
  const signature = String(headers["x-omni-signature"] || "");
  if (!timestamp || !signature) {
    return { verified: false, error: "Missing webhook signature headers." };
  }

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs) || Math.abs(Date.now() - timestampMs) > signatureMaxAgeMs) {
    return { verified: false, error: "Webhook signature timestamp is outside the allowed window." };
  }

  const expected = signWorkflowTriggerPayload({ secret, bodyText, timestamp }).signature;
  return safeEqual(signature, expected)
    ? { verified: true }
    : { verified: false, error: "Webhook signature mismatch." };
}

function safeEqual(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function renderGoalTemplate(trigger: WorkflowTriggerRecord, payload: Record<string, unknown>, eventType?: string) {
  const fallbackSummary = summarizePayload(payload);
  const values: Record<string, string> = {
    "event.type": eventType || "webhook event",
    "event.source": trigger.source,
    "payload.summary": String(readPath(payload, "summary") || readPath(payload, "title") || fallbackSummary),
  };
  return trigger.goalTemplate.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (values[key] !== undefined) {
      return values[key];
    }
    if (key.startsWith("payload.")) {
      return String(readPath(payload, key.slice("payload.".length)) || "");
    }
    return "";
  }).trim().slice(0, 4000) || `Handle webhook event from ${trigger.source}: ${fallbackSummary}`;
}

function inferEventType(payload: Record<string, unknown>, headers: Record<string, unknown>) {
  const value =
    readPath(payload, "type") ||
    readPath(payload, "event") ||
    readPath(payload, "action") ||
    headers["x-github-event"] ||
    headers["x-slack-event-type"] ||
    headers["x-event-type"];
  return value ? String(value).slice(0, 120) : undefined;
}

function parsePayload(bodyText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(bodyText || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : { value: parsed };
  } catch {
    return { text: bodyText.slice(0, 5000) };
  }
}

function rejectedTriggerPayloadEvidence(
  bodyText: string,
  payload: Record<string, unknown>,
) {
  return {
    redacted: true,
    bytes: Buffer.byteLength(bodyText, "utf8"),
    sha256: createHash("sha256").update(bodyText).digest("hex"),
    topLevelKeys: Object.keys(payload).slice(0, 25),
  };
}

function normalizeHeaders(headers?: Headers | Record<string, string | undefined>) {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(
      [...headers.entries()]
        .filter(([key]) =>
          key.toLowerCase().startsWith("x-") || key.toLowerCase() === "idempotency-key",
        )
        .map(([key, value]) => [key.toLowerCase(), value.slice(0, 500)]),
    );
  }

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.toLowerCase(), String(value).slice(0, 500)]),
  );
}

function redactTriggerHeaders(headers: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(
      redactSensitive(headers) as Record<string, unknown>,
    ).map(([key, value]) => [
      key,
      key.includes("signature") ? "[redacted]" : value,
    ]),
  );
}

function readPath(value: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (current && typeof current === "object" && !Array.isArray(current)) {
      return (current as Record<string, unknown>)[part];
    }
    return undefined;
  }, value);
}

function summarizePayload(payload: Record<string, unknown>) {
  return JSON.stringify(redactSensitive(payload)).slice(0, 600);
}

async function readTriggerLedger() {
  return readJsonFile<WorkflowTriggerLedger>(getTriggerFile(), { triggers: [], events: [] });
}

async function mutateTriggerLedger(mutator: (ledger: WorkflowTriggerLedger) => WorkflowTriggerLedger) {
  await updateJsonFile<WorkflowTriggerLedger>(
    getTriggerFile(),
    { triggers: [], events: [] },
    (ledger) => trimTriggerLedger(mutator(ledger)),
  );
}

function trimTriggerLedger(ledger: WorkflowTriggerLedger): WorkflowTriggerLedger {
  const triggerIds = new Set(ledger.triggers.slice(0, 500).map((trigger) => trigger.id));
  return {
    triggers: ledger.triggers.slice(0, 500),
    events: ledger.events.filter((event) => triggerIds.has(event.triggerId)).slice(0, 1000),
  };
}

function workflowTriggerFromRow(row: Record<string, unknown>): WorkflowTriggerRecord {
  return {
    id: String(row.id),
    tenantId: normalizeTenantId(row.tenant_id ? String(row.tenant_id) : undefined),
    name: String(row.name),
    source: String(row.source),
    status: String(row.status) === "paused" ? "paused" : "active",
    authMode: String(row.auth_mode) === "none" ? "none" : "hmac_sha256",
    secretEnvVar: row.secret_env_var ? String(row.secret_env_var) : undefined,
    goalTemplate: String(row.goal_template || defaultGoalTemplate),
    workflowMode: normalizeWorkflowMode(row.workflow_mode),
    requireApproval: Boolean(row.require_approval),
    metadata: parseObject(row.metadata) || {},
    triggerCount: Number(row.trigger_count || 0),
    failureCount: Number(row.failure_count || 0),
    lastTriggeredAt: row.last_triggered_at ? normalizeDate(row.last_triggered_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function workflowTriggerEventFromRow(row: Record<string, unknown>): WorkflowTriggerEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    triggerId: String(row.trigger_id),
    deliveryKey: row.delivery_key ? String(row.delivery_key) : undefined,
    signatureDigest: row.signature_digest ? String(row.signature_digest) : undefined,
    status: normalizeEventStatus(row.status),
    source: String(row.source),
    eventType: row.event_type ? String(row.event_type) : undefined,
    signatureVerified: Boolean(row.signature_verified),
    workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
    queueJobId: row.queue_job_id ? String(row.queue_job_id) : undefined,
    payload: parseObject(row.payload) || {},
    headers: parseObject(row.headers) || {},
    error: row.error ? String(row.error) : undefined,
    receivedAt: normalizeDate(row.received_at),
  };
}

function currentTenantId() {
  return normalizeTenantId(getDatabaseTenantContext());
}

function triggerTenantId(trigger: { tenantId?: string }) {
  return normalizeTenantId(trigger.tenantId);
}

function triggerDeliveryIdentity(
  trigger: WorkflowTriggerRecord,
  bodyText: string,
  headers: Record<string, unknown>,
) {
  const explicitKey =
    headers["x-omni-delivery-key"] ||
    headers["x-github-delivery"] ||
    headers["x-webhook-id"] ||
    headers["idempotency-key"];
  const signature = String(
    headers["x-omni-signature"] || headers["x-hub-signature-256"] || "",
  );
  const signatureDigest = signature
    ? createHash("sha256").update(signature).digest("hex")
    : undefined;
  const fallback = createHash("sha256")
    .update(
      [
        trigger.id,
        String(headers["x-omni-timestamp"] || headers["x-webhook-timestamp"] || ""),
        signatureDigest || "",
        bodyText,
      ].join("\0"),
    )
    .digest("hex");
  return {
    deliveryKey: String(explicitKey || fallback).slice(0, 240),
    signatureDigest,
  };
}

function isProductionRuntime() {
  return Boolean(
    process.env.NODE_ENV === "production" ||
      process.env.VERCEL ||
      process.env.VERCEL_ENV === "production",
  );
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function normalizeWorkflowMode(value: unknown): WorkflowTriggerRecord["workflowMode"] {
  const mode = String(value || "orchestrate");
  return mode === "research" || mode === "execute" || mode === "learn" ? mode : "orchestrate";
}

function normalizeEventStatus(value: unknown): WorkflowTriggerEventStatus {
  const status = String(value || "failed");
  return status === "accepted" || status === "rejected" || status === "enqueued" || status === "failed"
    ? status
    : "failed";
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

function normalizeOptional(value?: string) {
  return value?.trim() || undefined;
}

function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "webhook";
}

function getTriggerFile() {
  return getDataPath("workflow-triggers.json");
}
