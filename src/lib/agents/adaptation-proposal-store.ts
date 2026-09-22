import "server-only";

import {
  parseAgentAdaptationV1,
  type AgentAdaptationEvidenceV1,
  type AgentAdaptationV1,
} from "@/lib/agents/adaptation-contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

type ProposalSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export type AgentAdaptationProposalOwner = Readonly<{
  tenantId: string;
  actorId: string;
  canonicalActorId: string;
}>;

export type AgentAdaptationProposalTarget = Readonly<{
  actorId: string;
  agentId: string;
}>;

export type AgentAdaptationProposalEvidenceObservation = Readonly<{
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  evidence: AgentAdaptationEvidenceV1;
  summary: string;
}>;

export type AgentAdaptationProposalOutcome =
  | "held"
  | "model_failed"
  | "identity_drifted"
  | "runtime_drifted";

export async function listProactiveAgentAdaptationTargets(input: {
  tenantId: string;
  limit?: number;
}): Promise<AgentAdaptationProposalTarget[]> {
  if (!hasDatabaseUrl()) return [];
  await ensureDatabaseSchema();
  const limit = Math.min(Math.max(input.limit || 10, 1), 25);
  const rows = await getSql()`
    SELECT actor_id, agent_id
    FROM (
      SELECT run.owner_actor_id AS actor_id, run.agent_id
      FROM omni_agent_runs run
      WHERE run.tenant_id = ${input.tenantId}
        AND run.status = 'completed'
        AND run.feedback->>'verdict' = 'needs_work'
        AND COALESCE(run.feedback->>'correction', '') <> ''
      UNION
      SELECT project.actor_id, artifact.agent_id
      FROM omni_project_artifacts artifact
      JOIN omni_projects project
        ON project.tenant_id = artifact.tenant_id
        AND project.id = artifact.project_id
      WHERE artifact.tenant_id = ${input.tenantId}
        AND artifact.status = 'verified'
        AND artifact.verdict = 'needs_work'
        AND COALESCE(artifact.lesson, '') <> ''
      UNION
      SELECT task.owner_actor_id, task.delegate_agent_id
      FROM omni_delegation_tasks task
      WHERE task.tenant_id = ${input.tenantId}
        AND task.state = 'rejected'
      UNION
      SELECT occurrence.owner_actor_id,
        trigger.schedule_config #>> '{agentIdentityPin,logicalAgentId}'
      FROM omni_workflow_schedule_occurrences occurrence
      JOIN omni_workflow_triggers trigger
        ON trigger.tenant_id = occurrence.tenant_id
        AND trigger.id = occurrence.trigger_id
      WHERE occurrence.tenant_id = ${input.tenantId}
        AND occurrence.status = 'failed'
    ) candidates
    WHERE NULLIF(btrim(actor_id), '') IS NOT NULL
      AND NULLIF(btrim(agent_id), '') IS NOT NULL
    ORDER BY actor_id COLLATE "C", agent_id COLLATE "C"
    LIMIT ${limit}
  `;
  return rows.map((row) => Object.freeze({
    actorId: requiredText(row.actor_id),
    agentId: requiredText(row.agent_id),
  }));
}

export async function loadAgentAdaptationProposalEvidence(input: {
  owner: AgentAdaptationProposalOwner;
  agentId: string;
  definitionVersion: number;
}): Promise<AgentAdaptationProposalEvidenceObservation[]> {
  requireDatabase();
  await ensureDatabaseSchema();
  const actorIds = uniqueActorIds(input.owner);
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    actorIds,
    async () => {
      const sql = getSql();
      const [runRows, projectRows, delegationRows, scheduleRows] =
        await Promise.all([
          sql`
            SELECT run.id, run.feedback, run.grounding,
              COALESCE(
                run.feedback->>'updatedAt',
                run.completed_at::text,
                run.started_at::text
              ) AS observed_at
            FROM omni_agent_runs run
            JOIN omni_events identity_event
              ON identity_event.tenant_id = run.tenant_id
              AND identity_event.stream_id = 'run:' || run.id
              AND identity_event.type = 'run.agent_identity.bound'
            WHERE run.tenant_id = ${input.owner.tenantId}
              AND run.owner_actor_id = ${input.owner.canonicalActorId}
              AND run.agent_id = ${input.agentId}
              AND run.status = 'completed'
              AND run.feedback->>'verdict' = 'needs_work'
              AND COALESCE(run.feedback->>'correction', '') <> ''
              AND identity_event.payload->>'logicalAgentId' = ${input.agentId}
              AND (identity_event.payload->>'definitionVersion')::bigint =
                ${input.definitionVersion}
            ORDER BY run.completed_at DESC NULLS LAST, run.id COLLATE "C"
            LIMIT 12
          `,
          sql`
            SELECT artifact.id, artifact.verdict, artifact.lesson,
              artifact.reviewed_at, artifact.updated_at, artifact.status
            FROM omni_project_artifacts artifact
            JOIN omni_projects project
              ON project.tenant_id = artifact.tenant_id
              AND project.id = artifact.project_id
            JOIN omni_workflow_runs workflow
              ON workflow.tenant_id = artifact.tenant_id
              AND workflow.id = artifact.workflow_run_id
            WHERE artifact.tenant_id = ${input.owner.tenantId}
              AND project.actor_id IN (
                ${input.owner.actorId}, ${input.owner.canonicalActorId}
              )
              AND artifact.agent_id = ${input.agentId}
              AND artifact.status = 'verified'
              AND artifact.verdict IN ('useful', 'needs_work')
              AND workflow.input #>>
                '{metadata,agentIdentity,definition,logicalAgentId}' =
                ${input.agentId}
              AND (workflow.input #>>
                '{metadata,agentIdentity,definition,definitionVersion}')::bigint =
                ${input.definitionVersion}
            ORDER BY artifact.reviewed_at DESC NULLS LAST,
              artifact.id COLLATE "C"
            LIMIT 12
          `,
          sql`
            SELECT task_id, state, task, updated_at
            FROM omni_delegation_tasks
            WHERE tenant_id = ${input.owner.tenantId}
              AND owner_actor_id = ${input.owner.canonicalActorId}
              AND delegate_agent_id = ${input.agentId}
              AND delegate_definition_version = ${input.definitionVersion}
              AND state IN ('result_accepted', 'rejected')
            ORDER BY updated_at DESC, task_id COLLATE "C"
            LIMIT 12
          `,
          sql`
            SELECT occurrence.id, occurrence.status,
              occurrence.failure_code, occurrence.authority_sha256,
              occurrence.updated_at
            FROM omni_workflow_schedule_occurrences occurrence
            JOIN omni_workflow_triggers trigger
              ON trigger.tenant_id = occurrence.tenant_id
              AND trigger.id = occurrence.trigger_id
            WHERE occurrence.tenant_id = ${input.owner.tenantId}
              AND occurrence.owner_actor_id = ${input.owner.canonicalActorId}
              AND occurrence.status IN ('completed', 'failed')
              AND trigger.schedule_config #>>
                '{agentIdentityPin,logicalAgentId}' = ${input.agentId}
              AND (trigger.schedule_config #>>
                '{agentIdentityPin,definitionVersion}')::bigint =
                ${input.definitionVersion}
            ORDER BY occurrence.updated_at DESC, occurrence.id COLLATE "C"
            LIMIT 12
          `,
        ]);
      return [
        ...runRows.map((row) => runObservation(row, input)),
        ...projectRows.map((row) => projectObservation(row, input)),
        ...delegationRows.map((row) => delegationObservation(row, input)),
        ...scheduleRows.map((row) => scheduleObservation(row, input)),
      ];
    },
  );
}

export async function hasAgentAdaptationEvidenceSet(input: {
  owner: AgentAdaptationProposalOwner;
  agentId: string;
  definitionVersion: number;
  evidenceSha256: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    uniqueActorIds(input.owner),
    async () => {
      const rows = await getSql()`
        SELECT adaptation_id
        FROM omni_agent_adaptations
        WHERE tenant_id = ${input.owner.tenantId}
          AND owner_actor_id = ${input.owner.canonicalActorId}
          AND agent_definition_id = ${input.agentId}
          AND observed_definition_version = ${input.definitionVersion}
          AND evidence_sha256 = ${input.evidenceSha256}
        LIMIT 1
      `;
      return Boolean(rows[0]);
    },
  );
}

export async function persistProactiveAgentAdaptationProposal(input: {
  owner: AgentAdaptationProposalOwner;
  adaptation: AgentAdaptationV1;
}): Promise<"inserted" | "duplicate"> {
  requireDatabase();
  await ensureDatabaseSchema();
  const adaptation = parseAgentAdaptationV1(input.adaptation);
  const expectedOwnerBindingSha256 = sourceContractSha256({
    tenantId: input.owner.tenantId,
    ownerActorId: input.owner.canonicalActorId,
    agentId: adaptation.agentId,
  });
  if (
    adaptation.state !== "observed" ||
    !adaptation.effect.proposalReview ||
    adaptation.ownerBindingSha256 !== expectedOwnerBindingSha256
  ) {
    throw new Error("The proactive adaptation proposal boundary is invalid.");
  }
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    uniqueActorIds(input.owner),
    () => getSql().transaction(async (sql: ProposalSql) => {
      const rows = await sql`
        INSERT INTO omni_agent_adaptations (
          tenant_id, adaptation_id, agent_definition_id, owner_actor_id,
          owner_binding_sha256, observed_definition_version,
          state, lifecycle_revision, evidence,
          evidence_sha256, confidence, effect_kind, effect_payload,
          created_at, updated_at
        ) VALUES (
          ${input.owner.tenantId}, ${adaptation.adaptationId},
          ${adaptation.agentId}, ${input.owner.canonicalActorId},
          ${adaptation.ownerBindingSha256},
          ${adaptation.observedDefinitionVersion}, ${adaptation.state},
          ${adaptation.lifecycleRevision}, ${adaptation.evidence}::jsonb,
          ${adaptation.evidenceSha256}, ${adaptation.confidence},
          ${adaptation.effect.kind}, ${adaptation.effect}::jsonb,
          ${adaptation.createdAt}, ${adaptation.updatedAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING adaptation_id
      `;
      if (!rows[0]) return "duplicate" as const;
      const review = adaptation.effect.proposalReview!;
      await appendScopedDomainEvent({
        id: `agent-adaptation-proposed:${adaptation.adaptationId}`,
        streamId: `agent:${adaptation.agentId}`,
        type: "agent.adaptation.proposed",
        executionScope: proposalExecutionScope({
          owner: input.owner,
          agentId: adaptation.agentId,
          sentinelPrincipalId: review.sentinelRuntime.principalId,
          correlationId: `agent-adaptation-proposal:${adaptation.adaptationId}`,
          causationId: adaptation.adaptationId,
        }),
        payload: {
          schemaVersion: 1,
          adaptationId: adaptation.adaptationId,
          targetDefinitionVersion:
            review.targetIdentity.definitionVersion,
          targetDefinitionSha256: review.targetIdentity.definitionSha256,
          sentinelDefinitionVersion:
            review.sentinelRuntime.definitionVersion,
          sentinelDefinitionSha256: review.sentinelRuntime.definitionSha256,
          sentinelProvider: review.sentinelRuntime.provider,
          sentinelModel: review.sentinelRuntime.model,
          sentinelTier: review.sentinelRuntime.tier,
          assignmentConfigurationSha256:
            review.sentinelRuntime.assignmentConfigurationSha256,
          evidenceSetSha256: review.evidenceSetSha256,
          proposalSha256: review.proposalSha256,
          shadowComparisonSha256: review.shadowComparisonSha256,
          reviewSha256: review.review.reviewSha256,
          reviewScore: review.review.score,
          authorityImpact: "none",
          activationAuthorityGranted: false,
          activeGuidanceChanged: false,
        },
      }, { sql });
      return "inserted" as const;
    }),
  );
}

export async function recordAgentAdaptationProposalOutcome(input: {
  owner: AgentAdaptationProposalOwner;
  agentId: string;
  sentinelPrincipalId: string;
  cycleId: string;
  outcome: AgentAdaptationProposalOutcome;
  targetDefinitionVersion: number;
  targetDefinitionSha256: string;
  sentinelDefinitionVersion: number;
  sentinelDefinitionSha256: string;
  evidenceSetSha256: string;
  shadowComparisonSha256?: string;
  detailSha256: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  const eventType = `agent.adaptation.proposal.${input.outcome}`;
  const payload = {
    schemaVersion: 1,
    cycleId: input.cycleId,
    outcome: input.outcome,
    targetDefinitionVersion: input.targetDefinitionVersion,
    targetDefinitionSha256: input.targetDefinitionSha256,
    sentinelDefinitionVersion: input.sentinelDefinitionVersion,
    sentinelDefinitionSha256: input.sentinelDefinitionSha256,
    evidenceSetSha256: input.evidenceSetSha256,
    shadowComparisonSha256: input.shadowComparisonSha256 || null,
    detailSha256: input.detailSha256,
    authorityImpact: "none",
    adaptationCreated: false,
    activationAuthorityGranted: false,
    activeGuidanceChanged: false,
  };
  const eventId = `${eventType}:${sourceContractSha256(payload)}`;
  return runWithDatabaseActorScope(
    input.owner.tenantId,
    uniqueActorIds(input.owner),
    () => appendScopedDomainEvent({
      id: eventId,
      streamId: `agent:${input.agentId}`,
      type: eventType,
      executionScope: proposalExecutionScope({
        owner: input.owner,
        agentId: input.agentId,
        sentinelPrincipalId: input.sentinelPrincipalId,
        correlationId: input.cycleId,
        causationId: eventId,
      }),
      payload,
    }),
  );
}

function runObservation(
  row: SqlRow,
  input: Parameters<typeof loadAgentAdaptationProposalEvidence>[0],
) {
  const feedback = objectValue(row.feedback);
  const correction = boundedSummary(feedback.correction);
  const observedAt = timestamp(row.observed_at);
  const grounding = objectValue(row.grounding);
  const groundingStatus = grounding.status === "verified"
    ? "verified" as const
    : "not_required" as const;
  return observation(input, {
    evidenceId: `run-feedback:${requiredText(row.id)}`,
    kind: "run_feedback",
    sourceId: requiredText(row.id),
    sourceSha256: sourceContractSha256({
      sourceId: requiredText(row.id),
      correctionSha256: sourceContractSha256(correction),
      groundingStatus,
      observedAt,
    }),
    verdict: "needs_work",
    groundingStatus,
    observedAt,
  }, correction);
}

function projectObservation(
  row: SqlRow,
  input: Parameters<typeof loadAgentAdaptationProposalEvidence>[0],
) {
  const sourceId = requiredText(row.id);
  const verdict = row.verdict === "useful" ? "useful" as const : "needs_work" as const;
  const observedAt = timestamp(row.reviewed_at || row.updated_at);
  const lesson = boundedSummary(row.lesson || `${verdict} verified project outcome`);
  return observation(input, {
    evidenceId: `project-artifact:${sourceId}`,
    kind: "project_artifact",
    sourceId,
    sourceSha256: sourceContractSha256({
      sourceId,
      verdict,
      lessonSha256: sourceContractSha256(lesson),
      status: "verified",
      observedAt,
    }),
    verdict,
    groundingStatus: "verified",
    observedAt,
  }, lesson);
}

function delegationObservation(
  row: SqlRow,
  input: Parameters<typeof loadAgentAdaptationProposalEvidence>[0],
) {
  const sourceId = requiredText(row.task_id);
  const task = objectValue(row.task);
  const evaluation = objectValue(task.evaluation);
  const accepted = row.state === "result_accepted";
  const score = boundedScore(evaluation.score);
  const observedAt = timestamp(row.updated_at);
  const summary = accepted
    ? `A governed delegated result was accepted with score ${score.toFixed(3)}.`
    : `A governed delegated result was rejected with score ${score.toFixed(3)}.`;
  return observation(input, {
    evidenceId: `delegated-task:${sourceId}`,
    kind: "delegated_task",
    sourceId,
    sourceSha256: sourceContractSha256({
      sourceId,
      state: row.state,
      taskSha256: requiredSha256(task.taskSha256),
      evaluationSha256: requiredSha256(evaluation.evaluationSha256),
      observedAt,
    }),
    verdict: accepted ? "useful" : "needs_work",
    groundingStatus: "verified",
    observedAt,
  }, summary);
}

function scheduleObservation(
  row: SqlRow,
  input: Parameters<typeof loadAgentAdaptationProposalEvidence>[0],
) {
  const sourceId = requiredText(row.id);
  const completed = row.status === "completed";
  const observedAt = timestamp(row.updated_at);
  const failureCode = completed ? "none" : requiredText(row.failure_code);
  const summary = completed
    ? "A reviewed scheduled procedure completed."
    : `A reviewed scheduled procedure failed with category ${failureCode}.`;
  return observation(input, {
    evidenceId: `scheduled-trigger:${sourceId}`,
    kind: "scheduled_trigger",
    sourceId,
    sourceSha256: sourceContractSha256({
      sourceId,
      status: row.status,
      failureCode,
      authoritySha256: requiredSha256(row.authority_sha256),
      observedAt,
    }),
    verdict: completed ? "useful" : "needs_work",
    groundingStatus: completed ? "verified" : "not_required",
    observedAt,
  }, summary);
}

function observation(
  input: Parameters<typeof loadAgentAdaptationProposalEvidence>[0],
  evidence: AgentAdaptationEvidenceV1,
  summary: string,
): AgentAdaptationProposalEvidenceObservation {
  return Object.freeze({
    tenantId: input.owner.tenantId,
    ownerActorId: input.owner.canonicalActorId,
    agentId: input.agentId,
    definitionVersion: input.definitionVersion,
    evidence: Object.freeze(evidence),
    summary: boundedSummary(summary),
  });
}

function proposalExecutionScope(input: {
  owner: AgentAdaptationProposalOwner;
  agentId: string;
  sentinelPrincipalId: string;
  correlationId: string;
  causationId: string;
}) {
  return createExecutionScope({
    tenantId: input.owner.tenantId,
    initiatingActorId: input.owner.canonicalActorId,
    executingPrincipalType: "agent",
    executingPrincipalId: input.sentinelPrincipalId,
    correlationId: input.correlationId,
    causationId: input.causationId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "agent.adaptation.proposal.v1",
  });
}

function uniqueActorIds(owner: AgentAdaptationProposalOwner) {
  return [...new Set([owner.canonicalActorId, owner.actorId].map(requiredText))];
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function boundedSummary(value: unknown) {
  const text = String(value || "").trim().slice(0, 1_000);
  if (text.length < 3) throw new Error("Adaptation proposal evidence is incomplete.");
  return text;
}

function boundedScore(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(1, Math.max(0, Math.round(parsed * 1_000) / 1_000))
    : 0;
}

function requiredSha256(value: unknown) {
  const text = String(value || "");
  if (!/^[a-f0-9]{64}$/.test(text)) {
    throw new Error("Adaptation proposal evidence digest is invalid.");
  }
  return text;
}

function requiredText(value: unknown) {
  const text = String(value || "").trim();
  if (!text || text.length > 320 || text.includes("\0")) {
    throw new Error("Adaptation proposal evidence identifier is invalid.");
  }
  return text;
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Adaptation proposal evidence time is invalid.");
  }
  return date.toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Error("Proactive Agent adaptations require the canonical database.");
  }
}
