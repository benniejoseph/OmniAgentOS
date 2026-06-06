import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { redactSensitive, validateSecretEnvName } from "@/lib/security/context";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
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

const defaultGoalTemplate = "Handle {{event.type}} from {{event.source}}: {{payload.summary}}";
const signatureMaxAgeMs = 5 * 60 * 1000;

let triggerFileWriteQueue: Promise<void> = Promise.resolve();

export async function createWorkflowTrigger(input: CreateWorkflowTriggerInput) {
  const now = new Date().toISOString();
  const authMode = input.authMode || (input.secretEnvVar ? "hmac_sha256" : "none");
  const secretEnvVar = normalizeOptional(input.secretEnvVar);
  if (secretEnvVar && !validateSecretEnvName(secretEnvVar)) {
    throw new Error("Trigger secret env var must be uppercase server-only env name.");
  }
  if (authMode === "hmac_sha256" && !secretEnvVar) {
    throw new Error("HMAC triggers require a secretEnvVar reference.");
  }

  const record: WorkflowTriggerRecord = {
    id: randomUUID(),
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

  return saveWorkflowTrigger(record);
}

export async function listWorkflowTriggers(limit = 50) {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_triggers
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowTriggerFromRow);
  }

  const ledger = await readTriggerLedger();
  return ledger.triggers.slice(0, boundedLimit);
}

export async function getWorkflowTrigger(triggerId: string) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_triggers
      WHERE id = ${triggerId}
      LIMIT 1
    `;
    return rows[0] ? workflowTriggerFromRow(rows[0]) : null;
  }

  const ledger = await readTriggerLedger();
  return ledger.triggers.find((trigger) => trigger.id === triggerId) || null;
}

export async function listWorkflowTriggerEvents(limit = 50) {
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_trigger_events
      ORDER BY received_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowTriggerEventFromRow);
  }

  const ledger = await readTriggerLedger();
  return ledger.events.slice(0, boundedLimit);
}

export async function getWorkflowTriggerStats(): Promise<WorkflowTriggerStats> {
  const [triggers, events] = await Promise.all([
    listWorkflowTriggers(500),
    listWorkflowTriggerEvents(500),
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
  const trigger = await getWorkflowTrigger(input.triggerId);
  if (!trigger) {
    throw new Error("Workflow trigger not found.");
  }

  const headers = normalizeHeaders(input.headers);
  const payload = parsePayload(input.bodyText);
  const eventType = inferEventType(payload, headers);
  const verification = verifyTriggerSignature(trigger, input.bodyText, headers);

  if (trigger.status !== "active") {
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      trigger,
      status: "rejected",
      signatureVerified: verification.verified,
      payload,
      headers,
      eventType,
      error: "Trigger is paused.",
    }));
    await incrementTriggerCounters(trigger.id, { failed: true });
    return { trigger, event, workflow: null, queueJob: null };
  }

  if (!verification.verified) {
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      trigger,
      status: "rejected",
      signatureVerified: false,
      payload,
      headers,
      eventType,
      error: verification.error || "Signature verification failed.",
    }));
    await incrementTriggerCounters(trigger.id, { failed: true });
    return { trigger, event, workflow: null, queueJob: null };
  }

  try {
    const goal = renderGoalTemplate(trigger, payload, eventType);
    const workflow = await createWorkflowRun({
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
    const queueJob = await enqueueWorkflowRunTick(workflow.run.id, `webhook:${trigger.id}`);
    await appendWorkflowEvent(workflow.run.id, "workflow.trigger.received", {
      triggerId: trigger.id,
      source: trigger.source,
      eventType,
      queueJobId: queueJob.id,
    }).catch(() => undefined);
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      trigger,
      status: "enqueued",
      signatureVerified: verification.verified,
      payload,
      headers,
      eventType,
      workflowRunId: workflow.run.id,
      queueJobId: queueJob.id,
    }));
    await incrementTriggerCounters(trigger.id, { triggered: true });
    return { trigger, event, workflow, queueJob };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trigger dispatch failed.";
    const event = await saveWorkflowTriggerEvent(createTriggerEvent({
      trigger,
      status: "failed",
      signatureVerified: verification.verified,
      payload,
      headers,
      eventType,
      error: message,
    }));
    await incrementTriggerCounters(trigger.id, { failed: true });
    return { trigger, event, workflow: null, queueJob: null };
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
        id, name, source, status, auth_mode, secret_env_var, goal_template,
        workflow_mode, require_approval, metadata, trigger_count, failure_count,
        last_triggered_at, created_at, updated_at
      )
      VALUES (
        ${record.id}, ${record.name}, ${record.source}, ${record.status},
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

async function saveWorkflowTriggerEvent(record: WorkflowTriggerEventRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_trigger_events (
        id, trigger_id, status, source, event_type, signature_verified,
        workflow_run_id, queue_job_id, payload, headers, error, received_at
      )
      VALUES (
        ${record.id}, ${record.triggerId}, ${record.status}, ${record.source},
        ${record.eventType || null}, ${record.signatureVerified},
        ${record.workflowRunId || null}, ${record.queueJobId || null},
        ${JSON.stringify(record.payload || {})}::jsonb,
        ${JSON.stringify(record.headers || {})}::jsonb,
        ${record.error || null}, ${record.receivedAt}
      )
    `;
    return record;
  }

  await mutateTriggerLedger((ledger) => {
    ledger.events = [record, ...ledger.events.filter((event) => event.id !== record.id)];
    return trimTriggerLedger(ledger);
  });
  return record;
}

async function incrementTriggerCounters(triggerId: string, input: { triggered?: boolean; failed?: boolean }) {
  const trigger = await getWorkflowTrigger(triggerId);
  if (!trigger) {
    return null;
  }

  return saveWorkflowTrigger({
    ...trigger,
    triggerCount: trigger.triggerCount + (input.triggered ? 1 : 0),
    failureCount: trigger.failureCount + (input.failed ? 1 : 0),
    lastTriggeredAt: input.triggered ? new Date().toISOString() : trigger.lastTriggeredAt,
    updatedAt: new Date().toISOString(),
  });
}

function createTriggerEvent({
  trigger,
  status,
  signatureVerified,
  payload,
  headers,
  eventType,
  workflowRunId,
  queueJobId,
  error,
}: {
  trigger: WorkflowTriggerRecord;
  status: WorkflowTriggerEventStatus;
  signatureVerified: boolean;
  payload: Record<string, unknown>;
  headers: Record<string, unknown>;
  eventType?: string;
  workflowRunId?: string;
  queueJobId?: string;
  error?: string;
}): WorkflowTriggerEventRecord {
  return {
    id: randomUUID(),
    triggerId: trigger.id,
    status,
    source: trigger.source,
    eventType,
    signatureVerified,
    workflowRunId,
    queueJobId,
    payload: redactSensitive(payload) as Record<string, unknown>,
    headers: redactSensitive(headers) as Record<string, unknown>,
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
    return { verified: true };
  }

  const secret = trigger.secretEnvVar ? process.env[trigger.secretEnvVar] : undefined;
  if (!secret) {
    return { verified: false, error: "Trigger secret env var is not configured." };
  }

  const timestamp = String(headers["x-omni-timestamp"] || headers["x-webhook-timestamp"] || "");
  const signature = String(headers["x-omni-signature"] || headers["x-hub-signature-256"] || "");
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

function normalizeHeaders(headers?: Headers | Record<string, string | undefined>) {
  if (!headers) {
    return {};
  }
  if (headers instanceof Headers) {
    return Object.fromEntries(
      [...headers.entries()]
        .filter(([key]) => key.toLowerCase().startsWith("x-"))
        .map(([key, value]) => [key.toLowerCase(), value.slice(0, 500)]),
    );
  }

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key.toLowerCase(), String(value).slice(0, 500)]),
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
  triggerFileWriteQueue = triggerFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readTriggerLedger());
      await writeTriggerLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readTriggerLedger());
      await writeTriggerLedger(ledger);
    },
  );
  await triggerFileWriteQueue;
}

async function writeTriggerLedger(ledger: WorkflowTriggerLedger) {
  await writeJsonFile(getTriggerFile(), trimTriggerLedger(ledger));
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
    triggerId: String(row.trigger_id),
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
