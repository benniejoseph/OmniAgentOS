import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  buildAgentRunIdentityPinV1,
  parseAgentRunIdentityPinV1,
  type ResolvedAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import { resolveAgentIdentityForExecution } from "@/lib/agents/identity-store";
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
import { governedToolOperationClass } from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";
import { runBudgetCountersV1Schema } from "@/lib/runs/budgets";
import {
  buildWorkflowProcedureSnapshot,
  listSavedProcedures,
  type WorkflowProcedureSnapshot,
} from "@/lib/workflows/saved-procedures";
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
  WorkflowScheduleOccurrenceFailureCode,
  WorkflowScheduleOccurrenceKind,
  WorkflowScheduleOccurrenceReceiptV1,
  WorkflowScheduleOccurrenceRecord,
  WorkflowScheduleOccurrenceStatus,
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
  replacesTriggerId?: string;
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

export const DEFAULT_READ_ONLY_SCHEDULE_BUDGET = Object.freeze({
  modelTurns: 4,
  tokens: 32_000,
  costMicrousd: 750_000,
  wallTimeMs: 180_000,
  toolCalls: 16,
  browserActions: 0,
  agents: 0,
  fanOut: 0,
  retries: 1,
  replans: 0,
});

const scheduleCreateInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: z.string().trim().min(1).max(120).optional(),
  procedureId: z.string().trim().min(1).max(240),
  agentId: z.string().trim().min(1).max(240),
  timezone: z.string().trim().min(1).max(120),
  rrule: z.string().trim().min(1).max(512),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }).optional(),
  maxOccurrences: z.number().int().min(1).max(scheduleEvaluationLimit).default(365),
  missedPolicy: z.enum(["skip", "run_once"]).default("skip"),
  occurrenceBudget: scheduleOccurrenceBudgetSchema.default(
    DEFAULT_READ_ONLY_SCHEDULE_BUDGET,
  ),
  failureLimit: z.number().int().min(1).max(20).default(3),
  replacesTriggerId: z.string().trim().min(1).max(240).optional(),
}).strict();

export type ReviewedWorkflowScheduleCreateInput = z.input<
  typeof scheduleCreateInputSchema
> & {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
};

export class WorkflowScheduleControlError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "not_schedule"
      | "not_read_only"
      | "immutable_binding_changed"
      | "invalid_state",
  ) {
    super(message);
    this.name = "WorkflowScheduleControlError";
  }
}

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
    replacesTriggerId: triggerKind === "schedule"
      ? normalizeOptional(input.replacesTriggerId)
      : undefined,
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
  options: { tenantId?: string; actorId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const actorId = options.actorId ? requiredActorId(options.actorId) : undefined;
  const boundedLimit = Math.min(Math.max(limit, 1), 200);
  if (hasDatabaseUrl()) {
    const operation = async () => {
      await ensureDatabaseSchema();
      const rows = actorId
        ? await getSql()`
            SELECT event.*
            FROM omni_workflow_trigger_events AS event
            INNER JOIN omni_workflow_triggers AS trigger
              ON trigger.tenant_id = event.tenant_id
             AND trigger.id = event.trigger_id
            WHERE event.tenant_id = ${tenantId}
              AND (
                trigger.owner_actor_id IS NULL
                OR trigger.owner_actor_id = ${actorId}
              )
            ORDER BY event.received_at DESC
            LIMIT ${boundedLimit}
          `
        : await getSql()`
            SELECT *
            FROM omni_workflow_trigger_events
            WHERE tenant_id = ${tenantId}
            ORDER BY received_at DESC
            LIMIT ${boundedLimit}
          `;
      return rows.map(workflowTriggerEventFromRow);
    };
    return actorId
      ? runWithDatabaseActorScope(tenantId, [actorId], operation)
      : runWithDatabaseTenantScope(tenantId, operation);
  }

  const ledger = await readTriggerLedger();
  return ledger.events
    .filter((event) => normalizeTenantId(event.tenantId) === tenantId)
    .filter((event) => {
      if (!actorId) return true;
      const trigger = ledger.triggers.find((candidate) =>
        candidate.id === event.triggerId && triggerTenantId(candidate) === tenantId
      );
      return Boolean(trigger && workflowTriggerVisibleToActor(
        normalizeLegacyWorkflowTrigger({ ...trigger, tenantId }),
        actorId,
      ));
    })
    .map((event) => ({ ...event, tenantId }))
    .slice(0, boundedLimit);
}

export async function getWorkflowTriggerStats(
  options: { tenantId?: string; actorId?: string } = {},
): Promise<WorkflowTriggerStats> {
  const tenantId = normalizeTenantId(options.tenantId || getDatabaseTenantContext());
  const [triggers, events] = await Promise.all([
    listWorkflowTriggers(500, { tenantId, actorId: options.actorId }),
    listWorkflowTriggerEvents(500, { tenantId, actorId: options.actorId }),
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

export async function listSchedulableWorkflowProcedures(input: {
  tenantId: string;
  actorId: string;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  const procedures = await runWithDatabaseActorScope(
    tenantId,
    [actorId],
    () => listSavedProcedures({ tenantId, actorId }),
  );
  return procedures.map((procedure) => {
    try {
      assertReadOnlyProcedure(procedure.toolBindings);
      return Object.freeze({
        id: procedure.id,
        aliases: Object.freeze([...procedure.aliases]),
        toolIds: Object.freeze(procedure.toolBindings.map((binding) => binding.toolId)),
        schedulable: true as const,
      });
    } catch {
      return Object.freeze({
        id: procedure.id,
        aliases: Object.freeze([...procedure.aliases]),
        toolIds: Object.freeze(procedure.toolBindings.map((binding) => binding.toolId)),
        schedulable: false as const,
        reason: "Only exact, active read-only tool bindings can run unattended.",
      });
    }
  });
}

export async function createReviewedWorkflowSchedule(
  input: ReviewedWorkflowScheduleCreateInput,
) {
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  assertExecutionScopeTenant(input.executionScope, tenantId);
  if (input.executionScope.initiatingActorId !== actorId) {
    throw new WorkflowScheduleControlError(
      "Scheduled workflow review requires the owning actor.",
      "invalid_state",
    );
  }
  const value = scheduleCreateInputSchema.parse({
    name: input.name,
    source: input.source,
    procedureId: input.procedureId,
    agentId: input.agentId,
    timezone: input.timezone,
    rrule: input.rrule,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    maxOccurrences: input.maxOccurrences,
    missedPolicy: input.missedPolicy,
    occurrenceBudget: input.occurrenceBudget,
    failureLimit: input.failureLimit,
    replacesTriggerId: input.replacesTriggerId,
  });
  const reviewRequestSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    tenantId,
    actorId,
    name: value.name,
    source: value.source || "saved-procedure",
    procedureId: value.procedureId,
    agentId: value.agentId,
    timezone: value.timezone,
    rrule: value.rrule,
    startsAt: value.startsAt,
    endsAt: value.endsAt || null,
    maxOccurrences: value.maxOccurrences,
    missedPolicy: value.missedPolicy,
    occurrenceBudget: value.occurrenceBudget,
    failureLimit: value.failureLimit,
    replacesTriggerId: value.replacesTriggerId || null,
  });
  const deterministicId = deterministicTriggerId(tenantId, input.idempotencyKey);
  const existing = await getWorkflowTrigger(deterministicId, { tenantId, actorId });
  if (existing) {
    if (
      existing.triggerKind !== "schedule" ||
      existing.metadata.reviewRequestSha256 !== reviewRequestSha256
    ) {
      throw new WorkflowScheduleControlError(
        "The schedule Idempotency-Key is already bound to another reviewed request.",
        "immutable_binding_changed",
      );
    }
    if (value.replacesTriggerId && existing.status === "paused") {
      const previous = await getWorkflowTrigger(value.replacesTriggerId, {
        tenantId,
        actorId,
      });
      if (!previous || previous.triggerKind !== "schedule") {
        throw new WorkflowScheduleControlError(
          "The original schedule is unavailable.",
          "not_found",
        );
      }
      if (!previous.replacedByTriggerId) {
        return activateWorkflowScheduleReplacement({
          tenantId,
          actorId,
          previousTriggerId: value.replacesTriggerId,
          replacementTriggerId: existing.id,
          executionScope: input.executionScope,
        });
      }
      if (previous.replacedByTriggerId !== existing.id) {
        throw new WorkflowScheduleControlError(
          "The original schedule is already bound to another replacement.",
          "invalid_state",
        );
      }
    }
    return existing;
  }
  const [procedures, identity] = await Promise.all([
    runWithDatabaseActorScope(tenantId, [actorId], () =>
      listSavedProcedures({ tenantId, actorId })),
    runWithDatabaseActorScope(tenantId, [actorId], () =>
      resolveAgentIdentityForExecution({
        tenantId,
        actorId,
        agentId: value.agentId,
      })),
  ]);
  const procedure = procedures.find((candidate) => candidate.id === value.procedureId);
  if (!procedure) {
    throw new WorkflowScheduleControlError(
      "The selected saved procedure is unavailable.",
      "not_found",
    );
  }
  assertReadOnlyProcedure(procedure.toolBindings);
  const snapshot = buildWorkflowProcedureSnapshot(
    procedure,
    procedure.aliases[0],
  );
  const identityPin = buildAgentRunIdentityPinV1({
    runId: `workflow-schedule-review-${canonicalJsonSha256({
      tenantId,
      actorId,
      idempotencyKey: input.idempotencyKey,
    }).slice(0, 40)}`,
    identity,
  });
  const reviewedAt = minuteTimestamp(new Date().toISOString());
  const occurrenceBudget = scheduleOccurrenceBudgetSchema.parse(
    value.occurrenceBudget,
  );
  const reviewedSnapshotSha256 = workflowScheduleReviewSha256({
    procedureSnapshotSha256: snapshot.snapshotSha256,
    agentIdentityPinSha256: identityPin.pinSha256,
    policyPinSha256: canonicalJsonSha256(identityPin.policyPins),
    occurrenceBudgetSha256: canonicalJsonSha256(occurrenceBudget),
    reviewedAt,
  });
  if (value.replacesTriggerId) {
    const current = await getWorkflowTrigger(value.replacesTriggerId, {
      tenantId,
      actorId,
    });
    if (!current || current.triggerKind !== "schedule") {
      throw new WorkflowScheduleControlError(
        "The schedule selected for replacement is unavailable.",
        "not_found",
      );
    }
    if (
      current.replacedByTriggerId &&
      current.replacedByTriggerId !== deterministicId
    ) {
      throw new WorkflowScheduleControlError(
        "The schedule has already been replaced by another reviewed version.",
        "invalid_state",
      );
    }
  }
  const created = await createWorkflowTrigger({
    tenantId,
    triggerKind: "schedule",
    name: value.name,
    source: value.source || "saved-procedure",
    status: value.replacesTriggerId ? "paused" : "active",
    goalTemplate: `Run reviewed saved procedure ${snapshot.id}.`,
    workflowMode: snapshot.schemaVersion === 2 ? snapshot.mode : "orchestrate",
    requireApproval: false,
    metadata: {
      source: "scheduled_read_only_canary",
      procedureId: snapshot.id,
      logicalAgentId: identity.definition.logicalAgentId,
      reviewRequestSha256,
    },
    replacesTriggerId: value.replacesTriggerId,
    executionScope: input.executionScope,
    idempotencyKey: input.idempotencyKey,
    schedule: {
      timezone: value.timezone,
      rrule: value.rrule,
      startsAt: value.startsAt,
      endsAt: value.endsAt,
      maxOccurrences: value.maxOccurrences,
      missedPolicy: value.missedPolicy,
      procedurePin: {
        schemaVersion: 1,
        procedureId: snapshot.id,
        snapshotSha256: snapshot.snapshotSha256,
        reviewedSnapshotSha256,
        reviewedAt,
      },
      agentIdentityPin: identityPin,
      occurrenceBudget,
      failureLimit: value.failureLimit,
    },
  });
  if (!value.replacesTriggerId) return created;
  return activateWorkflowScheduleReplacement({
    tenantId,
    actorId,
    previousTriggerId: value.replacesTriggerId,
    replacementTriggerId: created.id,
    executionScope: input.executionScope,
  });
}

export async function setWorkflowSchedulePaused(input: {
  tenantId: string;
  actorId: string;
  triggerId: string;
  paused: boolean;
  reason?: string;
  executionScope: ExecutionScope;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  assertExecutionScopeTenant(input.executionScope, tenantId);
  if (input.executionScope.initiatingActorId !== actorId) {
    throw new WorkflowScheduleControlError(
      "Schedule controls require the owning actor.",
      "invalid_state",
    );
  }
  const current = await getWorkflowTrigger(input.triggerId, { tenantId, actorId });
  if (!current) throw new WorkflowScheduleControlError("Schedule not found.", "not_found");
  if (!current.schedule) {
    throw new WorkflowScheduleControlError("Webhook triggers do not accept schedule controls.", "not_schedule");
  }
  if (!input.paused && !current.schedule.state.nextDueAt) {
    throw new WorkflowScheduleControlError(
      "An exhausted schedule cannot be resumed; create a replacement.",
      "invalid_state",
    );
  }
  const now = new Date().toISOString();
  const reason = input.paused
    ? (input.reason || "Paused by the owner.").trim().slice(0, 500)
    : undefined;
  let updated: WorkflowTriggerRecord | null = null;
  if (hasDatabaseUrl()) {
    updated = await runWithDatabaseActorScope(tenantId, [actorId], async () => {
      await ensureDatabaseSchema();
      return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          UPDATE omni_workflow_triggers
          SET status = ${input.paused ? "paused" : "active"},
              paused_reason = ${reason || null},
              circuit_state = ${input.paused
                ? current.schedule!.state.circuitState
                : "closed"},
              consecutive_failure_count = ${input.paused
                ? current.schedule!.state.consecutiveFailureCount
                : 0},
              updated_at = ${now}
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id = ${actorId}
            AND id = ${current.id}
            AND trigger_kind = 'schedule'
          RETURNING *
        `;
        if (!rows[0]) return null;
        const next = workflowTriggerFromRow(rows[0]);
        await appendWorkflowScheduleControlEvent({
          trigger: next,
          action: input.paused ? "paused" : "resumed",
          executionScope: input.executionScope,
          sql,
        });
        return next;
      }) as Promise<WorkflowTriggerRecord | null>;
    });
  } else {
    await mutateTriggerLedger((ledger) => {
      ledger.triggers = ledger.triggers.map((trigger) => {
        if (trigger.id !== current.id || triggerTenantId(trigger) !== tenantId) return trigger;
        updated = {
          ...trigger,
          status: input.paused ? "paused" : "active",
          updatedAt: now,
          schedule: trigger.schedule ? {
            ...trigger.schedule,
            state: {
              ...trigger.schedule.state,
              pausedReason: reason,
              circuitState: input.paused
                ? trigger.schedule.state.circuitState
                : "closed",
              consecutiveFailureCount: input.paused
                ? trigger.schedule.state.consecutiveFailureCount
                : 0,
            },
          } : undefined,
        };
        return updated!;
      });
      return ledger;
    });
    if (updated) {
      await appendWorkflowScheduleControlEvent({
        trigger: updated,
        action: input.paused ? "paused" : "resumed",
        executionScope: input.executionScope,
      });
    }
  }
  if (!updated) throw new WorkflowScheduleControlError("Schedule not found.", "not_found");
  return updated;
}

export async function listWorkflowScheduleOccurrences(input: {
  tenantId: string;
  actorId: string;
  triggerId?: string;
  limit?: number;
}) {
  if (!hasDatabaseUrl()) return [] as WorkflowScheduleOccurrenceRecord[];
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  const limit = Math.min(Math.max(input.limit || 50, 1), 200);
  return runWithDatabaseActorScope(tenantId, [actorId], async () => {
    await ensureDatabaseSchema();
    const rows = input.triggerId
      ? await getSql()`
          SELECT * FROM omni_workflow_schedule_occurrences
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id = ${actorId}
            AND trigger_id = ${input.triggerId}
          ORDER BY scheduled_for DESC, id COLLATE "C"
          LIMIT ${limit}
        `
      : await getSql()`
          SELECT * FROM omni_workflow_schedule_occurrences
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id = ${actorId}
          ORDER BY scheduled_for DESC, id COLLATE "C"
          LIMIT ${limit}
        `;
    return rows.map(workflowScheduleOccurrenceFromRow);
  });
}

export async function listWorkflowScheduleOccurrenceReceipts(input: {
  tenantId: string;
  actorId: string;
  triggerId?: string;
  limit?: number;
}) {
  if (!hasDatabaseUrl()) return [] as WorkflowScheduleOccurrenceReceiptV1[];
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  const limit = Math.min(Math.max(input.limit || 100, 1), 200);
  return runWithDatabaseActorScope(tenantId, [actorId], async () => {
    await ensureDatabaseSchema();
    const rows = input.triggerId
      ? await getSql()`
          SELECT * FROM omni_workflow_schedule_occurrence_receipts
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id = ${actorId}
            AND trigger_id = ${input.triggerId}
          ORDER BY recorded_at DESC, id COLLATE "C"
          LIMIT ${limit}
        `
      : await getSql()`
          SELECT * FROM omni_workflow_schedule_occurrence_receipts
          WHERE tenant_id = ${tenantId}
            AND owner_actor_id = ${actorId}
          ORDER BY recorded_at DESC, id COLLATE "C"
          LIMIT ${limit}
        `;
    return rows.map(workflowScheduleOccurrenceReceiptFromRow);
  });
}

export async function previewWorkflowSchedule(input: {
  tenantId: string;
  actorId: string;
  triggerId: string;
  count?: number;
}) {
  const trigger = await getWorkflowTrigger(input.triggerId, {
    tenantId: input.tenantId,
    actorId: input.actorId,
  });
  if (!trigger) throw new WorkflowScheduleControlError("Schedule not found.", "not_found");
  if (!trigger.schedule) {
    throw new WorkflowScheduleControlError("Webhook triggers have no schedule preview.", "not_schedule");
  }
  const occurrences: string[] = [];
  let cursor = trigger.schedule.state.nextDueAt;
  let completed = trigger.schedule.state.occurrenceCount;
  const count = Math.min(Math.max(input.count || 3, 1), 12);
  while (cursor && occurrences.length < count) {
    occurrences.push(cursor);
    completed += 1;
    cursor = nextWorkflowScheduleOccurrence({
      config: trigger.schedule.config,
      after: cursor,
      completedOccurrences: completed,
    });
  }
  return Object.freeze({
    triggerId: trigger.id,
    status: trigger.status,
    circuitState: trigger.schedule.state.circuitState,
    timezone: trigger.schedule.config.timezone,
    occurrences: Object.freeze(occurrences),
    configurationSha256: trigger.schedule.config.configSha256,
    readOnlyCanary: true,
  });
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

export async function processDueWorkflowSchedulesForTenant(input: {
  tenantId: string;
  systemActorId: string;
  correlationId: string;
  now?: string;
  limit?: number;
}) {
  if (!hasDatabaseUrl()) {
    return {
      ownerActors: 0,
      shadowEvaluated: 0,
      occurrencesClaimed: 0,
      occurrencesEnqueued: 0,
      occurrencesSkipped: 0,
      occurrencesFailed: 0,
      occurrencesReconciled: 0,
    };
  }
  const tenantId = normalizeTenantId(input.tenantId);
  const now = new Date(requireTimestamp(
    input.now || new Date().toISOString(),
    "schedule processing time",
  )).toISOString();
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const ownerRows = await runWithDatabaseSystemScope(
    `Discover due scheduled workflow owners for tenant ${tenantId}.`,
    async () => {
      await ensureDatabaseSchema();
      return getSql()`
        SELECT DISTINCT owner_actor_id
        FROM omni_workflow_triggers trigger
        WHERE trigger.tenant_id = ${tenantId}
          AND trigger.trigger_kind = 'schedule'
          AND trigger.owner_actor_id IS NOT NULL
          AND (
            (
              trigger.status = 'active'
              AND trigger.circuit_state = 'closed'
              AND (
                (trigger.next_due_at IS NOT NULL AND trigger.next_due_at <= ${now})
                OR (trigger.shadow_next_due_at IS NOT NULL AND trigger.shadow_next_due_at <= ${now})
              )
            ) OR EXISTS (
              SELECT 1
              FROM omni_workflow_schedule_occurrences occurrence
              WHERE occurrence.tenant_id = trigger.tenant_id
                AND occurrence.owner_actor_id = trigger.owner_actor_id
                AND occurrence.trigger_id = trigger.id
                AND occurrence.status IN ('claimed', 'enqueued')
            )
          )
        ORDER BY owner_actor_id COLLATE "C"
        LIMIT ${limit}
      `;
    },
  );
  const totals = {
    ownerActors: ownerRows.length,
    shadowEvaluated: 0,
    occurrencesClaimed: 0,
    occurrencesEnqueued: 0,
    occurrencesSkipped: 0,
    occurrencesFailed: 0,
    occurrencesReconciled: 0,
  };
  for (const row of ownerRows) {
    const actorId = requiredActorId(String(row.owner_actor_id));
    const result = await processActorWorkflowSchedules({
      tenantId,
      actorId,
      systemActorId: input.systemActorId,
      correlationId: input.correlationId,
      now,
      limit,
    });
    totals.shadowEvaluated += result.shadowEvaluated;
    totals.occurrencesClaimed += result.occurrencesClaimed;
    totals.occurrencesEnqueued += result.occurrencesEnqueued;
    totals.occurrencesSkipped += result.occurrencesSkipped;
    totals.occurrencesFailed += result.occurrencesFailed;
    totals.occurrencesReconciled += result.occurrencesReconciled;
  }
  return totals;
}

export async function processActorWorkflowSchedules(input: {
  tenantId: string;
  actorId: string;
  systemActorId: string;
  correlationId: string;
  now?: string;
  limit?: number;
}) {
  if (!hasDatabaseUrl()) {
    throw new Error("Scheduled workflow processing requires durable database storage.");
  }
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  const now = new Date(requireTimestamp(
    input.now || new Date().toISOString(),
    "schedule processing time",
  )).toISOString();
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const schedulerScope = createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "system",
    executingPrincipalId: input.systemActorId,
    correlationId: `${input.correlationId}:workflow-schedules:${canonicalJsonSha256({ actorId }).slice(0, 16)}`,
    purpose: "workflow.schedule.tick",
  });
  const shadow = await claimDueWorkflowScheduleShadows({
    tenantId,
    actorId,
    executionScope: schedulerScope,
    now,
    limit,
  });
  const reconciled = await reconcileWorkflowScheduleOccurrences({
    tenantId,
    actorId,
    executionScope: schedulerScope,
    now,
    limit,
  });
  const claimed = await claimDueWorkflowScheduleOccurrences({
    tenantId,
    actorId,
    executionScope: schedulerScope,
    now,
    limit,
  });
  const pending = await listClaimedWorkflowScheduleOccurrences({
    tenantId,
    actorId,
    limit,
  });
  const processed: WorkflowScheduleOccurrenceRecord[] = [];
  for (const occurrence of pending) {
    processed.push(await executeClaimedWorkflowScheduleOccurrence(
      occurrence,
      schedulerScope,
    ));
  }
  return {
    shadowEvaluated: shadow.length,
    occurrencesClaimed: claimed.filter((item) => item.status === "claimed").length,
    occurrencesSkipped: claimed.filter((item) => item.status === "skipped").length,
    occurrencesEnqueued: processed.filter((item) => item.status === "enqueued").length,
    occurrencesFailed: processed.filter((item) => item.status === "failed").length,
    occurrencesReconciled: reconciled.length,
  };
}

export async function runWorkflowScheduleOnce(input: {
  tenantId: string;
  actorId: string;
  triggerId: string;
  scheduledFor: string;
  executionScope: ExecutionScope;
}) {
  if (!hasDatabaseUrl()) {
    throw new Error("Scheduled workflow run-once requires durable database storage.");
  }
  const tenantId = normalizeTenantId(input.tenantId);
  const actorId = requiredActorId(input.actorId);
  assertExecutionScopeTenant(input.executionScope, tenantId);
  if (input.executionScope.initiatingActorId !== actorId) {
    throw new WorkflowScheduleControlError(
      "Run once requires the owning actor.",
      "invalid_state",
    );
  }
  const scheduledFor = minuteTimestamp(input.scheduledFor);
  const trigger = await getWorkflowTrigger(input.triggerId, { tenantId, actorId });
  if (!trigger) throw new WorkflowScheduleControlError("Schedule not found.", "not_found");
  if (!trigger.schedule) throw new WorkflowScheduleControlError("Webhook triggers cannot run once.", "not_schedule");
  if (trigger.status !== "active" || trigger.schedule.state.circuitState !== "closed") {
    throw new WorkflowScheduleControlError(
      "Resume this schedule and close its circuit before running it.",
      "invalid_state",
    );
  }
  const occurrence = await insertManualWorkflowScheduleOccurrence({
    trigger,
    scheduledFor,
    executionScope: input.executionScope,
  });
  return occurrence.status === "claimed"
    ? executeClaimedWorkflowScheduleOccurrence(occurrence, input.executionScope)
    : occurrence;
}

async function claimDueWorkflowScheduleOccurrences(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  now: string;
  limit: number;
}) {
  return runWithDatabaseActorScope(input.tenantId, [input.actorId], async () => {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        SELECT *
        FROM omni_workflow_triggers
        WHERE tenant_id = ${input.tenantId}
          AND owner_actor_id = ${input.actorId}
          AND trigger_kind = 'schedule'
          AND status = 'active'
          AND circuit_state = 'closed'
          AND next_due_at IS NOT NULL
          AND next_due_at <= ${input.now}
        ORDER BY next_due_at ASC, id COLLATE "C"
        LIMIT ${input.limit}
        FOR UPDATE SKIP LOCKED
      `;
      const claimed: WorkflowScheduleOccurrenceRecord[] = [];
      for (const row of rows) {
        const trigger = workflowTriggerFromRow(row);
        const currentNextDueAt = trigger.schedule?.state.nextDueAt;
        if (!trigger.schedule || !currentNextDueAt) continue;
        const evaluation = evaluateWorkflowScheduleShadow({
          config: trigger.schedule.config,
          currentNextDueAt,
          occurrenceCount: trigger.schedule.state.occurrenceCount,
          now: input.now,
        });
        const occurrence = buildWorkflowScheduleOccurrence({
          trigger,
          kind: "scheduled",
          status: evaluation.wouldCreateRun ? "claimed" : "skipped",
          ...evaluation,
          now: input.now,
        });
        const inserted = await insertWorkflowScheduleOccurrence(
          occurrence,
          input.executionScope,
          sql,
        );
        await sql`
          UPDATE omni_workflow_triggers
          SET next_due_at = ${evaluation.nextDueAt || null},
              occurrence_count = ${evaluation.occurrenceCount},
              updated_at = ${input.now}
          WHERE tenant_id = ${input.tenantId}
            AND owner_actor_id = ${input.actorId}
            AND id = ${trigger.id}
            AND next_due_at = ${currentNextDueAt}
        `;
        if (inserted) claimed.push(inserted);
      }
      return claimed;
    }) as Promise<WorkflowScheduleOccurrenceRecord[]>;
  });
}

async function insertManualWorkflowScheduleOccurrence(input: {
  trigger: WorkflowTriggerRecord;
  scheduledFor: string;
  executionScope: ExecutionScope;
}) {
  const schedule = input.trigger.schedule!;
  const occurrence = buildWorkflowScheduleOccurrence({
    trigger: input.trigger,
    kind: "manual",
    status: "claimed",
    scheduledFor: input.scheduledFor,
    evaluatedThrough: input.scheduledFor,
    outcome: "due",
    occurrencesConsumed: 0,
    occurrenceCount: schedule.state.occurrenceCount,
    nextDueAt: schedule.state.nextDueAt,
    now: new Date().toISOString(),
  });
  return runWithDatabaseActorScope(
    input.trigger.tenantId,
    [input.trigger.ownerActorId!],
    async () => getSql().transaction(async (sql: ReturnType<typeof getSql>) =>
      (await insertWorkflowScheduleOccurrence(
        occurrence,
        input.executionScope,
        sql,
      )) || occurrence),
  ) as Promise<WorkflowScheduleOccurrenceRecord>;
}

async function listClaimedWorkflowScheduleOccurrences(input: {
  tenantId: string;
  actorId: string;
  limit: number;
}) {
  return runWithDatabaseActorScope(input.tenantId, [input.actorId], async () => {
    const rows = await getSql()`
      SELECT * FROM omni_workflow_schedule_occurrences
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND status = 'claimed'
      ORDER BY scheduled_for ASC, id COLLATE "C"
      LIMIT ${input.limit}
    `;
    return rows.map(workflowScheduleOccurrenceFromRow);
  });
}

async function executeClaimedWorkflowScheduleOccurrence(
  occurrence: WorkflowScheduleOccurrenceRecord,
  schedulerScope: ExecutionScope,
) {
  let queued = false;
  try {
    const authority = await revalidateWorkflowScheduleCanary(occurrence);
    const executionScope = createExecutionScope({
      tenantId: occurrence.tenantId,
      initiatingActorId: occurrence.ownerActorId,
      executingPrincipalType: "agent",
      executingPrincipalId: authority.identity.principal.principalId,
      correlationId: `workflow-schedule:${occurrence.id}`,
      causationId: occurrence.id,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: "workflow.schedule.read_only_canary",
    });
    const workflow = await createWorkflowRun({
      tenantId: occurrence.tenantId,
      executionAuthority: {
        executionScope,
        requesterRole: "system",
      },
      idempotencyKey: `schedule:${occurrence.authoritySha256}`,
      goal: scheduledProcedureGoal(authority.snapshot, occurrence.scheduledFor),
      mode: authority.trigger.workflowMode,
      requireApproval: false,
      maxAttempts: 1,
      budgetLimits: authority.trigger.schedule!.config.occurrenceBudget,
      metadata: {
        source: "scheduled_read_only_canary",
        actorId: occurrence.ownerActorId,
        primaryAgentId: authority.identity.definition.logicalAgentId,
        agentIdentity: authority.identity,
        agentProfile: authority.profile,
        savedProcedure: authority.snapshot,
        scheduleTriggerId: occurrence.triggerId,
        scheduleOccurrenceId: occurrence.id,
        scheduledFor: occurrence.scheduledFor,
        scheduleConfigurationSha256: occurrence.configurationSha256,
        readOnlyCanary: true,
      },
    });
    const queueJob = await enqueueWorkflowRunTick(
      workflow.run.id,
      `schedule:${occurrence.triggerId}`,
      undefined,
      occurrence.tenantId,
    );
    queued = true;
    const enqueued = await transitionWorkflowScheduleOccurrence({
      occurrence,
      status: "enqueued",
      workflowRunId: workflow.run.id,
      queueJobId: queueJob.id,
      executionScope: schedulerScope,
    });
    await appendWorkflowEvent(workflow.run.id, "workflow.schedule.enqueued", {
      triggerId: occurrence.triggerId,
      occurrenceId: occurrence.id,
      scheduledFor: occurrence.scheduledFor,
      configurationSha256: occurrence.configurationSha256,
      readOnlyCanary: true,
      queueJobId: queueJob.id,
    }).catch(() => undefined);
    return enqueued;
  } catch (error) {
    // Once the existing queue accepts the idempotent run, leave a failed
    // projection claim retriable instead of falsely recording that no run exists.
    if (queued) return occurrence;
    return transitionWorkflowScheduleOccurrence({
      occurrence,
      status: "failed",
      failureCode: scheduleFailureCode(error),
      executionScope: schedulerScope,
    });
  }
}

async function reconcileWorkflowScheduleOccurrences(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  now: string;
  limit: number;
}) {
  const candidates = await runWithDatabaseActorScope(
    input.tenantId,
    [input.actorId],
    async () => {
      const rows = await getSql()`
        SELECT occurrence.*, run.status AS workflow_status
        FROM omni_workflow_schedule_occurrences occurrence
        JOIN omni_workflow_runs run
          ON run.tenant_id = occurrence.tenant_id
          AND run.id = occurrence.workflow_run_id
        WHERE occurrence.tenant_id = ${input.tenantId}
          AND occurrence.owner_actor_id = ${input.actorId}
          AND occurrence.status = 'enqueued'
          AND run.status IN ('completed', 'failed', 'canceled')
        ORDER BY occurrence.updated_at ASC, occurrence.id COLLATE "C"
        LIMIT ${input.limit}
      `;
      return rows.map((row) => ({
        occurrence: workflowScheduleOccurrenceFromRow(row),
        workflowStatus: String(row.workflow_status),
      }));
    },
  );
  const reconciled: WorkflowScheduleOccurrenceRecord[] = [];
  for (const candidate of candidates) {
    reconciled.push(await transitionWorkflowScheduleOccurrence({
      occurrence: candidate.occurrence,
      status: candidate.workflowStatus === "completed" ? "completed" : "failed",
      failureCode: candidate.workflowStatus === "failed"
        ? "workflow_failed"
        : candidate.workflowStatus === "canceled"
          ? "workflow_canceled"
          : undefined,
      executionScope: input.executionScope,
    }));
  }
  return reconciled;
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
          replaces_trigger_id, replaced_by_trigger_id,
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
          ${record.replacesTriggerId || null},
          ${record.replacedByTriggerId || null},
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

async function appendWorkflowScheduleControlEvent(input: {
  trigger: WorkflowTriggerRecord;
  action: "paused" | "resumed" | "replaced" | "replacement_activated";
  executionScope: ExecutionScope;
  sql?: ReturnType<typeof getSql>;
}) {
  const stateSha256 = canonicalJsonSha256({
    triggerId: input.trigger.id,
    status: input.trigger.status,
    circuitState: input.trigger.schedule?.state.circuitState || null,
    consecutiveFailureCount:
      input.trigger.schedule?.state.consecutiveFailureCount || 0,
    replacesTriggerId: input.trigger.replacesTriggerId || null,
    replacedByTriggerId: input.trigger.replacedByTriggerId || null,
    updatedAt: input.trigger.updatedAt,
  });
  await appendScopedDomainEvent({
    id: `workflow-schedule-control:${canonicalJsonSha256({
      triggerId: input.trigger.id,
      action: input.action,
      stateSha256,
    })}`,
    streamId: `workflow-trigger:${input.trigger.id}`,
    type: `workflow.schedule.${input.action}`,
    executionScope: deriveExecutionScope(input.executionScope, {
      causationId: `workflow-schedule:${input.trigger.id}:${input.action}`,
      purpose: "workflow.schedule.control",
    }),
    payload: {
      schemaVersion: 1,
      triggerId: input.trigger.id,
      action: input.action,
      status: input.trigger.status,
      circuitState: input.trigger.schedule?.state.circuitState || null,
      configurationSha256:
        input.trigger.schedule?.config.configSha256 || null,
      stateSha256,
    },
  }, input.sql ? { sql: input.sql } : {});
}

async function insertWorkflowScheduleOccurrence(
  occurrence: WorkflowScheduleOccurrenceRecord,
  executionScope: ExecutionScope,
  sql: ReturnType<typeof getSql>,
) {
  const rows = await sql`
    INSERT INTO omni_workflow_schedule_occurrences (
      schema_version, id, tenant_id, owner_actor_id, trigger_id,
      occurrence_kind, status, scheduled_for, evaluated_through, outcome,
      occurrences_consumed, occurrence_count, next_due_at,
      configuration_sha256, agent_identity_pin_sha256, policy_pin_sha256,
      procedure_snapshot_sha256, reviewed_snapshot_sha256,
      occurrence_budget_sha256, authority_sha256, workflow_run_id,
      queue_job_id, failure_code, attempt_count, last_attempt_at,
      completed_at, created_at, updated_at
    ) VALUES (
      ${occurrence.schemaVersion}, ${occurrence.id}, ${occurrence.tenantId},
      ${occurrence.ownerActorId}, ${occurrence.triggerId}, ${occurrence.kind},
      ${occurrence.status}, ${occurrence.scheduledFor},
      ${occurrence.evaluatedThrough}, ${occurrence.outcome},
      ${occurrence.occurrencesConsumed}, ${occurrence.occurrenceCount},
      ${occurrence.nextDueAt || null}, ${occurrence.configurationSha256},
      ${occurrence.agentIdentityPinSha256}, ${occurrence.policyPinSha256},
      ${occurrence.procedureSnapshotSha256},
      ${occurrence.reviewedSnapshotSha256},
      ${occurrence.occurrenceBudgetSha256}, ${occurrence.authoritySha256},
      ${occurrence.workflowRunId || null}, ${occurrence.queueJobId || null},
      ${occurrence.failureCode || null}, ${occurrence.attemptCount},
      ${occurrence.lastAttemptAt || null}, ${occurrence.completedAt || null},
      ${occurrence.createdAt}, ${occurrence.updatedAt}
    )
    ON CONFLICT (
      tenant_id, owner_actor_id, trigger_id, scheduled_for,
      configuration_sha256
    ) DO NOTHING
    RETURNING *
  `;
  if (!rows[0]) {
    const existing = await sql`
      SELECT * FROM omni_workflow_schedule_occurrences
      WHERE tenant_id = ${occurrence.tenantId}
        AND owner_actor_id = ${occurrence.ownerActorId}
        AND trigger_id = ${occurrence.triggerId}
        AND scheduled_for = ${occurrence.scheduledFor}
        AND configuration_sha256 = ${occurrence.configurationSha256}
      LIMIT 1
    `;
    return existing[0]
      ? workflowScheduleOccurrenceFromRow(existing[0])
      : undefined;
  }
  const inserted = workflowScheduleOccurrenceFromRow(rows[0]);
  await appendWorkflowScheduleOccurrenceReceipt(inserted, executionScope, sql);
  return inserted;
}

async function transitionWorkflowScheduleOccurrence(input: {
  occurrence: WorkflowScheduleOccurrenceRecord;
  status: "enqueued" | "completed" | "failed";
  workflowRunId?: string;
  queueJobId?: string;
  failureCode?: WorkflowScheduleOccurrenceFailureCode;
  executionScope: ExecutionScope;
}) {
  const now = new Date().toISOString();
  return runWithDatabaseActorScope(
    input.occurrence.tenantId,
    [input.occurrence.ownerActorId],
    async () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const currentRows = await sql`
        SELECT * FROM omni_workflow_schedule_occurrences
        WHERE tenant_id = ${input.occurrence.tenantId}
          AND owner_actor_id = ${input.occurrence.ownerActorId}
          AND id = ${input.occurrence.id}
        LIMIT 1
        FOR UPDATE
      `;
      if (!currentRows[0]) {
        throw new WorkflowScheduleControlError(
          "Scheduled occurrence disappeared during processing.",
          "not_found",
        );
      }
      const current = workflowScheduleOccurrenceFromRow(currentRows[0]);
      if (current.status === input.status) return current;
      if (
        (input.status === "enqueued" && current.status !== "claimed") ||
        ((input.status === "completed" || input.status === "failed") &&
          current.status !== "enqueued" && current.status !== "claimed")
      ) {
        return current;
      }
      const rows = await sql`
        UPDATE omni_workflow_schedule_occurrences
        SET status = ${input.status},
            workflow_run_id = ${input.workflowRunId || current.workflowRunId || null},
            queue_job_id = ${input.queueJobId || current.queueJobId || null},
            failure_code = ${input.failureCode || null},
            attempt_count = attempt_count + 1,
            last_attempt_at = ${now},
            completed_at = ${input.status === "completed" || input.status === "failed"
              ? now
              : null},
            updated_at = ${now}
        WHERE tenant_id = ${current.tenantId}
          AND owner_actor_id = ${current.ownerActorId}
          AND id = ${current.id}
        RETURNING *
      `;
      const updated = workflowScheduleOccurrenceFromRow(rows[0]);
      await appendWorkflowScheduleOccurrenceReceipt(
        updated,
        input.executionScope,
        sql,
      );
      if (input.status === "enqueued") {
        await sql`
          UPDATE omni_workflow_triggers
          SET trigger_count = trigger_count + 1,
              last_triggered_at = ${now},
              updated_at = ${now}
          WHERE tenant_id = ${current.tenantId}
            AND owner_actor_id = ${current.ownerActorId}
            AND id = ${current.triggerId}
        `;
      } else if (input.status === "completed") {
        await sql`
          UPDATE omni_workflow_triggers
          SET consecutive_failure_count = 0,
              circuit_state = 'closed',
              last_failure_at = NULL,
              circuit_opened_at = NULL,
              updated_at = ${now}
          WHERE tenant_id = ${current.tenantId}
            AND owner_actor_id = ${current.ownerActorId}
            AND id = ${current.triggerId}
        `;
      } else {
        await sql`
          UPDATE omni_workflow_triggers
          SET failure_count = failure_count + 1,
              consecutive_failure_count = consecutive_failure_count + 1,
              last_failure_at = ${now},
              circuit_state = CASE
                WHEN consecutive_failure_count + 1 >= failure_limit
                  THEN 'open'
                ELSE circuit_state
              END,
              status = CASE
                WHEN consecutive_failure_count + 1 >= failure_limit
                  THEN 'paused'
                ELSE status
              END,
              paused_reason = CASE
                WHEN consecutive_failure_count + 1 >= failure_limit
                  THEN 'Scheduled read-only canary circuit opened after repeated failures.'
                ELSE paused_reason
              END,
              circuit_opened_at = CASE
                WHEN consecutive_failure_count + 1 >= failure_limit
                  THEN ${now}
                ELSE circuit_opened_at
              END,
              updated_at = ${now}
          WHERE tenant_id = ${current.tenantId}
            AND owner_actor_id = ${current.ownerActorId}
            AND id = ${current.triggerId}
        `;
      }
      return updated;
    }),
  ) as Promise<WorkflowScheduleOccurrenceRecord>;
}

async function appendWorkflowScheduleOccurrenceReceipt(
  occurrence: WorkflowScheduleOccurrenceRecord,
  executionScope: ExecutionScope,
  sql: ReturnType<typeof getSql>,
) {
  const recordedAt = occurrence.updatedAt;
  const stateSha256 = canonicalJsonSha256({
    occurrenceId: occurrence.id,
    status: occurrence.status,
    workflowRunId: occurrence.workflowRunId || null,
    queueJobId: occurrence.queueJobId || null,
    failureCode: occurrence.failureCode || null,
    attemptCount: occurrence.attemptCount,
    updatedAt: occurrence.updatedAt,
  });
  const body = {
    schemaVersion: 1 as const,
    id: `workflow_schedule_receipt_${canonicalJsonSha256({
      occurrenceId: occurrence.id,
      stateSha256,
    }).slice(0, 40)}`,
    tenantId: occurrence.tenantId,
    ownerActorId: occurrence.ownerActorId,
    triggerId: occurrence.triggerId,
    occurrenceId: occurrence.id,
    status: occurrence.status,
    workflowRunId: occurrence.workflowRunId,
    queueJobId: occurrence.queueJobId,
    failureCode: occurrence.failureCode,
    authoritySha256: occurrence.authoritySha256,
    stateSha256,
    recordedAt,
  };
  const receipt: WorkflowScheduleOccurrenceReceiptV1 = Object.freeze({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  });
  await sql`
    INSERT INTO omni_workflow_schedule_occurrence_receipts (
      schema_version, id, tenant_id, owner_actor_id, trigger_id,
      occurrence_id, status, workflow_run_id, queue_job_id, failure_code,
      authority_sha256, state_sha256, recorded_at, receipt_sha256
    ) VALUES (
      ${receipt.schemaVersion}, ${receipt.id}, ${receipt.tenantId},
      ${receipt.ownerActorId}, ${receipt.triggerId}, ${receipt.occurrenceId},
      ${receipt.status}, ${receipt.workflowRunId || null},
      ${receipt.queueJobId || null}, ${receipt.failureCode || null},
      ${receipt.authoritySha256}, ${receipt.stateSha256},
      ${receipt.recordedAt}, ${receipt.receiptSha256}
    )
    ON CONFLICT (tenant_id, owner_actor_id, id) DO NOTHING
  `;
  await appendScopedDomainEvent({
    id: `workflow-schedule-occurrence:${receipt.receiptSha256}`,
    streamId: `workflow-trigger:${receipt.triggerId}`,
    type: `workflow.schedule.occurrence.${receipt.status}`,
    executionScope: deriveExecutionScope(executionScope, {
      causationId: receipt.occurrenceId,
      purpose: "workflow.schedule.occurrence.persist",
    }),
    payload: {
      schemaVersion: 1,
      triggerId: receipt.triggerId,
      occurrenceId: receipt.occurrenceId,
      status: receipt.status,
      scheduledFor: occurrence.scheduledFor,
      workflowRunId: receipt.workflowRunId || null,
      queueJobId: receipt.queueJobId || null,
      failureCode: receipt.failureCode || null,
      configurationSha256: occurrence.configurationSha256,
      authoritySha256: receipt.authoritySha256,
      stateSha256: receipt.stateSha256,
      receiptSha256: receipt.receiptSha256,
    },
  }, { sql });
}

async function activateWorkflowScheduleReplacement(input: {
  tenantId: string;
  actorId: string;
  previousTriggerId: string;
  replacementTriggerId: string;
  executionScope: ExecutionScope;
}) {
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    return runWithDatabaseActorScope(input.tenantId, [input.actorId], async () =>
      getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const previousRows = await sql`
          UPDATE omni_workflow_triggers
          SET status = 'paused',
              paused_reason = 'Replaced by a newly reviewed immutable schedule.',
              replaced_by_trigger_id = ${input.replacementTriggerId},
              updated_at = ${now}
          WHERE tenant_id = ${input.tenantId}
            AND owner_actor_id = ${input.actorId}
            AND id = ${input.previousTriggerId}
            AND trigger_kind = 'schedule'
            AND (
              replaced_by_trigger_id IS NULL
              OR replaced_by_trigger_id = ${input.replacementTriggerId}
            )
          RETURNING *
        `;
        if (!previousRows[0]) {
          throw new WorkflowScheduleControlError(
            "The original schedule was already replaced or is unavailable.",
            "invalid_state",
          );
        }
        const replacementRows = await sql`
          UPDATE omni_workflow_triggers
          SET status = 'active',
              paused_reason = NULL,
              updated_at = ${now}
          WHERE tenant_id = ${input.tenantId}
            AND owner_actor_id = ${input.actorId}
            AND id = ${input.replacementTriggerId}
            AND trigger_kind = 'schedule'
            AND replaces_trigger_id = ${input.previousTriggerId}
          RETURNING *
        `;
        if (!replacementRows[0]) {
          throw new WorkflowScheduleControlError(
            "The replacement schedule binding is invalid.",
            "immutable_binding_changed",
          );
        }
        const previous = workflowTriggerFromRow(previousRows[0]);
        const replacement = workflowTriggerFromRow(replacementRows[0]);
        await appendWorkflowScheduleControlEvent({
          trigger: previous,
          action: "replaced",
          executionScope: input.executionScope,
          sql,
        });
        await appendWorkflowScheduleControlEvent({
          trigger: replacement,
          action: "replacement_activated",
          executionScope: input.executionScope,
          sql,
        });
        return replacement;
      }) as Promise<WorkflowTriggerRecord>);
  }
  let replacement: WorkflowTriggerRecord | undefined;
  let previous: WorkflowTriggerRecord | undefined;
  await mutateTriggerLedger((ledger) => {
    ledger.triggers = ledger.triggers.map((trigger) => {
      if (trigger.id === input.previousTriggerId) {
        previous = {
          ...trigger,
          status: "paused",
          replacedByTriggerId: input.replacementTriggerId,
          updatedAt: now,
          schedule: trigger.schedule ? {
            ...trigger.schedule,
            state: {
              ...trigger.schedule.state,
              pausedReason: "Replaced by a newly reviewed immutable schedule.",
            },
          } : undefined,
        };
        return previous;
      }
      if (trigger.id === input.replacementTriggerId) {
        replacement = {
          ...trigger,
          status: "active",
          updatedAt: now,
          schedule: trigger.schedule ? {
            ...trigger.schedule,
            state: { ...trigger.schedule.state, pausedReason: undefined },
          } : undefined,
        };
        return replacement;
      }
      return trigger;
    });
    return ledger;
  });
  if (!previous || !replacement) {
    throw new WorkflowScheduleControlError(
      "The schedule replacement could not be completed.",
      "invalid_state",
    );
  }
  await appendWorkflowScheduleControlEvent({
    trigger: previous,
    action: "replaced",
    executionScope: input.executionScope,
  });
  await appendWorkflowScheduleControlEvent({
    trigger: replacement,
    action: "replacement_activated",
    executionScope: input.executionScope,
  });
  return replacement;
}

class WorkflowScheduleCanaryValidationError extends Error {
  constructor(
    message: string,
    readonly failureCode: WorkflowScheduleOccurrenceFailureCode,
  ) {
    super(message);
    this.name = "WorkflowScheduleCanaryValidationError";
  }
}

async function revalidateWorkflowScheduleCanary(
  occurrence: WorkflowScheduleOccurrenceRecord,
) {
  const trigger = await getWorkflowTrigger(occurrence.triggerId, {
    tenantId: occurrence.tenantId,
    actorId: occurrence.ownerActorId,
  });
  if (!trigger?.schedule || trigger.ownerActorId !== occurrence.ownerActorId) {
    throw new WorkflowScheduleCanaryValidationError(
      "The scheduled trigger binding is unavailable.",
      "agent_policy_changed",
    );
  }
  const config = trigger.schedule.config;
  if (
    config.configSha256 !== occurrence.configurationSha256 ||
    canonicalJsonSha256(config.occurrenceBudget) !==
      occurrence.occurrenceBudgetSha256
  ) {
    throw new WorkflowScheduleCanaryValidationError(
      "The scheduled occurrence budget or configuration changed.",
      "occurrence_budget_changed",
    );
  }
  const identity = await resolveAgentIdentityForExecution({
    tenantId: occurrence.tenantId,
    actorId: occurrence.ownerActorId,
    agentId: config.agentIdentityPin.logicalAgentId,
  });
  const currentPin = buildAgentRunIdentityPinV1({
    runId: config.agentIdentityPin.runId,
    identity,
  });
  if (currentPin.pinSha256 !== config.agentIdentityPin.pinSha256) {
    throw new WorkflowScheduleCanaryValidationError(
      "The exact Agent release or principal changed after review.",
      "agent_identity_changed",
    );
  }
  if (
    canonicalJsonSha256(currentPin.policyPins) !== config.policyPinSha256 ||
    occurrence.policyPinSha256 !== config.policyPinSha256
  ) {
    throw new WorkflowScheduleCanaryValidationError(
      "The Agent policy changed after review.",
      "agent_policy_changed",
    );
  }
  const procedures = await listSavedProcedures({
    tenantId: occurrence.tenantId,
    actorId: occurrence.ownerActorId,
  });
  const procedure = procedures.find((candidate) =>
    candidate.id === config.procedurePin.procedureId
  );
  const snapshot = procedure && findReviewedProcedureSnapshot(
    procedure,
    config.procedurePin.snapshotSha256,
  );
  if (!procedure || !snapshot) {
    throw new WorkflowScheduleCanaryValidationError(
      "The exact saved procedure snapshot changed after review.",
      "procedure_changed",
    );
  }
  const reviewedSnapshotSha256 = workflowScheduleReviewSha256({
    procedureSnapshotSha256: snapshot.snapshotSha256,
    agentIdentityPinSha256: currentPin.pinSha256,
    policyPinSha256: config.policyPinSha256,
    occurrenceBudgetSha256: canonicalJsonSha256(config.occurrenceBudget),
    reviewedAt: config.procedurePin.reviewedAt,
  });
  if (
    reviewedSnapshotSha256 !== config.procedurePin.reviewedSnapshotSha256 ||
    occurrence.reviewedSnapshotSha256 !== reviewedSnapshotSha256
  ) {
    throw new WorkflowScheduleCanaryValidationError(
      "The schedule review digest no longer matches its authority.",
      "procedure_changed",
    );
  }
  try {
    assertReadOnlyProcedure(snapshot.toolBindings);
  } catch {
    throw new WorkflowScheduleCanaryValidationError(
      "The saved procedure is no longer strictly read-only.",
      "procedure_not_read_only",
    );
  }
  if (
    identity.principal.authorityMode === "explicit_grants" &&
    snapshot.toolBindings.some((binding) =>
      !identity.principal.toolGrantIds.includes(binding.toolId)
    )
  ) {
    throw new WorkflowScheduleCanaryValidationError(
      "The Agent no longer holds every reviewed read-only tool.",
      "agent_policy_changed",
    );
  }
  return Object.freeze({
    trigger,
    identity,
    snapshot,
    profile: readOnlyScheduleAgentProfile(identity, snapshot),
  });
}

function findReviewedProcedureSnapshot(
  procedure: Awaited<ReturnType<typeof listSavedProcedures>>[number],
  snapshotSha256: string,
) {
  for (const alias of procedure.aliases) {
    const snapshot = buildWorkflowProcedureSnapshot(procedure, alias);
    if (snapshot.snapshotSha256 === snapshotSha256) return snapshot;
  }
  return undefined;
}

function assertReadOnlyProcedure(
  bindings: readonly { toolId: string; input: Readonly<Record<string, unknown>> }[],
) {
  if (!bindings.length) {
    throw new WorkflowScheduleControlError(
      "Scheduled procedures require at least one exact read-only tool binding.",
      "not_read_only",
    );
  }
  for (const binding of bindings) {
    const tool = getGovernedTool(binding.toolId);
    if (
      !tool ||
      tool.status !== "active" ||
      tool.riskLevel !== 0 ||
      tool.approvalRequired ||
      governedToolOperationClass(tool, { ...binding.input }) !== "read_only"
    ) {
      throw new WorkflowScheduleControlError(
        `Tool ${binding.toolId} is not eligible for an unattended read-only schedule.`,
        "not_read_only",
      );
    }
  }
}

function readOnlyScheduleAgentProfile(
  identity: ResolvedAgentIdentityV1,
  snapshot: WorkflowProcedureSnapshot,
) {
  return Object.freeze({
    name: identity.definition.name,
    role: identity.definition.role,
    description: identity.definition.description,
    instructions: [
      identity.definition.instructions,
      "This occurrence is an unattended read-only canary. Use only the exact reviewed saved-procedure bindings. Never request, simulate, or execute a mutation.",
    ].filter(Boolean).join("\n\n"),
    persona: identity.definition.persona,
    modelPolicy: identity.definition.modelPolicy,
    autonomy: "assist" as const,
    approvalPolicy: "read_only" as const,
    memoryScope: identity.principal.memoryScope,
    toolIds: [...new Set(snapshot.toolBindings.map((binding) => binding.toolId))],
    skills: [],
  });
}

function scheduledProcedureGoal(
  snapshot: WorkflowProcedureSnapshot,
  scheduledFor: string,
) {
  return [
    `Run the reviewed saved procedure "${snapshot.id}" for the scheduled occurrence at ${scheduledFor}.`,
    `Use only its exact reviewed read-only bindings and satisfy the procedure's acceptance criteria.`,
    "Do not perform, propose, or request a mutation.",
  ].join(" ").slice(0, 4_000);
}

function scheduleFailureCode(error: unknown): WorkflowScheduleOccurrenceFailureCode {
  if (error instanceof WorkflowScheduleCanaryValidationError) {
    return error.failureCode;
  }
  return "workflow_enqueue_failed";
}

function workflowScheduleReviewSha256(input: {
  procedureSnapshotSha256: string;
  agentIdentityPinSha256: string;
  policyPinSha256: string;
  occurrenceBudgetSha256: string;
  reviewedAt: string;
}) {
  return canonicalJsonSha256({
    version: "workflow-schedule-review-v1",
    ...input,
  });
}

function buildWorkflowScheduleOccurrence(input: {
  trigger: WorkflowTriggerRecord;
  kind: WorkflowScheduleOccurrenceKind;
  status: "claimed" | "skipped";
  scheduledFor: string;
  evaluatedThrough: string;
  outcome: WorkflowScheduleShadowOutcome;
  occurrencesConsumed: number;
  occurrenceCount: number;
  nextDueAt?: string;
  now: string;
}): WorkflowScheduleOccurrenceRecord {
  const config = input.trigger.schedule!.config;
  const authorityMaterial = {
    tenantId: input.trigger.tenantId,
    ownerActorId: input.trigger.ownerActorId!,
    triggerId: input.trigger.id,
    kind: input.kind,
    scheduledFor: input.scheduledFor,
    configurationSha256: config.configSha256,
    agentIdentityPinSha256: config.agentIdentityPin.pinSha256,
    policyPinSha256: config.policyPinSha256,
    procedureSnapshotSha256: config.procedurePin.snapshotSha256,
    reviewedSnapshotSha256: config.procedurePin.reviewedSnapshotSha256,
    occurrenceBudgetSha256: canonicalJsonSha256(config.occurrenceBudget),
  };
  const authoritySha256 = canonicalJsonSha256(authorityMaterial);
  return Object.freeze({
    schemaVersion: 1,
    id: `workflow_schedule_occurrence_${authoritySha256.slice(0, 40)}`,
    tenantId: input.trigger.tenantId,
    ownerActorId: input.trigger.ownerActorId!,
    triggerId: input.trigger.id,
    kind: input.kind,
    status: input.status,
    scheduledFor: input.scheduledFor,
    evaluatedThrough: input.evaluatedThrough,
    outcome: input.outcome,
    occurrencesConsumed: input.occurrencesConsumed,
    occurrenceCount: input.occurrenceCount,
    nextDueAt: input.nextDueAt,
    configurationSha256: config.configSha256,
    agentIdentityPinSha256: config.agentIdentityPin.pinSha256,
    policyPinSha256: config.policyPinSha256,
    procedureSnapshotSha256: config.procedurePin.snapshotSha256,
    reviewedSnapshotSha256: config.procedurePin.reviewedSnapshotSha256,
    occurrenceBudgetSha256: canonicalJsonSha256(config.occurrenceBudget),
    authoritySha256,
    attemptCount: 0,
    completedAt: input.status === "skipped" ? input.now : undefined,
    createdAt: input.now,
    updatedAt: input.now,
  });
}

function minuteTimestamp(value: string) {
  const timestamp = requireTimestamp(value, "schedule occurrence time");
  return new Date(Math.floor(timestamp / 60_000) * 60_000).toISOString();
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
    replacesTriggerId: trigger.replacesTriggerId || null,
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
    replacesTriggerId: row.replaces_trigger_id
      ? String(row.replaces_trigger_id)
      : undefined,
    replacedByTriggerId: row.replaced_by_trigger_id
      ? String(row.replaced_by_trigger_id)
      : undefined,
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

function workflowScheduleOccurrenceFromRow(
  row: Record<string, unknown>,
): WorkflowScheduleOccurrenceRecord {
  const status = normalizeScheduleOccurrenceStatus(row.status);
  return Object.freeze({
    schemaVersion: 1,
    id: String(row.id),
    tenantId: normalizeTenantId(String(row.tenant_id || "")),
    ownerActorId: requiredActorId(String(row.owner_actor_id || "")),
    triggerId: String(row.trigger_id),
    kind: String(row.occurrence_kind) === "manual" ? "manual" : "scheduled",
    status,
    scheduledFor: normalizeDate(row.scheduled_for),
    evaluatedThrough: normalizeDate(row.evaluated_through),
    outcome: normalizeScheduleShadowOutcome(row.outcome),
    occurrencesConsumed: Number(row.occurrences_consumed || 0),
    occurrenceCount: Number(row.occurrence_count || 0),
    nextDueAt: row.next_due_at ? normalizeDate(row.next_due_at) : undefined,
    configurationSha256: String(row.configuration_sha256),
    agentIdentityPinSha256: String(row.agent_identity_pin_sha256),
    policyPinSha256: String(row.policy_pin_sha256),
    procedureSnapshotSha256: String(row.procedure_snapshot_sha256),
    reviewedSnapshotSha256: String(row.reviewed_snapshot_sha256),
    occurrenceBudgetSha256: String(row.occurrence_budget_sha256),
    authoritySha256: String(row.authority_sha256),
    workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
    queueJobId: row.queue_job_id ? String(row.queue_job_id) : undefined,
    failureCode: row.failure_code
      ? normalizeScheduleFailureCode(row.failure_code)
      : undefined,
    attemptCount: Number(row.attempt_count || 0),
    lastAttemptAt: row.last_attempt_at
      ? normalizeDate(row.last_attempt_at)
      : undefined,
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  });
}

function workflowScheduleOccurrenceReceiptFromRow(
  row: Record<string, unknown>,
): WorkflowScheduleOccurrenceReceiptV1 {
  return Object.freeze({
    schemaVersion: 1,
    id: String(row.id),
    tenantId: normalizeTenantId(String(row.tenant_id || "")),
    ownerActorId: requiredActorId(String(row.owner_actor_id || "")),
    triggerId: String(row.trigger_id),
    occurrenceId: String(row.occurrence_id),
    status: normalizeScheduleOccurrenceStatus(row.status),
    workflowRunId: row.workflow_run_id ? String(row.workflow_run_id) : undefined,
    queueJobId: row.queue_job_id ? String(row.queue_job_id) : undefined,
    failureCode: row.failure_code
      ? normalizeScheduleFailureCode(row.failure_code)
      : undefined,
    authoritySha256: String(row.authority_sha256),
    stateSha256: String(row.state_sha256),
    recordedAt: normalizeDate(row.recorded_at),
    receiptSha256: String(row.receipt_sha256),
  });
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

function normalizeScheduleOccurrenceStatus(
  value: unknown,
): WorkflowScheduleOccurrenceStatus {
  const status = String(value || "failed");
  if (
    status === "claimed" || status === "enqueued" ||
    status === "completed" || status === "skipped" || status === "failed"
  ) return status;
  return "failed";
}

function normalizeScheduleShadowOutcome(
  value: unknown,
): WorkflowScheduleShadowOutcome {
  const outcome = String(value || "exhausted");
  if (
    outcome === "due" || outcome === "missed_run_once" ||
    outcome === "missed_skipped" || outcome === "exhausted"
  ) return outcome;
  return "exhausted";
}

function normalizeScheduleFailureCode(
  value: unknown,
): WorkflowScheduleOccurrenceFailureCode {
  const code = String(value || "workflow_enqueue_failed");
  const allowed = new Set<WorkflowScheduleOccurrenceFailureCode>([
    "agent_identity_changed",
    "agent_policy_changed",
    "procedure_changed",
    "procedure_not_read_only",
    "occurrence_budget_changed",
    "workflow_enqueue_failed",
    "workflow_failed",
    "workflow_canceled",
  ]);
  return allowed.has(code as WorkflowScheduleOccurrenceFailureCode)
    ? code as WorkflowScheduleOccurrenceFailureCode
    : "workflow_enqueue_failed";
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
