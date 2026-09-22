import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { parseAgentRunIdentityPinV1 } from "@/lib/agents/identity-contracts";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  redactSensitive,
  validateTriggerSecretEnvName,
} from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { runBudgetCountersV1Schema } from "@/lib/runs/budgets";
import { enqueueWorkflowRunTick } from "@/lib/workflows/queue";
import { appendWorkflowEvent, createWorkflowRun } from "@/lib/workflows/store";
import type {
  WorkflowTriggerAuthMode,
  WorkflowTriggerEventRecord,
  WorkflowTriggerEventStatus,
  WorkflowTriggerKind,
  WorkflowTriggerRecord,
  WorkflowScheduleConfigV1,
  WorkflowScheduleMissedPolicy,
  WorkflowScheduleShadowOutcome,
  WorkflowScheduleShadowReceiptV1,
  WorkflowTriggerStats,
} from "@/lib/workflows/types";

type WorkflowTriggerLedger = {
  triggers: WorkflowTriggerRecord[];
  events: WorkflowTriggerEventRecord[];
};

type CreateWorkflowTriggerBaseInput = {
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
  executionScope?: ExecutionScope;
  idempotencyKey?: string;
};

type CreateWebhookWorkflowTriggerInput = CreateWorkflowTriggerBaseInput & {
  triggerKind?: "webhook";
};

type CreateScheduleWorkflowTriggerInput = CreateWorkflowTriggerBaseInput & {
  triggerKind: "schedule";
  schedule: {
    timezone: string;
    rrule: string;
    startsAt: string;
    endsAt?: string;
    maxOccurrences: number;
    missedPolicy: WorkflowScheduleMissedPolicy;
    procedurePin: {
      schemaVersion: 1;
      procedureId: string;
      snapshotSha256: string;
      reviewedSnapshotSha256: string;
      reviewedAt: string;
    };
    agentIdentityPin: unknown;
    occurrenceBudget: unknown;
    failureLimit?: number;
  };
};

type CreateWorkflowTriggerInput =
  | CreateWebhookWorkflowTriggerInput
  | CreateScheduleWorkflowTriggerInput;

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
const scheduleDueGraceMs = 60_000;
const scheduleEvaluationLimit = 10_000;
const scheduleRruleSchema = z.object({
  freq: z.enum(["DAILY", "WEEKLY", "MONTHLY"]),
  interval: z.number().int().min(1).max(365),
  byDay: z.array(z.enum(["MO", "TU", "WE", "TH", "FR", "SA", "SU"]))
    .max(7),
  byHour: z.number().int().min(0).max(23),
  byMinute: z.number().int().min(0).max(59),
}).strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const scheduleProcedurePinSchema = z.object({
  schemaVersion: z.literal(1),
  procedureId: z.string().trim().min(1).max(240)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/),
  snapshotSha256: sha256Schema,
  reviewedSnapshotSha256: sha256Schema,
  reviewedAt: z.string().datetime({ offset: true }),
}).strict();

const scheduleOccurrenceBudgetSchema = runBudgetCountersV1Schema.superRefine(
  (budget, context) => {
    const maxima = {
      modelTurns: 20,
      tokens: 200_000,
      costMicrousd: 10_000_000,
      wallTimeMs: 3_600_000,
      toolCalls: 100,
      browserActions: 20,
      agents: 5,
      fanOut: 4,
      retries: 3,
      replans: 2,
    } as const;
    for (const [dimension, maximum] of Object.entries(maxima)) {
      if (budget[dimension as keyof typeof budget] > maximum) {
        context.addIssue({
          code: "custom",
          path: [dimension],
          message: `Scheduled occurrence ${dimension} exceeds its safe maximum.`,
        });
      }
    }
    if (budget.wallTimeMs < 1_000) {
      context.addIssue({
        code: "custom",
        path: ["wallTimeMs"],
        message: "Scheduled occurrence wall time must be at least one second.",
      });
    }
  },
);

type ParsedScheduleRrule = z.infer<typeof scheduleRruleSchema>;

export async function createWorkflowTrigger(input: CreateWorkflowTriggerInput) {
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(input.tenantId || getDatabaseTenantContext());
  const triggerKind: WorkflowTriggerKind = input.triggerKind || "webhook";
  const ownerActorId = triggerKind === "schedule"
    ? requiredScheduleOwner(input.executionScope, tenantId)
    : undefined;
  const authMode = triggerKind === "schedule"
    ? "none"
    : input.authMode || (input.secretEnvVar ? "hmac_sha256" : "none");
  const secretEnvVar = triggerKind === "schedule"
    ? undefined
    : normalizeOptional(input.secretEnvVar);
  if (triggerKind === "webhook") {
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
  }
  const schedule = input.triggerKind === "schedule"
    ? buildWorkflowSchedule(input.schedule, {
        tenantId,
        ownerActorId: ownerActorId!,
        now,
      })
    : undefined;

  const record: WorkflowTriggerRecord = {
    id: input.idempotencyKey
      ? deterministicTriggerId(tenantId, input.idempotencyKey)
      : randomUUID(),
    tenantId,
    triggerKind,
    ownerActorId,
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
    schedule,
    createdAt: now,
    updatedAt: now,
  };

  const save = () => saveWorkflowTrigger(
    record,
    input.executionScope,
    input.idempotencyKey || record.id,
  );
  return ownerActorId
    ? runWithDatabaseActorScope(tenantId, [ownerActorId], save)
    : runWithDatabaseTenantScope(tenantId, save);
}

export async function listWorkflowTriggers(
  limit = 50,
  options: { tenantId?: string; actorId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    const operation = async () => {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT *
        FROM omni_workflow_triggers
        WHERE tenant_id = ${tenantId}
        ORDER BY updated_at DESC
        LIMIT ${boundedLimit}
      `;
      return rows.map(workflowTriggerFromRow);
    };
    return options.actorId
      ? runWithDatabaseActorScope(tenantId, [options.actorId], operation)
      : runWithDatabaseTenantScope(tenantId, operation);
  }

  const ledger = await readTriggerLedger();
  return ledger.triggers
    .filter((trigger) => triggerTenantId(trigger) === tenantId)
    .map((trigger) => normalizeLegacyWorkflowTrigger({ ...trigger, tenantId }))
    .filter((trigger) => workflowTriggerVisibleToActor(trigger, options.actorId))
    .slice(0, boundedLimit);
}

export async function getWorkflowTrigger(
  triggerId: string,
  options: { tenantId?: string; actorId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  if (hasDatabaseUrl()) {
    const operation = async () => {
      await ensureDatabaseSchema();
      const rows = await getSql()`
        SELECT *
        FROM omni_workflow_triggers
        WHERE id = ${triggerId}
          AND tenant_id = ${tenantId}
        LIMIT 1
      `;
      return rows[0] ? workflowTriggerFromRow(rows[0]) : null;
    };
    return options.actorId
      ? runWithDatabaseActorScope(tenantId, [options.actorId], operation)
      : runWithDatabaseTenantScope(tenantId, operation);
  }

  const ledger = await readTriggerLedger();
  const trigger = ledger.triggers.find(
    (item) => item.id === triggerId && triggerTenantId(item) === tenantId,
  );
  const normalized = trigger
    ? normalizeLegacyWorkflowTrigger({ ...trigger, tenantId })
    : null;
  return normalized && workflowTriggerVisibleToActor(normalized, options.actorId)
    ? normalized
    : null;
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
  options: { tenantId?: string; actorId?: string } = {},
): Promise<WorkflowTriggerStats> {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const [triggers, events] = await Promise.all([
    listWorkflowTriggers(500, { tenantId, actorId: options.actorId }),
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

export function nextWorkflowScheduleOccurrence(input: {
  config: WorkflowScheduleConfigV1;
  after: string;
  completedOccurrences: number;
}) {
  const config = parseWorkflowScheduleConfig(input.config);
  const afterMs = requireTimestamp(input.after, "schedule evaluation cursor");
  if (input.completedOccurrences >= config.maxOccurrences) return undefined;
  const startsAtMs = Date.parse(config.startsAt);
  const endsAtMs = config.endsAt ? Date.parse(config.endsAt) : undefined;
  const rule = parseBoundedScheduleRrule(
    config.rrule,
    config.timezone,
    config.startsAt,
  );
  const startLocal = localDateTimeParts(startsAtMs, config.timezone);
  const afterLocal = localDateTimeParts(
    Math.max(afterMs, startsAtMs - 60_000),
    config.timezone,
  );
  const cursorDate = {
    year: afterLocal.year,
    month: afterLocal.month,
    day: afterLocal.day,
  };
  const maxSearchDays = Math.min(
    Math.max(rule.interval * (rule.freq === "MONTHLY" ? 32 : 8) + 400, 800),
    20_000,
  );
  for (let offset = 0; offset <= maxSearchDays; offset += 1) {
    const date = addLocalDays(cursorDate, offset);
    if (!localDateMatchesRule(date, startLocal, rule)) continue;
    const candidateMs = resolveZonedLocalDateTime({
      ...date,
      hour: rule.byHour,
      minute: rule.byMinute,
    }, config.timezone);
    if (candidateMs === undefined || candidateMs < startsAtMs || candidateMs <= afterMs) {
      continue;
    }
    if (endsAtMs !== undefined && candidateMs > endsAtMs) return undefined;
    return new Date(candidateMs).toISOString();
  }
  throw new Error("Scheduled occurrence exceeds the bounded evaluation horizon.");
}

export function evaluateWorkflowScheduleShadow(input: {
  config: WorkflowScheduleConfigV1;
  currentNextDueAt: string;
  occurrenceCount: number;
  now: string;
}) {
  const config = parseWorkflowScheduleConfig(input.config);
  const nowMs = requireTimestamp(input.now, "schedule evaluation time");
  const firstDueMs = requireTimestamp(input.currentNextDueAt, "schedule next due time");
  if (firstDueMs > nowMs) {
    throw new Error("Scheduled trigger is not due for shadow evaluation.");
  }
  if (
    input.occurrenceCount >= config.maxOccurrences ||
    (config.endsAt && firstDueMs > Date.parse(config.endsAt))
  ) {
    return {
      scheduledFor: new Date(firstDueMs).toISOString(),
      evaluatedThrough: new Date(nowMs).toISOString(),
      outcome: "exhausted" as const,
      wouldCreateRun: false,
      occurrencesConsumed: 0,
      occurrenceCount: input.occurrenceCount,
      nextDueAt: undefined,
    };
  }

  let cursor = new Date(firstDueMs).toISOString();
  let latestDue = cursor;
  let consumed = 0;
  const missed = nowMs - firstDueMs > scheduleDueGraceMs;
  const collapseMissed = missed;
  while (
    Date.parse(cursor) <= nowMs &&
    input.occurrenceCount + consumed < config.maxOccurrences
  ) {
    latestDue = cursor;
    consumed += 1;
    if (!collapseMissed) break;
    if (consumed >= scheduleEvaluationLimit) {
      throw new Error("Scheduled missed-run evaluation exceeded its bounded occurrence limit.");
    }
    const next = nextWorkflowScheduleOccurrence({
      config,
      after: cursor,
      completedOccurrences: input.occurrenceCount + consumed,
    });
    if (!next || Date.parse(next) > nowMs) {
      cursor = next || "";
      break;
    }
    cursor = next;
  }

  const occurrenceCount = input.occurrenceCount + consumed;
  const nextDueAt = cursor && Date.parse(cursor) > nowMs
    ? cursor
    : nextWorkflowScheduleOccurrence({
        config,
        after: latestDue,
        completedOccurrences: occurrenceCount,
      });
  const outcome: WorkflowScheduleShadowOutcome = missed
    ? config.missedPolicy === "run_once"
      ? "missed_run_once"
      : "missed_skipped"
    : "due";
  return {
    scheduledFor: missed && config.missedPolicy === "run_once"
      ? latestDue
      : new Date(firstDueMs).toISOString(),
    evaluatedThrough: new Date(nowMs).toISOString(),
    outcome,
    wouldCreateRun: outcome === "due" || outcome === "missed_run_once",
    occurrencesConsumed: consumed,
    occurrenceCount,
    nextDueAt,
  };
}

/**
 * Claims due actor-owned schedules for a metadata-only shadow comparison.
 * It advances only the shadow cursor and never creates or queues a workflow.
 */
export async function claimDueWorkflowScheduleShadows(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  now?: string;
  limit?: number;
}): Promise<WorkflowScheduleShadowReceiptV1[]> {
  if (!hasDatabaseUrl()) {
    throw new Error("Scheduled workflow shadow claims require durable database storage.");
  }
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  assertExecutionScopeTenant(input.executionScope, tenantId);
  if (input.executionScope.initiatingActorId !== actorId) {
    throw new Error("Scheduled workflow shadow claims require the owning actor scope.");
  }
  const now = new Date(requireTimestamp(
    input.now || new Date().toISOString(),
    "schedule evaluation time",
  )).toISOString();
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  return runWithDatabaseActorScope(tenantId, [actorId], async () => {
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const dueRows = await sql`
        SELECT *
        FROM omni_workflow_triggers
        WHERE tenant_id = ${tenantId}
          AND owner_actor_id = ${actorId}
          AND trigger_kind = 'schedule'
          AND status = 'active'
          AND circuit_state = 'closed'
          AND shadow_next_due_at IS NOT NULL
          AND shadow_next_due_at <= ${now}
        ORDER BY shadow_next_due_at ASC, id COLLATE "C"
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      const receipts: WorkflowScheduleShadowReceiptV1[] = [];
      for (const row of dueRows) {
        const trigger = workflowTriggerFromRow(row);
        if (!trigger.schedule || !trigger.ownerActorId) continue;
        const currentNextDueAt = trigger.schedule.state.shadowNextDueAt;
        if (!currentNextDueAt) continue;
        const evaluation = evaluateWorkflowScheduleShadow({
          config: trigger.schedule.config,
          currentNextDueAt,
          occurrenceCount: trigger.schedule.state.shadowOccurrenceCount,
          now,
        });
        const receiptBody = {
          schemaVersion: 1 as const,
          id: `workflow_schedule_shadow_${canonicalJsonSha256({
            tenantId,
            actorId,
            triggerId: trigger.id,
            currentNextDueAt,
          }).slice(0, 40)}`,
          tenantId,
          ownerActorId: actorId,
          triggerId: trigger.id,
          ...evaluation,
          configurationSha256: trigger.schedule.config.configSha256,
          agentIdentityPinSha256:
            trigger.schedule.config.agentIdentityPin.pinSha256,
          policyPinSha256: trigger.schedule.config.policyPinSha256,
          procedureSnapshotSha256:
            trigger.schedule.config.procedurePin.snapshotSha256,
          reviewedSnapshotSha256:
            trigger.schedule.config.procedurePin.reviewedSnapshotSha256,
          occurrenceBudgetSha256: canonicalJsonSha256(
            trigger.schedule.config.occurrenceBudget,
          ),
          evaluatedAt: now,
        };
        const receipt: WorkflowScheduleShadowReceiptV1 = Object.freeze({
          ...receiptBody,
          receiptSha256: canonicalJsonSha256(receiptBody),
        });
        const inserted = await sql`
          INSERT INTO omni_workflow_schedule_shadow_events (
            schema_version, id, tenant_id, owner_actor_id, trigger_id,
            scheduled_for, evaluated_through, outcome, would_create_run,
            occurrences_consumed, occurrence_count, next_due_at,
            configuration_sha256, agent_identity_pin_sha256, policy_pin_sha256,
            procedure_snapshot_sha256, reviewed_snapshot_sha256,
            occurrence_budget_sha256, evaluated_at, receipt_sha256
          ) VALUES (
            ${receipt.schemaVersion}, ${receipt.id}, ${tenantId}, ${actorId},
            ${trigger.id}, ${receipt.scheduledFor}, ${receipt.evaluatedThrough},
            ${receipt.outcome}, ${receipt.wouldCreateRun},
            ${receipt.occurrencesConsumed}, ${receipt.occurrenceCount},
            ${receipt.nextDueAt || null}, ${receipt.configurationSha256},
            ${receipt.agentIdentityPinSha256}, ${receipt.policyPinSha256},
            ${receipt.procedureSnapshotSha256}, ${receipt.reviewedSnapshotSha256},
            ${receipt.occurrenceBudgetSha256}, ${receipt.evaluatedAt},
            ${receipt.receiptSha256}
          )
          ON CONFLICT (tenant_id, owner_actor_id, trigger_id, scheduled_for)
          DO NOTHING
          RETURNING id
        `;
        if (!inserted[0]) continue;
        const updated = await sql`
          UPDATE omni_workflow_triggers
          SET shadow_next_due_at = ${receipt.nextDueAt || null},
              shadow_occurrence_count = ${receipt.occurrenceCount},
              shadow_evaluated_at = ${receipt.evaluatedAt},
              updated_at = ${receipt.evaluatedAt}
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id = ${actorId}
            AND id = ${trigger.id}
            AND shadow_next_due_at = ${currentNextDueAt}
          RETURNING id
        `;
        if (!updated[0]) {
          throw new Error("Scheduled workflow shadow cursor changed during its claim.");
        }
        await appendWorkflowScheduleShadowEvent(
          receipt,
          input.executionScope,
          sql,
        );
        receipts.push(receipt);
      }
      return receipts;
    }) as WorkflowScheduleShadowReceiptV1[];
  });
}

export async function dispatchWorkflowTrigger(input: DispatchWorkflowTriggerInput) {
  const trigger = await getWorkflowTriggerForDispatch(input.triggerId);
  if (!trigger || trigger.triggerKind !== "webhook") {
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
  const deliveryExecutionScope = createTriggerDeliveryExecutionScope(
    trigger,
    delivery.deliveryKey,
  );

  if (trigger.status !== "active") {
    const saved = await saveWorkflowTriggerEvent(createTriggerEvent({
      tenantId: trigger.tenantId,
      trigger,
      status: "rejected",
      eventIdentity: delivery.deliveryKey,
      signatureVerified: verification.verified,
      signatureDigest: delivery.signatureDigest,
      payload: rejectedPayload,
      headers,
      eventType,
      error: "Trigger is paused.",
    }), deliveryExecutionScope);
    if (saved.mutated) {
      await incrementTriggerCounters(
        trigger.id,
        { failed: true },
        trigger.tenantId,
        deliveryExecutionScope,
        `${saved.event.id}:rejected`,
      );
    }
    return {
      trigger,
      event: saved.event,
      workflow: null,
      queueJob: null,
      replayed: !saved.mutated,
    };
  }

  if (!verification.verified) {
    const saved = await saveWorkflowTriggerEvent(createTriggerEvent({
      tenantId: trigger.tenantId,
      trigger,
      status: "rejected",
      eventIdentity: delivery.deliveryKey,
      signatureVerified: false,
      signatureDigest: delivery.signatureDigest,
      payload: rejectedPayload,
      headers,
      eventType,
      error: verification.error || "Signature verification failed.",
    }), deliveryExecutionScope);
    if (saved.mutated) {
      await incrementTriggerCounters(
        trigger.id,
        { failed: true },
        trigger.tenantId,
        deliveryExecutionScope,
        `${saved.event.id}:rejected`,
      );
    }
    return {
      trigger,
      event: saved.event,
      workflow: null,
      queueJob: null,
      replayed: !saved.mutated,
    };
  }

  if (trigger.authMode === "none" && isProductionRuntime()) {
    const saved = await saveWorkflowTriggerEvent(createTriggerEvent({
      tenantId: trigger.tenantId,
      trigger,
      status: "rejected",
      eventIdentity: delivery.deliveryKey,
      signatureVerified: false,
      signatureDigest: delivery.signatureDigest,
      payload: rejectedPayload,
      headers,
      eventType,
      error: "Unauthenticated workflow triggers are disabled in production.",
    }), deliveryExecutionScope);
    if (saved.mutated) {
      await incrementTriggerCounters(
        trigger.id,
        { failed: true },
        trigger.tenantId,
        deliveryExecutionScope,
        `${saved.event.id}:rejected`,
      );
    }
    return {
      trigger,
      event: saved.event,
      workflow: null,
      queueJob: null,
      replayed: !saved.mutated,
    };
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
  }), deliveryExecutionScope);
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
      executionAuthority: {
        executionScope: deliveryExecutionScope,
        requesterRole: "system",
      },
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
    const saved = await saveWorkflowTriggerEvent({
      ...claim.event,
      status: "enqueued",
      workflowRunId: workflow.run.id,
      queueJobId: queueJob.id,
    }, deliveryExecutionScope);
    if (saved.mutated) {
      await incrementTriggerCounters(
        trigger.id,
        { triggered: true },
        tenantId,
        deliveryExecutionScope,
        `${saved.event.id}:enqueued`,
      );
    }
    return {
      trigger,
      event: saved.event,
      workflow,
      queueJob,
      replayed: false,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trigger dispatch failed.";
    const saved = await saveWorkflowTriggerEvent({
      ...claim.event,
      status: "failed",
      error: message,
    }, deliveryExecutionScope);
    if (saved.mutated) {
      await incrementTriggerCounters(
        trigger.id,
        { failed: true },
        tenantId,
        deliveryExecutionScope,
        `${saved.event.id}:failed`,
      );
    }
    return {
      trigger,
      event: saved.event,
      workflow: null,
      queueJob: null,
      replayed: false,
    };
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

async function saveWorkflowTrigger(
  record: WorkflowTriggerRecord,
  executionScope: ExecutionScope | undefined,
  idempotencyKey: string,
): Promise<WorkflowTriggerRecord> {
  if (executionScope) {
    assertExecutionScopeTenant(executionScope, record.tenantId);
  }
  if (hasDatabaseUrl()) {
    if (!executionScope) {
      throw new Error("Workflow trigger persistence requires bound execution authority.");
    }
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        INSERT INTO omni_workflow_triggers (
          id, tenant_id, trigger_kind, owner_actor_id,
          name, source, status, auth_mode, secret_env_var, goal_template,
          workflow_mode, require_approval, metadata, trigger_count, failure_count,
          last_triggered_at, schedule_config, schedule_config_sha256,
          agent_identity_pin_sha256, policy_pin_sha256,
          procedure_snapshot_sha256, reviewed_snapshot_sha256,
          occurrence_budget_sha256, next_due_at, shadow_next_due_at,
          occurrence_count, consecutive_failure_count, failure_limit,
          circuit_state, paused_reason, last_failure_at, circuit_opened_at,
          shadow_occurrence_count, shadow_evaluated_at,
          created_at, updated_at
        )
        VALUES (
          ${record.id}, ${record.tenantId}, ${record.triggerKind},
          ${record.ownerActorId || null}, ${record.name}, ${record.source}, ${record.status},
          ${record.authMode}, ${record.secretEnvVar || null}, ${record.goalTemplate},
          ${record.workflowMode}, ${record.requireApproval},
          ${record.metadata || {}}::jsonb,
          ${record.triggerCount}, ${record.failureCount}, ${record.lastTriggeredAt || null},
          ${record.schedule?.config || null}::jsonb,
          ${record.schedule?.config.configSha256 || null},
          ${record.schedule?.config.agentIdentityPin.pinSha256 || null},
          ${record.schedule?.config.policyPinSha256 || null},
          ${record.schedule?.config.procedurePin.snapshotSha256 || null},
          ${record.schedule?.config.procedurePin.reviewedSnapshotSha256 || null},
          ${record.schedule
            ? canonicalJsonSha256(record.schedule.config.occurrenceBudget)
            : null},
          ${record.schedule?.state.nextDueAt || null},
          ${record.schedule?.state.shadowNextDueAt || null},
          ${record.schedule?.state.occurrenceCount || 0},
          ${record.schedule?.state.consecutiveFailureCount || 0},
          ${record.schedule?.config.failureLimit || 3},
          ${record.schedule?.state.circuitState || "closed"},
          ${record.schedule?.state.pausedReason || null},
          ${record.schedule?.state.lastFailureAt || null},
          ${record.schedule?.state.circuitOpenedAt || null},
          ${record.schedule?.state.shadowOccurrenceCount || 0},
          ${record.schedule?.state.shadowEvaluatedAt || null},
          ${record.createdAt}, ${record.updatedAt}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `;
      if (rows[0]) {
        const saved = workflowTriggerFromRow(rows[0]);
        await appendWorkflowTriggerCreatedEvent(
          saved,
          executionScope,
          idempotencyKey,
          sql,
        );
        return saved;
      }
      const existingRows = await sql`
        SELECT *
        FROM omni_workflow_triggers
        WHERE id = ${record.id}
          AND tenant_id = ${record.tenantId}
        LIMIT 1
      `;
      if (!existingRows[0]) {
        throw new Error("Workflow trigger idempotent create could not be resolved.");
      }
      const existing = workflowTriggerFromRow(existingRows[0]);
      if (workflowTriggerConfigurationSha256(existing) !== workflowTriggerConfigurationSha256(record)) {
        throw new Error("Workflow trigger idempotency key is already bound to another configuration.");
      }
      return existing;
    }) as WorkflowTriggerRecord;
  }

  let created = false;
  let saved = record;
  await mutateTriggerLedger((ledger) => {
    const existing = ledger.triggers.find((trigger) => trigger.id === record.id);
    if (existing) {
      if (workflowTriggerConfigurationSha256(existing) !== workflowTriggerConfigurationSha256(record)) {
        throw new Error("Workflow trigger idempotency key is already bound to another configuration.");
      }
      saved = existing;
      return ledger;
    }
    created = true;
    ledger.triggers = [record, ...ledger.triggers];
    return trimTriggerLedger(ledger);
  });
  if (created && executionScope) {
    await appendWorkflowTriggerCreatedEvent(
      saved,
      executionScope,
      idempotencyKey,
    );
  }
  return saved;
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
  return trigger
    ? normalizeLegacyWorkflowTrigger({ ...trigger, tenantId: triggerTenantId(trigger) })
    : null;
}

async function claimWorkflowTriggerDelivery(
  record: WorkflowTriggerEventRecord,
  executionScope: ExecutionScope,
): Promise<{ created: boolean; event: WorkflowTriggerEventRecord }> {
  assertExecutionScopeTenant(executionScope, record.tenantId);
  if (!record.deliveryKey) {
    const saved = await saveWorkflowTriggerEvent(record, executionScope);
    return { created: saved.mutated, event: saved.event };
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
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
          ${record.payload || {}}::jsonb,
          ${record.headers || {}}::jsonb,
          ${record.error || null}, ${record.receivedAt}
        )
        ON CONFLICT (tenant_id, trigger_id, delivery_key)
        WHERE delivery_key IS NOT NULL
        DO NOTHING
        RETURNING *
      `;
      if (rows[0]) {
        const event = workflowTriggerEventFromRow(rows[0]);
        await appendWorkflowTriggerDeliveryEvent(event, executionScope, sql);
        return { created: true, event };
      }
      const existing = await sql`
        SELECT *
        FROM omni_workflow_trigger_events
        WHERE tenant_id = ${record.tenantId}
          AND trigger_id = ${record.triggerId}
          AND delivery_key = ${record.deliveryKey}
        LIMIT 1
        FOR UPDATE
      `;
      if (!existing[0]) {
        throw new Error("Workflow trigger delivery claim could not be resolved.");
      }
      const reclaimed = await sql`
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
        const event = workflowTriggerEventFromRow(reclaimed[0]);
        await appendWorkflowTriggerDeliveryEvent(event, executionScope, sql);
        return { created: true, event };
      }
      return { created: false, event: workflowTriggerEventFromRow(existing[0]) };
    }) as { created: boolean; event: WorkflowTriggerEventRecord };
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
  if (created) {
    await appendWorkflowTriggerDeliveryEvent(claimed, executionScope);
  }
  return { created, event: claimed };
}

async function saveWorkflowTriggerEvent(
  record: WorkflowTriggerEventRecord,
  executionScope: ExecutionScope,
): Promise<{ event: WorkflowTriggerEventRecord; mutated: boolean }> {
  const tenantId = normalizeTenantId(record.tenantId);
  assertExecutionScopeTenant(executionScope, tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const existingRows = await sql`
        SELECT *
        FROM omni_workflow_trigger_events
        WHERE id = ${record.id}
          AND tenant_id = ${tenantId}
        LIMIT 1
        FOR UPDATE
      `;
      if (
        existingRows[0] &&
        workflowTriggerEventStateSha256(workflowTriggerEventFromRow(existingRows[0])) ===
          workflowTriggerEventStateSha256(record)
      ) {
        return {
          event: workflowTriggerEventFromRow(existingRows[0]),
          mutated: false,
        };
      }
      const rows = await sql`
        INSERT INTO omni_workflow_trigger_events (
          id, tenant_id, trigger_id, delivery_key, signature_digest,
          status, source, event_type, signature_verified,
          workflow_run_id, queue_job_id, payload, headers, error, received_at
        )
        VALUES (
          ${record.id}, ${tenantId}, ${record.triggerId},
          ${record.deliveryKey || null}, ${record.signatureDigest || null},
          ${record.status}, ${record.source},
          ${record.eventType || null}, ${record.signatureVerified},
          ${record.workflowRunId || null}, ${record.queueJobId || null},
          ${record.payload || {}}::jsonb,
          ${record.headers || {}}::jsonb,
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
        RETURNING *
      `;
      const event = workflowTriggerEventFromRow(rows[0]);
      await appendWorkflowTriggerDeliveryEvent(event, executionScope, sql);
      return { event, mutated: true };
    }) as { event: WorkflowTriggerEventRecord; mutated: boolean };
  }

  let mutated = false;
  let saved = record;
  await mutateTriggerLedger((ledger) => {
    const existing = ledger.events.find((event) => event.id === record.id);
    if (
      existing &&
      workflowTriggerEventStateSha256(existing) === workflowTriggerEventStateSha256(record)
    ) {
      saved = existing;
      return ledger;
    }
    mutated = true;
    ledger.events = [record, ...ledger.events.filter((event) => event.id !== record.id)];
    return trimTriggerLedger(ledger);
  });
  if (mutated) {
    await appendWorkflowTriggerDeliveryEvent(saved, executionScope);
  }
  return { event: saved, mutated };
}

async function incrementTriggerCounters(
  triggerId: string,
  input: { triggered?: boolean; failed?: boolean },
  tenantId: string,
  executionScope: ExecutionScope,
  mutationId: string,
): Promise<WorkflowTriggerRecord | null> {
  const normalizedTenantId = normalizeTenantId(tenantId);
  assertExecutionScopeTenant(executionScope, normalizedTenantId);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
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
      if (!rows[0]) return null;
      const updated = workflowTriggerFromRow(rows[0]);
      await appendWorkflowTriggerCounterEvent({
        trigger: updated,
        input,
        executionScope,
        mutationId,
        sql,
      });
      return updated;
    }) as WorkflowTriggerRecord | null;
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
  if (updated) {
    await appendWorkflowTriggerCounterEvent({
      trigger: updated,
      input,
      executionScope,
      mutationId,
    });
  }
  return updated;
}

async function appendWorkflowTriggerCreatedEvent(
  trigger: WorkflowTriggerRecord,
  executionScope: ExecutionScope,
  idempotencyKey: string,
  sql?: ReturnType<typeof getSql>,
) {
  const idempotencyKeySha256 = canonicalJsonSha256({
    tenantId: trigger.tenantId,
    idempotencyKey,
  });
  await appendScopedDomainEvent({
    id: `workflow-trigger:${canonicalJsonSha256({
      tenantId: trigger.tenantId,
      type: "created",
      triggerId: trigger.id,
      idempotencyKeySha256,
    })}`,
    streamId: `workflow-trigger:${trigger.id}`,
    type: "workflow.trigger.created",
    executionScope: deriveExecutionScope(executionScope, {
      causationId: `workflow-trigger:${trigger.id}:created`,
      purpose: "workflow.trigger.create",
    }),
    payload: {
      schemaVersion: 1,
      triggerId: trigger.id,
      triggerKind: trigger.triggerKind,
      status: trigger.status,
      authMode: trigger.authMode,
      workflowMode: trigger.workflowMode,
      requireApproval: trigger.requireApproval,
      ownerActorIdSha256: trigger.ownerActorId
        ? canonicalJsonSha256({ ownerActorId: trigger.ownerActorId })
        : null,
      scheduleConfigurationSha256:
        trigger.schedule?.config.configSha256 || null,
      agentIdentityPinSha256:
        trigger.schedule?.config.agentIdentityPin.pinSha256 || null,
      policyPinSha256: trigger.schedule?.config.policyPinSha256 || null,
      procedureSnapshotSha256:
        trigger.schedule?.config.procedurePin.snapshotSha256 || null,
      reviewedSnapshotSha256:
        trigger.schedule?.config.procedurePin.reviewedSnapshotSha256 || null,
      occurrenceBudgetSha256: trigger.schedule
        ? canonicalJsonSha256(trigger.schedule.config.occurrenceBudget)
        : null,
      configurationSha256: workflowTriggerConfigurationSha256(trigger),
      idempotencyKeySha256,
    },
  }, sql ? { sql } : {});
}

async function appendWorkflowTriggerDeliveryEvent(
  event: WorkflowTriggerEventRecord,
  executionScope: ExecutionScope,
  sql?: ReturnType<typeof getSql>,
) {
  const stateSha256 = workflowTriggerEventStateSha256(event);
  const idempotencyKeySha256 = canonicalJsonSha256({
    tenantId: event.tenantId,
    triggerId: event.triggerId,
    eventId: event.id,
    status: event.status,
    receivedAt: event.receivedAt,
    stateSha256,
  });
  await appendScopedDomainEvent({
    id: `workflow-trigger-delivery:${idempotencyKeySha256}`,
    streamId: `workflow-trigger:${event.triggerId}`,
    type: `workflow.trigger.delivery.${event.status}`,
    executionScope: deriveExecutionScope(executionScope, {
      causationId: `workflow-trigger-event:${event.id}:${event.status}`,
      purpose: "workflow.trigger.delivery.persist",
    }),
    payload: {
      schemaVersion: 1,
      triggerId: event.triggerId,
      triggerEventId: event.id,
      status: event.status,
      source: event.source,
      eventType: event.eventType || null,
      signatureVerified: event.signatureVerified,
      deliveryKeySha256: event.deliveryKey
        ? canonicalJsonSha256({ deliveryKey: event.deliveryKey })
        : null,
      signatureDigest: event.signatureDigest || null,
      workflowRunId: event.workflowRunId || null,
      queueJobId: event.queueJobId || null,
      payloadSha256: canonicalJsonSha256(event.payload),
      headersSha256: canonicalJsonSha256(event.headers),
      errorSha256: event.error
        ? canonicalJsonSha256({ error: event.error })
        : null,
      receivedAt: event.receivedAt,
      stateSha256,
      idempotencyKeySha256,
    },
  }, sql ? { sql } : {});
}

async function appendWorkflowTriggerCounterEvent({
  trigger,
  input,
  executionScope,
  mutationId,
  sql,
}: {
  trigger: WorkflowTriggerRecord;
  input: { triggered?: boolean; failed?: boolean };
  executionScope: ExecutionScope;
  mutationId: string;
  sql?: ReturnType<typeof getSql>;
}) {
  const idempotencyKeySha256 = canonicalJsonSha256({
    tenantId: trigger.tenantId,
    triggerId: trigger.id,
    mutationId,
  });
  await appendScopedDomainEvent({
    id: `workflow-trigger-counter:${idempotencyKeySha256}`,
    streamId: `workflow-trigger:${trigger.id}`,
    type: "workflow.trigger.counter.updated",
    executionScope: deriveExecutionScope(executionScope, {
      causationId: `workflow-trigger:${trigger.id}:counter:${idempotencyKeySha256}`,
      purpose: "workflow.trigger.counter.persist",
    }),
    payload: {
      schemaVersion: 1,
      triggerId: trigger.id,
      triggered: Boolean(input.triggered),
      failed: Boolean(input.failed),
      triggerCount: trigger.triggerCount,
      failureCount: trigger.failureCount,
      lastTriggeredAt: trigger.lastTriggeredAt || null,
      idempotencyKeySha256,
    },
  }, sql ? { sql } : {});
}

async function appendWorkflowScheduleShadowEvent(
  receipt: WorkflowScheduleShadowReceiptV1,
  executionScope: ExecutionScope,
  sql: ReturnType<typeof getSql>,
) {
  await appendScopedDomainEvent({
    id: `workflow-schedule-shadow:${receipt.receiptSha256}`,
    streamId: `workflow-trigger:${receipt.triggerId}`,
    type: "workflow.schedule.shadow.evaluated",
    executionScope: deriveExecutionScope(executionScope, {
      causationId: `workflow-schedule-shadow:${receipt.id}`,
      purpose: "workflow.schedule.shadow.evaluate",
    }),
    payload: {
      schemaVersion: 1,
      triggerId: receipt.triggerId,
      ownerActorIdSha256: canonicalJsonSha256({
        ownerActorId: receipt.ownerActorId,
      }),
      scheduledFor: receipt.scheduledFor,
      evaluatedThrough: receipt.evaluatedThrough,
      outcome: receipt.outcome,
      wouldCreateRun: receipt.wouldCreateRun,
      occurrencesConsumed: receipt.occurrencesConsumed,
      occurrenceCount: receipt.occurrenceCount,
      nextDueAt: receipt.nextDueAt || null,
      configurationSha256: receipt.configurationSha256,
      agentIdentityPinSha256: receipt.agentIdentityPinSha256,
      policyPinSha256: receipt.policyPinSha256,
      procedureSnapshotSha256: receipt.procedureSnapshotSha256,
      reviewedSnapshotSha256: receipt.reviewedSnapshotSha256,
      occurrenceBudgetSha256: receipt.occurrenceBudgetSha256,
      evaluatedAt: receipt.evaluatedAt,
      receiptSha256: receipt.receiptSha256,
      executionAuthorityGranted: false,
      workflowRunCreated: false,
    },
  }, { sql });
}

function workflowTriggerConfigurationSha256(trigger: WorkflowTriggerRecord) {
  return canonicalJsonSha256({
    tenantId: trigger.tenantId,
    triggerId: trigger.id,
    triggerKind: trigger.triggerKind,
    ownerActorId: trigger.ownerActorId || null,
    name: trigger.name,
    source: trigger.source,
    status: trigger.status,
    authMode: trigger.authMode,
    secretEnvVar: trigger.secretEnvVar || null,
    goalTemplate: trigger.goalTemplate,
    workflowMode: trigger.workflowMode,
    requireApproval: trigger.requireApproval,
    metadata: trigger.metadata,
    scheduleConfigSha256: trigger.schedule?.config.configSha256 || null,
  });
}

function workflowTriggerEventStateSha256(event: WorkflowTriggerEventRecord) {
  return canonicalJsonSha256({
    tenantId: normalizeTenantId(event.tenantId),
    triggerEventId: event.id,
    triggerId: event.triggerId,
    deliveryKey: event.deliveryKey || null,
    signatureDigest: event.signatureDigest || null,
    status: event.status,
    source: event.source,
    eventType: event.eventType || null,
    signatureVerified: event.signatureVerified,
    workflowRunId: event.workflowRunId || null,
    queueJobId: event.queueJobId || null,
    payload: event.payload,
    headers: event.headers,
    error: event.error || null,
  });
}

function createTriggerDeliveryExecutionScope(
  trigger: WorkflowTriggerRecord,
  deliveryKey: string,
) {
  const deliveryScopeId = canonicalJsonSha256({
    tenantId: trigger.tenantId,
    triggerId: trigger.id,
    deliveryKey,
  });
  return createExecutionScope({
    tenantId: trigger.tenantId,
    initiatingActorId: null,
    executingPrincipalType: "system",
    executingPrincipalId: `workflow-trigger:${trigger.id}`,
    correlationId: `workflow-trigger:${deliveryScopeId}`,
    causationId: `trigger-delivery:${deliveryScopeId}`,
    purpose: "workflow.trigger.dispatch",
  });
}

function deterministicTriggerId(tenantId: string, idempotencyKey: string) {
  return `trigger_${canonicalJsonSha256({ tenantId, idempotencyKey }).slice(0, 40)}`;
}

function deterministicTriggerEventId(
  tenantId: string,
  triggerId: string,
  eventIdentity: string,
  status: WorkflowTriggerEventStatus,
) {
  return `trigger_event_${canonicalJsonSha256({
    tenantId,
    triggerId,
    eventIdentity,
    status,
  }).slice(0, 40)}`;
}

function createTriggerEvent({
  tenantId,
  trigger,
  status,
  eventIdentity,
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
  eventIdentity?: string;
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
  const normalizedTenantId = normalizeTenantId(tenantId);
  const stableEventIdentity = eventIdentity || deliveryKey;
  return {
    id: stableEventIdentity
      ? deterministicTriggerEventId(
          normalizedTenantId,
          trigger.id,
          stableEventIdentity,
          status,
        )
      : randomUUID(),
    tenantId: normalizedTenantId,
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

function requiredScheduleOwner(
  executionScope: ExecutionScope | undefined,
  tenantId: string,
) {
  if (!executionScope) {
    throw new Error("Scheduled workflow triggers require bound actor authority.");
  }
  assertExecutionScopeTenant(executionScope, tenantId);
  const actorId = executionScope.initiatingActorId;
  if (!actorId) {
    throw new Error("Scheduled workflow triggers require an initiating actor.");
  }
  if (
    executionScope.executingPrincipalType === "user" &&
    executionScope.executingPrincipalId !== actorId
  ) {
    throw new Error("Scheduled workflow trigger actor authority is inconsistent.");
  }
  return requiredActorId(actorId);
}

function buildWorkflowSchedule(
  value: CreateScheduleWorkflowTriggerInput["schedule"],
  context: { tenantId: string; ownerActorId: string; now: string },
) {
  const timezone = normalizeTimezone(value.timezone);
  const startsAt = normalizeScheduleTimestamp(value.startsAt, "startsAt");
  const endsAt = value.endsAt
    ? normalizeScheduleTimestamp(value.endsAt, "endsAt")
    : undefined;
  if (endsAt && endsAt < startsAt) {
    throw new Error("Scheduled workflow end must not precede its start.");
  }
  const reviewedAt = normalizeScheduleTimestamp(
    value.procedurePin.reviewedAt,
    "reviewedAt",
  );
  if (Date.parse(reviewedAt) > Date.parse(context.now) + 60_000) {
    throw new Error("Scheduled workflow review time cannot be in the future.");
  }
  const procedurePin = scheduleProcedurePinSchema.parse({
    ...value.procedurePin,
    reviewedAt,
  });
  const agentIdentityPin = parseAgentRunIdentityPinV1(value.agentIdentityPin);
  if (
    agentIdentityPin.tenantId !== context.tenantId ||
    agentIdentityPin.actorId !== context.ownerActorId
  ) {
    throw new Error("Scheduled workflow agent identity is outside the actor scope.");
  }
  const occurrenceBudget = scheduleOccurrenceBudgetSchema.parse(
    value.occurrenceBudget,
  );
  const parsedRule = parseBoundedScheduleRrule(
    value.rrule,
    timezone,
    startsAt,
  );
  const rrule = canonicalScheduleRrule(parsedRule);
  const maxOccurrences = boundedInteger(
    value.maxOccurrences,
    "maxOccurrences",
    1,
    scheduleEvaluationLimit,
  );
  const failureLimit = boundedInteger(
    value.failureLimit ?? 3,
    "failureLimit",
    1,
    20,
  );
  if (value.missedPolicy !== "skip" && value.missedPolicy !== "run_once") {
    throw new Error("Scheduled workflow missed policy is invalid.");
  }
  const body = {
    schemaVersion: 1 as const,
    timezone,
    rrule,
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    maxOccurrences,
    missedPolicy: value.missedPolicy,
    procedurePin,
    agentIdentityPin,
    policyPinSha256: canonicalJsonSha256(agentIdentityPin.policyPins),
    occurrenceBudget,
    failureLimit,
  };
  const config = parseWorkflowScheduleConfig({
    ...body,
    configSha256: canonicalJsonSha256(body),
  });
  const nextDueAt = nextWorkflowScheduleOccurrence({
    config,
    after: new Date(Date.parse(startsAt) - 1).toISOString(),
    completedOccurrences: 0,
  });
  if (!nextDueAt) {
    throw new Error("Scheduled workflow has no occurrence inside its bounded window.");
  }
  return Object.freeze({
    config,
    state: Object.freeze({
      nextDueAt,
      occurrenceCount: 0,
      consecutiveFailureCount: 0,
      circuitState: "closed" as const,
      shadowNextDueAt: nextDueAt,
      shadowOccurrenceCount: 0,
    }),
  });
}

function parseWorkflowScheduleConfig(value: unknown): WorkflowScheduleConfigV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Scheduled workflow configuration is missing.");
  }
  const candidate = value as Record<string, unknown>;
  const agentIdentityPin = parseAgentRunIdentityPinV1(candidate.agentIdentityPin);
  const procedurePin = scheduleProcedurePinSchema.parse(candidate.procedurePin);
  const occurrenceBudget = scheduleOccurrenceBudgetSchema.parse(
    candidate.occurrenceBudget,
  );
  const timezone = normalizeTimezone(String(candidate.timezone || ""));
  const startsAt = normalizeScheduleTimestamp(
    String(candidate.startsAt || ""),
    "startsAt",
  );
  const endsAt = candidate.endsAt
    ? normalizeScheduleTimestamp(String(candidate.endsAt), "endsAt")
    : undefined;
  if (endsAt && endsAt < startsAt) {
    throw new Error("Scheduled workflow end must not precede its start.");
  }
  const rule = parseBoundedScheduleRrule(
    String(candidate.rrule || ""),
    timezone,
    startsAt,
  );
  const body = {
    schemaVersion: 1 as const,
    timezone,
    rrule: canonicalScheduleRrule(rule),
    startsAt,
    ...(endsAt ? { endsAt } : {}),
    maxOccurrences: boundedInteger(
      Number(candidate.maxOccurrences),
      "maxOccurrences",
      1,
      scheduleEvaluationLimit,
    ),
    missedPolicy: normalizeMissedPolicy(candidate.missedPolicy),
    procedurePin,
    agentIdentityPin,
    policyPinSha256: String(candidate.policyPinSha256 || ""),
    occurrenceBudget,
    failureLimit: boundedInteger(
      Number(candidate.failureLimit),
      "failureLimit",
      1,
      20,
    ),
  };
  const configSha256 = String(candidate.configSha256 || "");
  if (
    candidate.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(configSha256) ||
    body.policyPinSha256 !== canonicalJsonSha256(agentIdentityPin.policyPins) ||
    canonicalJsonSha256(body) !== configSha256
  ) {
    throw new Error("Scheduled workflow configuration digest is invalid.");
  }
  return Object.freeze({ ...body, configSha256 });
}

function parseBoundedScheduleRrule(
  value: string,
  timezone: string,
  startsAt: string,
): ParsedScheduleRrule {
  const raw = value.trim().toUpperCase().replace(/^RRULE:/, "");
  if (!raw || raw.length > 512) {
    throw new Error("Scheduled workflow RRULE must contain at most 512 characters.");
  }
  const entries = raw.split(";").map((part) => part.split("="));
  if (entries.some((entry) => entry.length !== 2 || !entry[0] || !entry[1])) {
    throw new Error("Scheduled workflow RRULE is malformed.");
  }
  const pairs = Object.fromEntries(entries) as Record<string, string>;
  if (Object.keys(pairs).length !== entries.length) {
    throw new Error("Scheduled workflow RRULE keys must be unique.");
  }
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "BYHOUR", "BYMINUTE"]);
  if (Object.keys(pairs).some((key) => !allowed.has(key))) {
    throw new Error("Scheduled workflow RRULE contains an unsupported clause.");
  }
  const localStart = localDateTimeParts(Date.parse(startsAt), timezone);
  const byDay = pairs.BYDAY
    ? [...new Set(pairs.BYDAY.split(","))]
    : [];
  const parsed = scheduleRruleSchema.parse({
    freq: pairs.FREQ,
    interval: pairs.INTERVAL ? Number(pairs.INTERVAL) : 1,
    byDay,
    byHour: pairs.BYHOUR ? Number(pairs.BYHOUR) : localStart.hour,
    byMinute: pairs.BYMINUTE ? Number(pairs.BYMINUTE) : localStart.minute,
  });
  if (parsed.freq === "MONTHLY" && parsed.byDay.length > 0) {
    throw new Error("Monthly scheduled workflows use the start day, not BYDAY.");
  }
  return parsed;
}

function canonicalScheduleRrule(rule: ParsedScheduleRrule) {
  return [
    `FREQ=${rule.freq}`,
    `INTERVAL=${rule.interval}`,
    ...(rule.byDay.length ? [`BYDAY=${rule.byDay.join(",")}`] : []),
    `BYHOUR=${rule.byHour}`,
    `BYMINUTE=${rule.byMinute}`,
  ].join(";");
}

type LocalDate = { year: number; month: number; day: number };
type LocalDateTime = LocalDate & { hour: number; minute: number };

const scheduleFormatterCache = new Map<string, Intl.DateTimeFormat>();

function localDateTimeParts(timestampMs: number, timezone: string): LocalDateTime {
  let formatter = scheduleFormatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    scheduleFormatterCache.set(timezone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(timestampMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
  };
}

function resolveZonedLocalDateTime(
  local: LocalDateTime,
  timezone: string,
) {
  for (let shiftedMinutes = 0; shiftedMinutes <= 180; shiftedMinutes += 1) {
    const target = addLocalMinutes(local, shiftedMinutes);
    const targetSerial = localDateTimeSerial(target);
    const candidates = new Set<number>();
    for (const sampleOffsetHours of [-36, -12, 0, 12, 36]) {
      const sample = targetSerial + sampleOffsetHours * 3_600_000;
      const sampleLocal = localDateTimeParts(sample, timezone);
      const timezoneOffset = localDateTimeSerial(sampleLocal) - sample;
      const candidate = targetSerial - timezoneOffset;
      const actual = localDateTimeParts(candidate, timezone);
      if (sameLocalDateTime(actual, target)) candidates.add(candidate);
    }
    if (candidates.size > 0) return Math.min(...candidates);
  }
  return undefined;
}

function localDateMatchesRule(
  date: LocalDate,
  start: LocalDateTime,
  rule: ParsedScheduleRrule,
) {
  const dayDiff = localDaySerial(date) - localDaySerial(start);
  if (dayDiff < 0) return false;
  const weekday = weekdayCode(date);
  if (rule.byDay.length && !rule.byDay.includes(weekday)) return false;
  if (rule.freq === "DAILY") return dayDiff % rule.interval === 0;
  if (rule.freq === "WEEKLY") {
    const startWeekday = weekdayNumber(start);
    const weekIndex = Math.floor((dayDiff + startWeekday) / 7);
    const selectedDays = rule.byDay.length ? rule.byDay : [weekdayCode(start)];
    return weekIndex % rule.interval === 0 && selectedDays.includes(weekday);
  }
  const monthDiff = (date.year - start.year) * 12 + date.month - start.month;
  return monthDiff >= 0 && monthDiff % rule.interval === 0 && date.day === start.day;
}

function addLocalDays(date: LocalDate, amount: number): LocalDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function addLocalMinutes(local: LocalDateTime, amount: number): LocalDateTime {
  const shifted = new Date(localDateTimeSerial(local) + amount * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function localDaySerial(date: LocalDate) {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function localDateTimeSerial(local: LocalDateTime) {
  return Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
  );
}

function weekdayNumber(date: LocalDate) {
  return (new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay() + 6) % 7;
}

function weekdayCode(date: LocalDate) {
  return (["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const)[
    weekdayNumber(date)
  ];
}

function sameLocalDateTime(left: LocalDateTime, right: LocalDateTime) {
  return left.year === right.year && left.month === right.month &&
    left.day === right.day && left.hour === right.hour &&
    left.minute === right.minute;
}

function normalizeTimezone(value: string) {
  const timezone = value.trim();
  if (!timezone || timezone.length > 120) {
    throw new Error("Scheduled workflow timezone is invalid.");
  }
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone })
      .resolvedOptions().timeZone;
  } catch {
    throw new Error("Scheduled workflow timezone is invalid.");
  }
}

function normalizeScheduleTimestamp(value: string, field: string) {
  if (!/(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value)) {
    throw new Error(`Scheduled workflow ${field} must include an explicit offset.`);
  }
  const timestamp = requireTimestamp(value, `schedule ${field}`);
  const date = new Date(timestamp);
  if (date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0) {
    throw new Error(`Scheduled workflow ${field} must use minute precision.`);
  }
  return date.toISOString();
}

function requireTimestamp(value: string, label: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error(`${label} is invalid.`);
  return timestamp;
}

function boundedInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Scheduled workflow ${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function normalizeMissedPolicy(value: unknown): WorkflowScheduleMissedPolicy {
  if (value === "skip" || value === "run_once") return value;
  throw new Error("Scheduled workflow missed policy is invalid.");
}

function requiredActorId(value: string) {
  const actorId = value.trim();
  if (!actorId || actorId.length > 320 || actorId.includes("\0")) {
    throw new Error("Scheduled workflow actor id is invalid.");
  }
  return actorId;
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
  const triggerKind = normalizeTriggerKind(row.trigger_kind);
  const scheduleConfig = triggerKind === "schedule"
    ? parseWorkflowScheduleConfig(row.schedule_config)
    : undefined;
  const record: WorkflowTriggerRecord = {
    id: String(row.id),
    tenantId: normalizeTenantId(row.tenant_id ? String(row.tenant_id) : undefined),
    triggerKind,
    ownerActorId: row.owner_actor_id ? String(row.owner_actor_id) : undefined,
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
    schedule: scheduleConfig
      ? {
          config: scheduleConfig,
          state: {
            nextDueAt: row.next_due_at ? normalizeDate(row.next_due_at) : undefined,
            occurrenceCount: Number(row.occurrence_count || 0),
            consecutiveFailureCount: Number(row.consecutive_failure_count || 0),
            circuitState: normalizeCircuitState(row.circuit_state),
            pausedReason: row.paused_reason ? String(row.paused_reason) : undefined,
            lastFailureAt: row.last_failure_at
              ? normalizeDate(row.last_failure_at)
              : undefined,
            circuitOpenedAt: row.circuit_opened_at
              ? normalizeDate(row.circuit_opened_at)
              : undefined,
            shadowNextDueAt: row.shadow_next_due_at
              ? normalizeDate(row.shadow_next_due_at)
              : undefined,
            shadowOccurrenceCount: Number(row.shadow_occurrence_count || 0),
            shadowEvaluatedAt: row.shadow_evaluated_at
              ? normalizeDate(row.shadow_evaluated_at)
              : undefined,
          },
        }
      : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
  return assertWorkflowTriggerRecord(record);
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

function normalizeTriggerKind(value: unknown): WorkflowTriggerKind {
  return String(value || "webhook") === "schedule" ? "schedule" : "webhook";
}

function normalizeCircuitState(
  value: unknown,
): NonNullable<WorkflowTriggerRecord["schedule"]>["state"]["circuitState"] {
  const state = String(value || "closed");
  return state === "open" || state === "half_open" ? state : "closed";
}

function normalizeLegacyWorkflowTrigger(
  trigger: WorkflowTriggerRecord,
): WorkflowTriggerRecord {
  return {
    ...trigger,
    triggerKind: normalizeTriggerKind(trigger.triggerKind),
  };
}

function workflowTriggerVisibleToActor(
  trigger: WorkflowTriggerRecord,
  actorId: string | undefined,
) {
  return trigger.triggerKind === "webhook" ||
    Boolean(actorId && trigger.ownerActorId === actorId);
}

function assertWorkflowTriggerRecord(trigger: WorkflowTriggerRecord) {
  if (trigger.triggerKind === "webhook") {
    if (trigger.schedule || trigger.ownerActorId) {
      throw new Error("Webhook workflow trigger contains schedule authority.");
    }
    return trigger;
  }
  if (!trigger.ownerActorId || !trigger.schedule) {
    throw new Error("Scheduled workflow trigger actor binding is incomplete.");
  }
  if (
    trigger.schedule.config.agentIdentityPin.tenantId !== trigger.tenantId ||
    trigger.schedule.config.agentIdentityPin.actorId !== trigger.ownerActorId
  ) {
    throw new Error("Scheduled workflow trigger identity binding is invalid.");
  }
  return trigger;
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
