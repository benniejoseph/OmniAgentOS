import { randomUUID } from "node:crypto";

import {
  activateAgentAdaptationV1,
  buildObservedAgentAdaptationV1,
  evaluateAgentAdaptationV1,
  parseAgentAdaptationV1,
  rollbackAgentAdaptationV1,
  type AgentAdaptationV1,
} from "@/lib/agents/adaptation-contracts";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

type AdaptationSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export const AGENT_ADAPTATION_EVENT_TYPES = Object.freeze({
  observed: "agent.adaptation.observed",
  evaluated: "agent.adaptation.evaluated",
  activated: "agent.adaptation.activated",
  rolledBack: "agent.adaptation.rolled_back",
} as const);

export type AgentAdaptationOwner = Readonly<{
  tenantId: string;
  actorId: string;
  canonicalActorId: string;
}>;

export type ActiveAgentAdaptationGuidance = Readonly<{
  adaptationId: string;
  activationVersion: number;
  guidance: string;
  confidence: number;
  evaluationSha256: string;
}>;

export class AgentAdaptationConflictError extends Error {
  readonly code = "agent_adaptation_conflict";

  constructor(message = "The Agent adaptation changed. Refresh and try again.") {
    super(message);
    this.name = "AgentAdaptationConflictError";
  }
}

export class AgentAdaptationUnavailableError extends Error {
  readonly code = "agent_adaptation_unavailable";

  constructor(message = "Agent adaptations require the canonical database authority.") {
    super(message);
    this.name = "AgentAdaptationUnavailableError";
  }
}

export async function listAgentAdaptations(
  agentId: string,
  owner: AgentAdaptationOwner,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return readAdaptations(getSql(), agentId, owner);
}

export async function observeAgentAdaptationEvidence(
  agentId: string,
  owner: AgentAdaptationOwner,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: AdaptationSql) => {
    const evidenceRows = await sql`
      SELECT id, agent_id, feedback, grounding, completed_at, started_at
      FROM omni_agent_runs
      WHERE tenant_id = ${owner.tenantId}
        AND owner_actor_id = ${owner.canonicalActorId}
        AND agent_id = ${agentId}
        AND status = 'completed'
        AND feedback->>'verdict' = 'needs_work'
        AND COALESCE(feedback->>'correction', '') <> ''
      ORDER BY completed_at DESC NULLS LAST, started_at DESC
      LIMIT 20
    `;
    for (const row of evidenceRows) {
      const observed = adaptationFromFeedbackRow(row, agentId, owner);
      const inserted = await sql`
        INSERT INTO omni_agent_adaptations (
          tenant_id, adaptation_id, agent_definition_id, owner_actor_id,
          owner_binding_sha256, state, lifecycle_revision, evidence,
          evidence_sha256, confidence, effect_kind, effect_payload,
          created_at, updated_at
        ) VALUES (
          ${owner.tenantId}, ${observed.adaptationId}, ${agentId},
          ${owner.canonicalActorId}, ${observed.ownerBindingSha256},
          ${observed.state}, ${observed.lifecycleRevision},
          ${observed.evidence}::jsonb, ${observed.evidenceSha256},
          ${observed.confidence}, ${observed.effect.kind},
          ${observed.effect}::jsonb, ${observed.createdAt}, ${observed.updatedAt}
        )
        ON CONFLICT (tenant_id, adaptation_id) DO NOTHING
        RETURNING *
      `;
      if (inserted[0]) {
        const persisted = adaptationFromRow(inserted[0]);
        await appendAdaptationEvent(
          sql,
          agentId,
          adaptationExecutionScope(owner, agentId, "observe"),
          AGENT_ADAPTATION_EVENT_TYPES.observed,
          {
            schemaVersion: 1,
            adaptationId: persisted.adaptationId,
            evidenceSha256: persisted.evidenceSha256,
            evidenceCount: persisted.evidence.length,
            confidence: persisted.confidence,
            effectKind: persisted.effect.kind,
            effectSha256: persisted.effect.effectSha256,
          },
        );
      }
    }
    return readAdaptations(sql, agentId, owner);
  }) as Promise<AgentAdaptationV1[]>;
}

export async function evaluateAgentAdaptation(
  agentId: string,
  adaptationId: string,
  definitionVersion: number,
  owner: AgentAdaptationOwner,
) {
  return transitionAgentAdaptation(
    agentId,
    adaptationId,
    definitionVersion,
    owner,
    "evaluate",
  );
}

export async function activateAgentAdaptation(
  agentId: string,
  adaptationId: string,
  definitionVersion: number,
  owner: AgentAdaptationOwner,
) {
  return transitionAgentAdaptation(
    agentId,
    adaptationId,
    definitionVersion,
    owner,
    "activate",
  );
}

export async function rollbackAgentAdaptation(
  agentId: string,
  adaptationId: string,
  definitionVersion: number,
  owner: AgentAdaptationOwner,
) {
  return transitionAgentAdaptation(
    agentId,
    adaptationId,
    definitionVersion,
    owner,
    "rollback",
  );
}

export async function getActiveAgentAdaptationGuidance(input: {
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
}): Promise<ActiveAgentAdaptationGuidance[]> {
  if (!hasDatabaseUrl()) return [];
  await ensureDatabaseSchema();
  const rows = await getSql()`
    SELECT *
    FROM omni_agent_adaptations
    WHERE tenant_id = ${input.tenantId}
      AND owner_actor_id = ${input.ownerActorId}
      AND agent_definition_id = ${input.agentId}
      AND state = 'active'
      AND evaluated_definition_version = ${input.definitionVersion}
    ORDER BY activation_version ASC
    LIMIT 10
  `;
  return rows.map(adaptationFromRow).map((adaptation) => ({
    adaptationId: adaptation.adaptationId,
    activationVersion: requiredVersion(adaptation.activationVersion),
    guidance: adaptation.effect.guidance,
    confidence: adaptation.confidence,
    evaluationSha256: adaptation.evaluation?.evaluationSha256 || "",
  }));
}

async function transitionAgentAdaptation(
  agentId: string,
  adaptationId: string,
  definitionVersion: number,
  owner: AgentAdaptationOwner,
  action: "evaluate" | "activate" | "rollback",
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: AdaptationSql) => {
    const current = await readAdaptationForUpdate(
      sql,
      agentId,
      adaptationId,
      owner,
    );
    if (
      action === "activate" &&
      current.evaluation?.definitionVersion !== definitionVersion
    ) {
      throw new AgentAdaptationConflictError(
        "This adaptation was evaluated for a different Agent release.",
      );
    }
    let next: AgentAdaptationV1;
    let eventType: (typeof AGENT_ADAPTATION_EVENT_TYPES)[keyof typeof AGENT_ADAPTATION_EVENT_TYPES];
    if (action === "evaluate") {
      next = evaluateAgentAdaptationV1(current, definitionVersion);
      eventType = AGENT_ADAPTATION_EVENT_TYPES.evaluated;
    } else if (action === "activate") {
      await sql`
        SELECT pg_advisory_xact_lock(
          hashtext(${owner.tenantId}),
          hashtext(${`${owner.canonicalActorId}:${agentId}`})
        )
      `;
      const versionRows = await sql`
        SELECT COALESCE(MAX(activation_version), 0) + 1 AS next_version
        FROM omni_agent_adaptations
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.canonicalActorId}
          AND agent_definition_id = ${agentId}
      `;
      next = activateAgentAdaptationV1(
        current,
        requiredVersion(versionRows[0]?.next_version),
      );
      eventType = AGENT_ADAPTATION_EVENT_TYPES.activated;
    } else {
      next = rollbackAgentAdaptationV1(current);
      eventType = AGENT_ADAPTATION_EVENT_TYPES.rolledBack;
    }
    const rows = await sql`
      UPDATE omni_agent_adaptations
      SET state = ${next.state},
          lifecycle_revision = ${next.lifecycleRevision},
          evaluation = ${next.evaluation}::jsonb,
          evaluation_sha256 = ${next.evaluation?.evaluationSha256 || null},
          evaluated_definition_version =
            ${next.evaluation?.definitionVersion || null},
          activation_version = ${next.activationVersion},
          updated_at = ${next.updatedAt},
          evaluated_at = ${next.evaluation?.evaluatedAt || null},
          activated_at = ${next.activatedAt},
          rolled_back_at = ${next.rolledBackAt}
      WHERE tenant_id = ${owner.tenantId}
        AND adaptation_id = ${adaptationId}
        AND agent_definition_id = ${agentId}
        AND owner_actor_id = ${owner.canonicalActorId}
        AND state = ${current.state}
        AND lifecycle_revision = ${current.lifecycleRevision}
      RETURNING *
    `;
    const persisted = adaptationFromRow(exactlyOne(rows));
    await appendAdaptationEvent(
      sql,
      agentId,
      adaptationExecutionScope(owner, agentId, action),
      eventType,
      adaptationEventPayload(persisted),
    );
    return readAdaptations(sql, agentId, owner);
  }) as Promise<AgentAdaptationV1[]>;
}

async function readAdaptations(
  sql: AdaptationSql,
  agentId: string,
  owner: AgentAdaptationOwner,
) {
  const rows = await sql`
    SELECT *
    FROM omni_agent_adaptations
    WHERE tenant_id = ${owner.tenantId}
      AND owner_actor_id = ${owner.canonicalActorId}
      AND agent_definition_id = ${agentId}
    ORDER BY created_at DESC, adaptation_id ASC
    LIMIT 100
  `;
  return rows.map(adaptationFromRow);
}

async function readAdaptationForUpdate(
  sql: AdaptationSql,
  agentId: string,
  adaptationId: string,
  owner: AgentAdaptationOwner,
) {
  const rows = await sql`
    SELECT *
    FROM omni_agent_adaptations
    WHERE tenant_id = ${owner.tenantId}
      AND adaptation_id = ${adaptationId}
      AND agent_definition_id = ${agentId}
      AND owner_actor_id = ${owner.canonicalActorId}
    LIMIT 1
    FOR UPDATE
  `;
  return adaptationFromRow(exactlyOne(rows));
}

function adaptationFromFeedbackRow(
  row: SqlRow,
  agentId: string,
  owner: AgentAdaptationOwner,
) {
  const feedback = objectValue(row.feedback);
  const correction = String(feedback.correction || "").trim().slice(0, 1_000);
  if (feedback.verdict !== "needs_work" || correction.length < 3) {
    throw new AgentAdaptationConflictError("Adaptation evidence is invalid.");
  }
  const grounding = objectValue(row.grounding);
  const groundingStatus = grounding.status === "verified"
    ? "verified" as const
    : "not_required" as const;
  const sourceId = String(row.id);
  const observedAt = timestamp(feedback.updatedAt || row.completed_at || row.started_at);
  const sourceSha256 = sourceContractSha256({
    sourceId,
    agentId,
    verdict: feedback.verdict,
    correctionSha256: sourceContractSha256(correction),
    groundingStatus,
    observedAt,
  });
  return buildObservedAgentAdaptationV1({
    tenantId: owner.tenantId,
    ownerActorId: owner.canonicalActorId,
    agentId,
    evidence: [{
      evidenceId: `run-feedback:${sourceId}`,
      kind: "run_feedback",
      sourceId,
      sourceSha256,
      verdict: "needs_work",
      groundingStatus,
      observedAt,
    }],
    guidance: correction,
    confidence: groundingStatus === "verified" ? 0.95 : 0.85,
    observedAt,
  });
}

function adaptationFromRow(row: SqlRow) {
  const evaluation = row.evaluation === null || row.evaluation === undefined
    ? null
    : objectValue(row.evaluation);
  if (
    evaluation &&
    evaluation.evaluationSha256 !== row.evaluation_sha256
  ) throw new AgentAdaptationConflictError();
  return parseAgentAdaptationV1({
    schemaVersion: Number(row.schema_version),
    version: "p7.6-agent-adaptation:1",
    adaptationId: row.adaptation_id,
    agentId: row.agent_definition_id,
    ownerBindingSha256: row.owner_binding_sha256,
    state: row.state,
    lifecycleRevision: Number(row.lifecycle_revision),
    evidence: row.evidence,
    evidenceSha256: row.evidence_sha256,
    confidence: Number(row.confidence),
    effect: row.effect_payload,
    evaluation,
    activationVersion: nullableVersion(row.activation_version),
    activatedAt: nullableTimestamp(row.activated_at),
    rolledBackAt: nullableTimestamp(row.rolled_back_at),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function adaptationEventPayload(adaptation: AgentAdaptationV1) {
  return {
    schemaVersion: 1,
    adaptationId: adaptation.adaptationId,
    lifecycleRevision: adaptation.lifecycleRevision,
    evidenceSha256: adaptation.evidenceSha256,
    confidence: adaptation.confidence,
    effectKind: adaptation.effect.kind,
    effectSha256: adaptation.effect.effectSha256,
    evaluationSha256: adaptation.evaluation?.evaluationSha256,
    definitionVersion: adaptation.evaluation?.definitionVersion,
    verdict: adaptation.evaluation?.verdict,
    activationVersion: adaptation.activationVersion,
  };
}

function appendAdaptationEvent(
  sql: AdaptationSql,
  agentId: string,
  executionScope: ExecutionScope,
  type: (typeof AGENT_ADAPTATION_EVENT_TYPES)[keyof typeof AGENT_ADAPTATION_EVENT_TYPES],
  payload: Record<string, unknown>,
) {
  const eventRevision = payload.activationVersion || payload.lifecycleRevision || 0;
  return appendScopedDomainEvent({
    id: `${type}:${String(payload.adaptationId)}:${String(eventRevision)}`,
    streamId: `agent:${agentId}`,
    type,
    payload,
    executionScope,
  }, { sql });
}

function adaptationExecutionScope(
  owner: AgentAdaptationOwner,
  agentId: string,
  action: string,
) {
  return createExecutionScope({
    tenantId: owner.tenantId,
    initiatingActorId: owner.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: owner.canonicalActorId,
    correlationId: `agent-adaptation:${agentId}:${action}:${randomUUID()}`,
    purpose: `agent.adaptation.${action}.v1`,
  });
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new AgentAdaptationUnavailableError();
}

function exactlyOne(rows: SqlRow[]) {
  if (rows.length !== 1) throw new AgentAdaptationConflictError();
  return rows[0];
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AgentAdaptationConflictError();
  }
  return parsed;
}

function nullableVersion(value: unknown) {
  return value === null || value === undefined ? null : requiredVersion(value);
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new AgentAdaptationConflictError();
  return date.toISOString();
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : timestamp(value);
}
