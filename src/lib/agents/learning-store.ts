import "server-only";

import {
  buildAgentLearningCycleV1,
  buildAgentLearningObservationV1,
  agentDailyLearningStatusV1Schema,
  parseAgentLearningCycleV1,
  type AgentDailyLearningStatusV1,
  type AgentLearningCycleV1,
  type AgentLearningHighWaterV1,
  type AgentLearningObservationV1,
} from "@/lib/agents/learning-contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

type LearningSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export const AGENT_LEARNING_EVENT_TYPES = Object.freeze({
  dailyCycleCompleted: "agent.learning.daily_cycle.completed",
} as const);

export type AgentLearningTarget = Readonly<{
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  definitionSha256: string;
  timezone: string;
  localDate: string;
}>;

export type AgentLearningCycleStoreResult = Readonly<{
  status: "completed" | "duplicate";
  cycle: AgentLearningCycleV1;
}>;

export async function readAgentDailyLearningStatus(input: {
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  definitionSha256: string;
}): Promise<AgentDailyLearningStatusV1> {
  const target = normalizeStatusTarget(input);
  const projectedAt = new Date().toISOString();
  if (!hasDatabaseUrl()) {
    return agentDailyLearningStatusV1Schema.parse({
      schemaVersion: 1,
      version: "agent-daily-learning-status:1",
      agentId: target.agentId,
      definitionVersion: target.definitionVersion,
      projectedAt,
      availability: "canonical_store_unavailable",
      latestCompletedDay: null,
      pendingReviewedAdaptationCount: 0,
      contentIncluded: false,
      privateReasoningIncluded: false,
      authorityImpact: "none",
    });
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    target.tenantId,
    [target.ownerActorId],
    () => getSql().transaction(async (sql: LearningSql) => {
      const cycleRows = await sql`
        SELECT cycle.*,
          COALESCE((
            SELECT COUNT(*)::int
            FROM omni_agent_learning_observations observation
            WHERE observation.tenant_id = cycle.tenant_id
              AND observation.owner_actor_id = cycle.owner_actor_id
              AND observation.logical_agent_id = cycle.logical_agent_id
              AND observation.definition_version = cycle.definition_version
              AND observation.definition_sha256 = cycle.definition_sha256
              AND observation.has_correction = TRUE
              AND (
                observation.observed_at AT TIME ZONE cycle.timezone
              )::date = cycle.local_date
          ), 0)::int AS explicit_correction_count
        FROM omni_agent_learning_cycles cycle
        WHERE cycle.tenant_id = ${target.tenantId}
          AND cycle.owner_actor_id = ${target.ownerActorId}
          AND cycle.logical_agent_id = ${target.agentId}
          AND cycle.definition_version = ${target.definitionVersion}
          AND cycle.definition_sha256 = ${target.definitionSha256}
        ORDER BY cycle.local_date DESC, cycle.completed_at DESC,
          cycle.cycle_id COLLATE "C" DESC
        LIMIT 1
      `;
      const expectedOwnerBindingSha256 = sourceContractSha256({
        tenantId: target.tenantId,
        ownerActorId: target.ownerActorId,
        agentId: target.agentId,
      });
      const latestRow = cycleRows[0];
      let latestCompletedDay: AgentDailyLearningStatusV1["latestCompletedDay"] = null;
      if (latestRow) {
        const cycle = cycleFromRow(latestRow);
        if (
          cycle.ownerBindingSha256 !== expectedOwnerBindingSha256 ||
          cycle.agentId !== target.agentId ||
          cycle.definitionVersion !== target.definitionVersion ||
          cycle.definitionSha256 !== target.definitionSha256
        ) {
          throw new Error("Agent learning status scope integrity is invalid.");
        }
        latestCompletedDay = Object.freeze({
          localDate: cycle.localDate,
          timezone: cycle.timezone,
          completedAt: cycle.completedAt,
          observationsReviewed: cycle.observationCount,
          explicitCorrectionCount: boundedCount(latestRow.explicit_correction_count),
          actionableEvidenceCount: cycle.actionableEvidenceCount,
          outcome: cycle.outcome,
        });
      }

      const adaptationRows = await sql`
        SELECT COUNT(*)::int AS pending_count,
          COUNT(*) FILTER (
            WHERE owner_binding_sha256 <> ${expectedOwnerBindingSha256}
          )::int AS invalid_owner_count
        FROM omni_agent_adaptations
        WHERE tenant_id = ${target.tenantId}
          AND owner_actor_id = ${target.ownerActorId}
          AND agent_definition_id = ${target.agentId}
          AND observed_definition_version = ${target.definitionVersion}
          AND evaluated_definition_version = ${target.definitionVersion}
          AND state = 'evaluated'
          AND evaluation->>'verdict' = 'passed'
      `;
      if (boundedCount(adaptationRows[0]?.invalid_owner_count) > 0) {
        throw new Error("Agent adaptation status scope integrity is invalid.");
      }
      return agentDailyLearningStatusV1Schema.parse({
        schemaVersion: 1,
        version: "agent-daily-learning-status:1",
        agentId: target.agentId,
        definitionVersion: target.definitionVersion,
        projectedAt,
        availability: "ready",
        latestCompletedDay,
        pendingReviewedAdaptationCount: boundedCount(
          adaptationRows[0]?.pending_count,
        ),
        contentIncluded: false,
        privateReasoningIncluded: false,
        authorityImpact: "none",
      });
    }) as Promise<AgentDailyLearningStatusV1>,
  );
}

export async function listDueAgentLearningTargets(input: {
  tenantId: string;
  now: string;
  limit?: number;
  systemMaintenance?: boolean;
}): Promise<AgentLearningTarget[]> {
  if (!hasDatabaseUrl()) return [];
  await ensureDatabaseSchema();
  const limit = Math.min(Math.max(input.limit || 20, 1), 100);
  const readTargets = () => getSql()`
    WITH identity_bound_runs AS (
      SELECT
        run.owner_actor_id,
        run.agent_id,
        (identity_event.payload->>'definitionVersion')::bigint
          AS definition_version,
        identity_event.payload->>'definitionSha256' AS definition_sha256,
        COALESCE(valid_timezone.name, 'UTC') AS timezone,
        COALESCE(
          NULLIF(run.feedback->>'updatedAt', '')::timestamptz,
          run.completed_at,
          run.started_at
        ) AS observed_at
      FROM omni_agent_runs run
      JOIN omni_events identity_event
        ON identity_event.tenant_id = run.tenant_id
        AND identity_event.stream_id = 'run:' || run.id
        AND identity_event.type = 'run.agent_identity.bound'
      LEFT JOIN omni_today_preferences preference
        ON preference.tenant_id = run.tenant_id
        AND preference.actor_id = run.owner_actor_id
      LEFT JOIN pg_timezone_names valid_timezone
        ON valid_timezone.name = preference.timezone
      WHERE run.tenant_id = ${input.tenantId}
        AND run.status IN ('completed', 'failed', 'canceled')
        AND run.owner_actor_id IS NOT NULL
        AND identity_event.payload->>'tenantId' = run.tenant_id
        AND identity_event.payload->>'actorId' = run.owner_actor_id
        AND identity_event.payload->>'logicalAgentId' = run.agent_id
        AND identity_event.payload->>'definitionSha256' ~ '^[a-f0-9]{64}$'
        AND COALESCE(
          NULLIF(run.feedback->>'updatedAt', '')::timestamptz,
          run.completed_at,
          run.started_at
        ) >= ${input.now}::timestamptz - INTERVAL '32 days'
    ), due AS (
      SELECT *,
        (observed_at AT TIME ZONE timezone)::date::text AS local_date,
        (${input.now}::timestamptz AT TIME ZONE timezone)::date
          AS current_local_date
      FROM identity_bound_runs
    )
    SELECT DISTINCT ON (
      owner_actor_id, agent_id, definition_version, definition_sha256,
      timezone, local_date
    )
      owner_actor_id, agent_id, definition_version, definition_sha256,
      timezone, local_date
    FROM due
    WHERE local_date::date < current_local_date
      AND NOT EXISTS (
        SELECT 1
        FROM omni_agent_learning_cycles cycle
        WHERE cycle.tenant_id = ${input.tenantId}
          AND cycle.owner_actor_id = due.owner_actor_id
          AND cycle.logical_agent_id = due.agent_id
          AND cycle.definition_version = due.definition_version
          AND cycle.definition_sha256 = due.definition_sha256
          AND cycle.timezone = due.timezone
          AND cycle.local_date = due.local_date::date
      )
    ORDER BY
      owner_actor_id COLLATE "C", agent_id COLLATE "C",
      definition_version, definition_sha256 COLLATE "C",
      timezone COLLATE "C", local_date
    LIMIT ${limit}
  `;
  const rows = input.systemMaintenance
    ? await runWithDatabaseSystemScope(
        "Discover identity-bound Agent runs due for daily learning evidence.",
        readTargets,
      )
    : await readTargets();
  return rows.map((row) => targetFromRow(row, input.tenantId));
}

export async function completeAgentLearningCycle(input: {
  target: AgentLearningTarget;
  executingPrincipalType: "user" | "system";
  executingPrincipalId: string;
  recordedAt: string;
}): Promise<AgentLearningCycleStoreResult> {
  if (!hasDatabaseUrl()) {
    throw new Error("Daily Agent learning requires the canonical database.");
  }
  await ensureDatabaseSchema();
  const target = normalizeTarget(input.target);
  const recordedAt = timestamp(input.recordedAt);
  return runWithDatabaseActorScope(
    target.tenantId,
    [target.ownerActorId],
    () => getSql().transaction(async (sql: LearningSql) => {
      const existing = await readExactCycle(sql, target);
      if (existing) {
        return Object.freeze({ status: "duplicate" as const, cycle: existing });
      }
      const runRows = await readRunEvidence(sql, target);
      const observations = runRows.map((row) => observationFromRunRow({
        row,
        target,
        recordedAt,
      }));
      for (const observation of observations) {
        await insertObservation(sql, target, observation);
      }
      const previousHighWater = await readPreviousHighWater(sql, target);
      const cycle = buildAgentLearningCycleV1({
        tenantId: target.tenantId,
        ownerActorId: target.ownerActorId,
        agentId: target.agentId,
        definitionVersion: target.definitionVersion,
        definitionSha256: target.definitionSha256,
        timezone: target.timezone,
        localDate: target.localDate,
        previousHighWater,
        observations,
        completedAt: recordedAt,
      });
      const inserted = await insertCycle(sql, target, cycle);
      if (!inserted) {
        const duplicate = await readExactCycle(sql, target);
        if (!duplicate) {
          throw new Error("Agent learning cycle did not settle idempotently.");
        }
        return Object.freeze({ status: "duplicate" as const, cycle: duplicate });
      }
      await appendScopedDomainEvent({
        id: `agent-learning-daily-completed:${cycle.cycleId}`,
        streamId: `agent:${cycle.agentId}`,
        type: AGENT_LEARNING_EVENT_TYPES.dailyCycleCompleted,
        executionScope: createExecutionScope({
          tenantId: target.tenantId,
          initiatingActorId: target.ownerActorId,
          executingPrincipalType: input.executingPrincipalType,
          executingPrincipalId: requiredText(input.executingPrincipalId),
          correlationId: cycle.cycleId,
          causationId: cycle.cycleId,
          contextGrantIds: [],
          capabilityGrantIds: [],
          purpose: "agent.learning.daily_evidence.v1",
        }),
        payload: cycleEventPayload(cycle),
      }, { sql });
      return Object.freeze({ status: "completed" as const, cycle });
    }) as Promise<AgentLearningCycleStoreResult>,
  );
}

async function readRunEvidence(sql: LearningSql, target: AgentLearningTarget) {
  return sql`
    SELECT DISTINCT ON (run.id)
      run.id, run.status, run.feedback, run.grounding,
      identity_event.payload->>'pinSha256' AS identity_pin_sha256,
      COALESCE(
        NULLIF(run.feedback->>'updatedAt', '')::timestamptz,
        run.completed_at,
        run.started_at
      ) AS observed_at
    FROM omni_agent_runs run
    JOIN omni_events identity_event
      ON identity_event.tenant_id = run.tenant_id
      AND identity_event.stream_id = 'run:' || run.id
      AND identity_event.type = 'run.agent_identity.bound'
    WHERE run.tenant_id = ${target.tenantId}
      AND run.owner_actor_id = ${target.ownerActorId}
      AND run.agent_id = ${target.agentId}
      AND run.status IN ('completed', 'failed', 'canceled')
      AND identity_event.payload->>'tenantId' = ${target.tenantId}
      AND identity_event.payload->>'actorId' = ${target.ownerActorId}
      AND identity_event.payload->>'logicalAgentId' = ${target.agentId}
      AND (identity_event.payload->>'definitionVersion')::bigint =
        ${target.definitionVersion}
      AND identity_event.payload->>'definitionSha256' =
        ${target.definitionSha256}
      AND (
        COALESCE(
          NULLIF(run.feedback->>'updatedAt', '')::timestamptz,
          run.completed_at,
          run.started_at
        ) AT TIME ZONE ${target.timezone}
      )::date = ${target.localDate}::date
    ORDER BY run.id COLLATE "C", identity_event.seq DESC
    LIMIT 1000
  `;
}

function observationFromRunRow(input: {
  row: SqlRow;
  target: AgentLearningTarget;
  recordedAt: string;
}) {
  const feedback = objectValue(input.row.feedback);
  const verdict = feedback.verdict === "useful" || feedback.verdict === "needs_work"
    ? feedback.verdict
    : undefined;
  const correction = typeof feedback.correction === "string"
    ? feedback.correction.trim()
    : "";
  const status = String(input.row.status || "");
  const outcome: AgentLearningObservationV1["outcome"] = status === "failed"
    ? "failed"
    : status === "canceled"
      ? "canceled"
      : verdict || "completed_unreviewed";
  const grounding = objectValue(input.row.grounding);
  const groundingStatus: AgentLearningObservationV1["groundingStatus"] =
    grounding.status === "verified"
      ? "verified"
      : Object.keys(grounding).length > 0
        ? "not_verified"
        : "not_required";
  const observedAt = timestamp(input.row.observed_at);
  const sourceId = requiredText(input.row.id);
  const identityPinSha256 = requiredSha256(input.row.identity_pin_sha256);
  const sourceSha256 = sourceContractSha256({
    sourceId,
    status,
    verdict: verdict || "unreviewed",
    hasCorrection: Boolean(correction),
    correctionSha256: correction ? sourceContractSha256(correction) : null,
    groundingStatus,
    observedAt,
    identityPinSha256,
  });
  return buildAgentLearningObservationV1({
    tenantId: input.target.tenantId,
    ownerActorId: input.target.ownerActorId,
    agentId: input.target.agentId,
    definitionVersion: input.target.definitionVersion,
    definitionSha256: input.target.definitionSha256,
    sourceId,
    sourceSha256,
    outcome,
    groundingStatus,
    hasCorrection: Boolean(correction),
    observedAt,
    recordedAt: input.recordedAt,
  });
}

async function insertObservation(
  sql: LearningSql,
  target: AgentLearningTarget,
  observation: AgentLearningObservationV1,
) {
  await sql`
    INSERT INTO omni_agent_learning_observations (
      schema_version, observation_id, tenant_id, owner_actor_id,
      owner_binding_sha256, logical_agent_id, definition_version,
      definition_sha256, source_kind, source_id, source_sha256, outcome,
      grounding_status, has_correction, actionable, observed_at, recorded_at,
      content_included, model_invoked, authority_impact
    ) VALUES (
      ${observation.schemaVersion}, ${observation.observationId},
      ${target.tenantId}, ${target.ownerActorId},
      ${observation.ownerBindingSha256}, ${observation.agentId},
      ${observation.definitionVersion}, ${observation.definitionSha256},
      ${observation.sourceKind}, ${observation.sourceId},
      ${observation.sourceSha256}, ${observation.outcome},
      ${observation.groundingStatus}, ${observation.hasCorrection},
      ${observation.actionable}, ${observation.observedAt},
      ${observation.recordedAt}, ${observation.contentIncluded},
      ${observation.modelInvoked}, ${observation.authorityImpact}
    )
    ON CONFLICT (tenant_id, owner_actor_id, observation_id) DO NOTHING
  `;
}

async function insertCycle(
  sql: LearningSql,
  target: AgentLearningTarget,
  cycle: AgentLearningCycleV1,
) {
  const rows = await sql`
    INSERT INTO omni_agent_learning_cycles (
      schema_version, cycle_id, tenant_id, owner_actor_id,
      owner_binding_sha256, logical_agent_id, definition_version,
      definition_sha256, timezone, local_date,
      previous_high_water_at, previous_high_water_observation_id,
      high_water_at, high_water_observation_id,
      observation_count, useful_evidence_count, needs_work_evidence_count,
      unreviewed_evidence_count, failed_evidence_count,
      canceled_evidence_count, actionable_evidence_count,
      evidence_manifest_sha256, outcome, completed_at,
      content_included, model_invoked, behavior_changed, authority_impact,
      tool_authority_changed, context_authority_changed,
      budget_authority_changed, adaptation_activated, receipt_sha256
    ) VALUES (
      ${cycle.schemaVersion}, ${cycle.cycleId}, ${target.tenantId},
      ${target.ownerActorId}, ${cycle.ownerBindingSha256}, ${cycle.agentId},
      ${cycle.definitionVersion}, ${cycle.definitionSha256}, ${cycle.timezone},
      ${cycle.localDate}, ${cycle.previousHighWater?.observedAt || null},
      ${cycle.previousHighWater?.observationId || null},
      ${cycle.highWater?.observedAt || null},
      ${cycle.highWater?.observationId || null}, ${cycle.observationCount},
      ${cycle.usefulEvidenceCount}, ${cycle.needsWorkEvidenceCount},
      ${cycle.unreviewedEvidenceCount}, ${cycle.failedEvidenceCount},
      ${cycle.canceledEvidenceCount}, ${cycle.actionableEvidenceCount},
      ${cycle.evidenceManifestSha256}, ${cycle.outcome}, ${cycle.completedAt},
      ${cycle.contentIncluded}, ${cycle.modelInvoked}, ${cycle.behaviorChanged},
      ${cycle.authorityImpact}, ${cycle.toolAuthorityChanged},
      ${cycle.contextAuthorityChanged}, ${cycle.budgetAuthorityChanged},
      ${cycle.adaptationActivated}, ${cycle.receiptSha256}
    )
    ON CONFLICT (
      tenant_id, owner_actor_id, logical_agent_id, definition_version,
      timezone, local_date
    ) DO NOTHING
    RETURNING cycle_id
  `;
  return Boolean(rows[0]);
}

async function readExactCycle(
  sql: LearningSql,
  target: AgentLearningTarget,
) {
  const rows = await sql`
    SELECT *
    FROM omni_agent_learning_cycles
    WHERE tenant_id = ${target.tenantId}
      AND owner_actor_id = ${target.ownerActorId}
      AND logical_agent_id = ${target.agentId}
      AND definition_version = ${target.definitionVersion}
      AND definition_sha256 = ${target.definitionSha256}
      AND timezone = ${target.timezone}
      AND local_date = ${target.localDate}::date
    LIMIT 1
  `;
  if (!rows[0]) return undefined;
  const cycle = cycleFromRow(rows[0]);
  const expectedOwnerBindingSha256 = sourceContractSha256({
    tenantId: target.tenantId,
    ownerActorId: target.ownerActorId,
    agentId: target.agentId,
  });
  if (
    cycle.ownerBindingSha256 !== expectedOwnerBindingSha256 ||
    cycle.agentId !== target.agentId ||
    cycle.definitionVersion !== target.definitionVersion ||
    cycle.definitionSha256 !== target.definitionSha256 ||
    cycle.timezone !== target.timezone ||
    cycle.localDate !== target.localDate
  ) {
    throw new Error("Agent learning cycle scope integrity is invalid.");
  }
  return cycle;
}

async function readPreviousHighWater(
  sql: LearningSql,
  target: AgentLearningTarget,
): Promise<AgentLearningHighWaterV1 | null> {
  const rows = await sql`
    SELECT high_water_at, high_water_observation_id
    FROM omni_agent_learning_cycles
    WHERE tenant_id = ${target.tenantId}
      AND owner_actor_id = ${target.ownerActorId}
      AND logical_agent_id = ${target.agentId}
      AND definition_version = ${target.definitionVersion}
      AND definition_sha256 = ${target.definitionSha256}
      AND timezone = ${target.timezone}
      AND local_date < ${target.localDate}::date
      AND high_water_at IS NOT NULL
      AND high_water_observation_id IS NOT NULL
    ORDER BY local_date DESC, cycle_id COLLATE "C" DESC
    LIMIT 1
  `;
  return rows[0]
    ? Object.freeze({
        observedAt: timestamp(rows[0].high_water_at),
        observationId: requiredText(rows[0].high_water_observation_id),
      })
    : null;
}

function cycleFromRow(row: SqlRow) {
  return parseAgentLearningCycleV1({
    schemaVersion: Number(row.schema_version),
    version: "agent-learning-daily-cycle:1",
    cycleId: String(row.cycle_id),
    ownerBindingSha256: String(row.owner_binding_sha256),
    agentId: String(row.logical_agent_id),
    definitionVersion: Number(row.definition_version),
    definitionSha256: String(row.definition_sha256),
    timezone: String(row.timezone),
    localDate: dateOnly(row.local_date),
    previousHighWater: row.previous_high_water_at
      ? {
          observedAt: timestamp(row.previous_high_water_at),
          observationId: requiredText(row.previous_high_water_observation_id),
        }
      : null,
    highWater: row.high_water_at
      ? {
          observedAt: timestamp(row.high_water_at),
          observationId: requiredText(row.high_water_observation_id),
        }
      : null,
    observationCount: Number(row.observation_count),
    usefulEvidenceCount: Number(row.useful_evidence_count),
    needsWorkEvidenceCount: Number(row.needs_work_evidence_count),
    unreviewedEvidenceCount: Number(row.unreviewed_evidence_count),
    failedEvidenceCount: Number(row.failed_evidence_count),
    canceledEvidenceCount: Number(row.canceled_evidence_count),
    actionableEvidenceCount: Number(row.actionable_evidence_count),
    evidenceManifestSha256: String(row.evidence_manifest_sha256),
    outcome: row.outcome,
    completedAt: timestamp(row.completed_at),
    contentIncluded: Boolean(row.content_included),
    modelInvoked: Boolean(row.model_invoked),
    behaviorChanged: Boolean(row.behavior_changed),
    authorityImpact: row.authority_impact,
    toolAuthorityChanged: Boolean(row.tool_authority_changed),
    contextAuthorityChanged: Boolean(row.context_authority_changed),
    budgetAuthorityChanged: Boolean(row.budget_authority_changed),
    adaptationActivated: Boolean(row.adaptation_activated),
    receiptSha256: String(row.receipt_sha256),
  });
}

function cycleEventPayload(cycle: AgentLearningCycleV1) {
  return Object.freeze({
    schemaVersion: 1,
    cycleId: cycle.cycleId,
    agentId: cycle.agentId,
    definitionVersion: cycle.definitionVersion,
    definitionSha256: cycle.definitionSha256,
    timezone: cycle.timezone,
    localDate: cycle.localDate,
    observationCount: cycle.observationCount,
    actionableEvidenceCount: cycle.actionableEvidenceCount,
    evidenceManifestSha256: cycle.evidenceManifestSha256,
    receiptSha256: cycle.receiptSha256,
    outcome: cycle.outcome,
    contentIncluded: false,
    modelInvoked: false,
    behaviorChanged: false,
    authorityImpact: "none",
    toolAuthorityChanged: false,
    contextAuthorityChanged: false,
    budgetAuthorityChanged: false,
    adaptationActivated: false,
  });
}

function targetFromRow(row: SqlRow, tenantId: string): AgentLearningTarget {
  return normalizeTarget({
    tenantId,
    ownerActorId: String(row.owner_actor_id || ""),
    agentId: String(row.agent_id || ""),
    definitionVersion: Number(row.definition_version),
    definitionSha256: String(row.definition_sha256 || ""),
    timezone: String(row.timezone || "UTC"),
    localDate: dateOnly(row.local_date),
  });
}

function normalizeStatusTarget(input: {
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  definitionSha256: string;
}) {
  const definitionVersion = Number(input.definitionVersion);
  if (!Number.isSafeInteger(definitionVersion) || definitionVersion < 1) {
    throw new Error("Agent learning definition version is invalid.");
  }
  return Object.freeze({
    tenantId: requiredText(input.tenantId),
    ownerActorId: requiredText(input.ownerActorId),
    agentId: requiredText(input.agentId),
    definitionVersion,
    definitionSha256: requiredSha256(input.definitionSha256),
  });
}

function normalizeTarget(target: AgentLearningTarget): AgentLearningTarget {
  const timezone = normalizeTimezone(target.timezone);
  const localDate = dateOnly(target.localDate);
  const definitionVersion = Number(target.definitionVersion);
  if (!Number.isSafeInteger(definitionVersion) || definitionVersion < 1) {
    throw new Error("Agent learning definition version is invalid.");
  }
  return Object.freeze({
    tenantId: requiredText(target.tenantId),
    ownerActorId: requiredText(target.ownerActorId),
    agentId: requiredText(target.agentId),
    definitionVersion,
    definitionSha256: requiredSha256(target.definitionSha256),
    timezone,
    localDate,
  });
}

function normalizeTimezone(value: string) {
  const timezone = requiredText(value);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return timezone;
  } catch {
    throw new Error("Agent learning timezone is invalid.");
  }
}

function dateOnly(value: unknown) {
  const text = value instanceof Date
    ? value.toISOString().slice(0, 10)
    : String(value || "").slice(0, 10);
  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== text
  ) {
    throw new Error("Agent learning local date is invalid.");
  }
  return text;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Agent learning timestamp is invalid.");
  }
  return date.toISOString();
}

function requiredSha256(value: unknown) {
  const digest = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error("Agent learning digest is invalid.");
  }
  return digest;
}

function requiredText(value: unknown) {
  const text = String(value || "").trim();
  if (!text || text.length > 320 || text.includes("\0")) {
    throw new Error("Agent learning identifier is invalid.");
  }
  return text;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedCount(value: unknown) {
  const count = Number(value ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 10_000) {
    throw new Error("Agent learning status count is invalid.");
  }
  return count;
}
