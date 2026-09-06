import { randomUUID } from "node:crypto";

import {
  resolveCustomAgentDefinitionVersionWithSql,
  revokeCustomAgentIdentityWithSql,
} from "@/lib/agents/identity-store";
import { parseAgentDefinitionV1 } from "@/lib/agents/identity-contracts";
import {
  evaluateAgentReleaseCandidateV1,
  parseAgentReleaseChannelV1,
  parseAgentReleaseEvaluationV1,
  type AgentReleaseChannelV1,
  type AgentReleaseEvaluationV1,
} from "@/lib/agents/release-contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { parseAgentPersonaV1 } from "@/lib/agents/persona";
import type { CustomAgentDefinition } from "@/lib/skills/types";

type ReleaseSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export const AGENT_RELEASE_EVENT_TYPES = Object.freeze({
  initialized: "agent.release.initialized",
  evaluated: "agent.release.evaluated",
  promoted: "agent.release.promoted",
  rolledBack: "agent.release.rolled_back",
  retired: "agent.release.retired",
} as const);

export type AgentReleaseOwner = Readonly<{
  tenantId: string;
  actorId: string;
  canonicalActorId: string;
}>;

export type AgentReleaseVersionView = Readonly<{
  definitionVersion: number;
  definitionVersionId: string;
  publishedAt: string;
  active: boolean;
}>;

export type AgentReleaseView = AgentReleaseChannelV1 & Readonly<{
  versions: readonly AgentReleaseVersionView[];
  evaluations: readonly AgentReleaseEvaluationV1[];
}>;

export class AgentReleaseConflictError extends Error {
  readonly code = "agent_release_conflict";

  constructor(message = "The Agent release changed. Refresh and try again.") {
    super(message);
    this.name = "AgentReleaseConflictError";
  }
}

export class AgentReleaseUnavailableError extends Error {
  readonly code = "agent_release_unavailable";

  constructor(message = "Agent releases require the canonical database authority.") {
    super(message);
    this.name = "AgentReleaseUnavailableError";
  }
}

export async function getAgentRelease(
  agentId: string,
  owner: AgentReleaseOwner,
): Promise<AgentReleaseView> {
  requireDatabase();
  await ensureDatabaseSchema();
  return readAgentRelease(getSql(), agentId, owner, false);
}

export async function evaluateAgentRelease(
  agentId: string,
  definitionVersion: number,
  owner: AgentReleaseOwner,
): Promise<AgentReleaseView> {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReleaseSql) => {
    const agent = await readOwnedAgent(sql, agentId, owner, true);
    if (!agent) throw new AgentReleaseConflictError("Custom Agent not found.");
    const channel = await readChannelRow(sql, agentId, owner, true);
    if (channel.state !== "active") {
      throw new AgentReleaseConflictError("A retired Agent cannot be evaluated.");
    }
    const baselineVersion = positiveVersion(channel.active_definition_version);
    if (definitionVersion === baselineVersion) {
      throw new AgentReleaseConflictError("Choose a version other than the active release.");
    }
    const baseline = await readDefinitionSnapshot(
      sql,
      agentId,
      baselineVersion,
      owner,
    );
    const candidate = await readDefinitionSnapshot(
      sql,
      agentId,
      definitionVersion,
      owner,
    );
    const evaluation = evaluateAgentReleaseCandidateV1({ baseline, candidate });
    const inserted = await sql`
      INSERT INTO omni_agent_release_evaluations (
        tenant_id, evaluation_id, agent_definition_id,
        definition_version, baseline_definition_version, owner_actor_id,
        evaluated_by_actor_id, policy_version_id, direction, changed_fields,
        checks, verdict, definition_sha256, baseline_definition_sha256,
        definition_snapshot, evaluation_sha256, evaluated_at
      ) VALUES (
        ${owner.tenantId}, ${evaluation.evaluationId}, ${agentId},
        ${evaluation.definitionVersion},
        ${evaluation.baselineDefinitionVersion}, ${owner.canonicalActorId},
        ${owner.canonicalActorId}, ${evaluation.policyVersionId},
        ${evaluation.direction}, ${[...evaluation.changedFields]},
        ${evaluation.checks}::JSONB, ${evaluation.verdict},
        ${evaluation.definitionSha256},
        ${evaluation.baselineDefinitionSha256}, ${candidate}::JSONB,
        ${evaluation.evaluationSha256}, ${evaluation.evaluatedAt}
      )
      ON CONFLICT (tenant_id, evaluation_id) DO NOTHING
      RETURNING *
    `;
    const persistedRows = inserted[0]
      ? inserted
      : await sql`
          SELECT *
          FROM omni_agent_release_evaluations
          WHERE tenant_id = ${owner.tenantId}
            AND evaluation_id = ${evaluation.evaluationId}
            AND owner_actor_id = ${owner.canonicalActorId}
          LIMIT 1
        `;
    const persisted = evaluationFromRow(exactlyOne(persistedRows));
    if (persisted.evaluationSha256 !== evaluation.evaluationSha256) {
      throw new AgentReleaseConflictError();
    }
    const executionScope = releaseExecutionScope(owner, agentId, "evaluate");
    await appendReleaseEvent(sql, agentId, executionScope, AGENT_RELEASE_EVENT_TYPES.evaluated, {
      schemaVersion: 1,
      evaluationId: persisted.evaluationId,
      evaluationSha256: persisted.evaluationSha256,
      definitionVersion: persisted.definitionVersion,
      baselineDefinitionVersion: persisted.baselineDefinitionVersion,
      direction: persisted.direction,
      changedFields: persisted.changedFields,
      verdict: persisted.verdict,
    });
    return readAgentRelease(sql, agentId, owner, false);
  }) as Promise<AgentReleaseView>;
}

export async function promoteAgentRelease(
  agentId: string,
  evaluationId: string,
  owner: AgentReleaseOwner,
): Promise<AgentReleaseView> {
  return transitionAgentRelease(agentId, evaluationId, owner, "promotion");
}

export async function rollbackAgentRelease(
  agentId: string,
  evaluationId: string,
  owner: AgentReleaseOwner,
): Promise<AgentReleaseView> {
  return transitionAgentRelease(agentId, evaluationId, owner, "rollback");
}

export async function retireAgentRelease(
  agentId: string,
  owner: AgentReleaseOwner,
): Promise<AgentReleaseView> {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReleaseSql) => {
    const agent = await readOwnedAgent(sql, agentId, owner, true);
    if (!agent) throw new AgentReleaseConflictError("Custom Agent not found.");
    const channel = await readChannelRow(sql, agentId, owner, true);
    if (channel.state !== "active") {
      throw new AgentReleaseConflictError("This Agent is already retired.");
    }
    const executionScope = releaseExecutionScope(owner, agentId, "retire");
    await revokeCustomAgentIdentityWithSql({ agent, executionScope, sql });
    await retireAgentReleaseChannelWithSql({
      agent,
      canonicalActorId: owner.canonicalActorId,
      executionScope,
      sql,
    });
    return readAgentRelease(sql, agentId, owner, false);
  }) as Promise<AgentReleaseView>;
}

export async function initializeAgentReleaseChannelWithSql(input: {
  agent: CustomAgentDefinition;
  definitionVersion: number;
  canonicalActorId: string;
  executionScope: ExecutionScope;
  sql: ReleaseSql;
}) {
  const rows = await input.sql`
    INSERT INTO omni_agent_release_channels (
      tenant_id, agent_definition_id, owner_actor_id,
      active_definition_version, updated_by_actor_id, updated_at
    ) VALUES (
      ${input.agent.tenantId}, ${input.agent.id}, ${input.canonicalActorId},
      ${input.definitionVersion}, ${input.canonicalActorId},
      ${input.agent.updatedAt}
    )
    RETURNING *
  `;
  const channel = channelFromRow(exactlyOne(rows), input.definitionVersion, null);
  await appendReleaseEvent(
    input.sql,
    input.agent.id,
    input.executionScope,
    AGENT_RELEASE_EVENT_TYPES.initialized,
    {
      schemaVersion: 1,
      releaseRevision: channel.releaseRevision,
      definitionVersion: channel.activeDefinitionVersion,
    },
  );
  return channel;
}

export async function retireAgentReleaseChannelWithSql(input: {
  agent: CustomAgentDefinition;
  canonicalActorId: string;
  executionScope: ExecutionScope;
  sql: ReleaseSql;
}) {
  const rows = await input.sql`
    UPDATE omni_agent_release_channels
    SET state = 'retired', release_revision = release_revision + 1,
        updated_by_actor_id = ${input.canonicalActorId}
    WHERE tenant_id = ${input.agent.tenantId}
      AND agent_definition_id = ${input.agent.id}
      AND owner_actor_id = ${input.canonicalActorId}
      AND state = 'active'
    RETURNING *
  `;
  const row = exactlyOne(rows);
  await appendReleaseEvent(
    input.sql,
    input.agent.id,
    input.executionScope,
    AGENT_RELEASE_EVENT_TYPES.retired,
    {
      schemaVersion: 1,
      releaseRevision: positiveVersion(row.release_revision),
      definitionVersion: positiveVersion(row.active_definition_version),
      retiredAt: timestamp(row.retired_at),
    },
  );
}

async function transitionAgentRelease(
  agentId: string,
  evaluationId: string,
  owner: AgentReleaseOwner,
  direction: "promotion" | "rollback",
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: ReleaseSql) => {
    const agent = await readOwnedAgent(sql, agentId, owner, true);
    if (!agent) throw new AgentReleaseConflictError("Custom Agent not found.");
    const channel = await readChannelRow(sql, agentId, owner, true);
    if (channel.state !== "active") {
      throw new AgentReleaseConflictError("A retired Agent cannot change releases.");
    }
    const evaluationRows = await sql`
      SELECT *
      FROM omni_agent_release_evaluations
      WHERE tenant_id = ${owner.tenantId}
        AND evaluation_id = ${evaluationId}
        AND agent_definition_id = ${agentId}
        AND owner_actor_id = ${owner.canonicalActorId}
      LIMIT 1
      FOR KEY SHARE
    `;
    const evaluation = evaluationFromRow(exactlyOne(evaluationRows));
    if (
      evaluation.direction !== direction ||
      evaluation.baselineDefinitionVersion !==
        positiveVersion(channel.active_definition_version)
    ) {
      throw new AgentReleaseConflictError(
        "This evaluation does not target the current active release.",
      );
    }
    const rows = await sql`
      UPDATE omni_agent_release_channels
      SET active_definition_version = ${evaluation.definitionVersion},
          previous_definition_version = active_definition_version,
          last_evaluation_id = ${evaluation.evaluationId},
          release_revision = release_revision + 1,
          updated_by_actor_id = ${owner.canonicalActorId}
      WHERE tenant_id = ${owner.tenantId}
        AND agent_definition_id = ${agentId}
        AND owner_actor_id = ${owner.canonicalActorId}
        AND state = 'active'
        AND active_definition_version =
          ${evaluation.baselineDefinitionVersion}
      RETURNING *
    `;
    const changed = exactlyOne(rows);
    const eventType = direction === "promotion"
      ? AGENT_RELEASE_EVENT_TYPES.promoted
      : AGENT_RELEASE_EVENT_TYPES.rolledBack;
    await appendReleaseEvent(
      sql,
      agentId,
      releaseExecutionScope(owner, agentId, direction),
      eventType,
      {
        schemaVersion: 1,
        releaseRevision: positiveVersion(changed.release_revision),
        fromDefinitionVersion: evaluation.baselineDefinitionVersion,
        toDefinitionVersion: evaluation.definitionVersion,
        evaluationId: evaluation.evaluationId,
        evaluationSha256: evaluation.evaluationSha256,
      },
    );
    return readAgentRelease(sql, agentId, owner, false);
  }) as Promise<AgentReleaseView>;
}

async function readAgentRelease(
  sql: ReleaseSql,
  agentId: string,
  owner: AgentReleaseOwner,
  lock: boolean,
): Promise<AgentReleaseView> {
  const agent = await readOwnedAgent(sql, agentId, owner, lock);
  if (!agent) throw new AgentReleaseConflictError("Custom Agent not found.");
  const channel = await readChannelRow(sql, agentId, owner, lock);
  const versions = await readVersionRows(sql, agentId, owner);
  const activeVersion = positiveVersion(channel.active_definition_version);
  const latestVersion = versions.at(-1)?.definitionVersion;
  if (!latestVersion) throw new AgentReleaseConflictError();
  const evaluations = await readEvaluationsForBaseline(
    sql,
    agentId,
    activeVersion,
    owner,
  );
  const candidateEvaluation = evaluations.find((evaluation) =>
    evaluation.definitionVersion === latestVersion
  ) || null;
  return Object.freeze({
    ...channelFromRow(channel, latestVersion, candidateEvaluation),
    versions: Object.freeze(versions.map((version) => Object.freeze({
      ...version,
      active: version.definitionVersion === activeVersion,
    }))),
    evaluations: Object.freeze(evaluations),
  });
}

async function readOwnedAgent(
  sql: ReleaseSql,
  agentId: string,
  owner: AgentReleaseOwner,
  lock: boolean,
) {
  const query = lock
    ? sql`
        SELECT agent.*
        FROM omni_custom_agents agent
        JOIN omni_auth_user_actor_identifiers identifier
          ON identifier.actor_identifier COLLATE "C" =
            agent.actor_id COLLATE "C"
          AND identifier.canonical_actor_id = ${owner.canonicalActorId}
        WHERE agent.tenant_id = ${owner.tenantId}
          AND agent.id = ${agentId}
        LIMIT 1
        FOR UPDATE OF agent
      `
    : sql`
        SELECT agent.*
        FROM omni_custom_agents agent
        JOIN omni_auth_user_actor_identifiers identifier
          ON identifier.actor_identifier COLLATE "C" =
            agent.actor_id COLLATE "C"
          AND identifier.canonical_actor_id = ${owner.canonicalActorId}
        WHERE agent.tenant_id = ${owner.tenantId}
          AND agent.id = ${agentId}
        LIMIT 1
      `;
  const rows = await query;
  return rows[0] ? agentFromRow(rows[0]) : undefined;
}

async function readChannelRow(
  sql: ReleaseSql,
  agentId: string,
  owner: AgentReleaseOwner,
  lock: boolean,
) {
  const rows = lock
    ? await sql`
        SELECT * FROM omni_agent_release_channels
        WHERE tenant_id = ${owner.tenantId}
          AND agent_definition_id = ${agentId}
          AND owner_actor_id = ${owner.canonicalActorId}
        LIMIT 1 FOR UPDATE
      `
    : await sql`
        SELECT * FROM omni_agent_release_channels
        WHERE tenant_id = ${owner.tenantId}
          AND agent_definition_id = ${agentId}
          AND owner_actor_id = ${owner.canonicalActorId}
        LIMIT 1
      `;
  return exactlyOne(rows);
}

async function readVersionRows(
  sql: ReleaseSql,
  agentId: string,
  owner: AgentReleaseOwner,
): Promise<Array<Omit<AgentReleaseVersionView, "active">>> {
  const rows = await sql`
    SELECT definition_version, published_at
    FROM omni_agent_definition_versions
    WHERE tenant_id = ${owner.tenantId}
      AND agent_definition_id = ${agentId}
      AND owner_actor_id = ${owner.canonicalActorId}
    ORDER BY definition_version ASC
    LIMIT 100
  `;
  return rows.map((row) => {
    const definitionVersion = positiveVersion(row.definition_version);
    return {
      definitionVersion,
      definitionVersionId: `definition:custom:${agentId}:v${definitionVersion}`,
      publishedAt: timestamp(row.published_at),
    };
  });
}

async function readDefinitionSnapshot(
  sql: ReleaseSql,
  agentId: string,
  definitionVersion: number,
  owner: AgentReleaseOwner,
) {
  const snapshots = await sql`
    SELECT definition_snapshot
    FROM omni_agent_release_evaluations
    WHERE tenant_id = ${owner.tenantId}
      AND agent_definition_id = ${agentId}
      AND definition_version = ${definitionVersion}
      AND owner_actor_id = ${owner.canonicalActorId}
    ORDER BY evaluated_at DESC, evaluation_id
    LIMIT 1
  `;
  if (snapshots[0]) {
    return parseDefinitionSnapshot(snapshots[0].definition_snapshot);
  }
  return resolveCustomAgentDefinitionVersionWithSql({
    tenantId: owner.tenantId,
    agentId,
    ownerActorId: owner.canonicalActorId,
    definitionVersion,
    sql,
  });
}

async function readEvaluationsForBaseline(
  sql: ReleaseSql,
  agentId: string,
  baselineDefinitionVersion: number,
  owner: AgentReleaseOwner,
) {
  const rows = await sql`
    SELECT *
    FROM omni_agent_release_evaluations
    WHERE tenant_id = ${owner.tenantId}
      AND agent_definition_id = ${agentId}
      AND baseline_definition_version = ${baselineDefinitionVersion}
      AND owner_actor_id = ${owner.canonicalActorId}
    ORDER BY definition_version DESC, evaluated_at DESC
    LIMIT 100
  `;
  return rows.map(evaluationFromRow);
}

function evaluationFromRow(row: SqlRow): AgentReleaseEvaluationV1 {
  return parseAgentReleaseEvaluationV1({
    schemaVersion: Number(row.schema_version),
    version: "p7.5-agent-release-evaluation:1",
    evaluationId: row.evaluation_id,
    agentId: row.agent_definition_id,
    definitionId: `definition:custom:${String(row.agent_definition_id)}`,
    definitionVersion: Number(row.definition_version),
    definitionVersionId:
      `definition:custom:${String(row.agent_definition_id)}:v${String(row.definition_version)}`,
    definitionSha256: row.definition_sha256,
    baselineDefinitionVersion: Number(row.baseline_definition_version),
    baselineDefinitionVersionId:
      `definition:custom:${String(row.agent_definition_id)}:v${String(row.baseline_definition_version)}`,
    baselineDefinitionSha256: row.baseline_definition_sha256,
    policyVersionId: row.policy_version_id,
    direction: row.direction,
    changedFields: row.changed_fields,
    checks: row.checks,
    verdict: row.verdict,
    evaluatedAt: timestamp(row.evaluated_at),
    evaluationSha256: row.evaluation_sha256,
  });
}

function channelFromRow(
  row: SqlRow,
  latestDefinitionVersion: number,
  candidateEvaluation: AgentReleaseEvaluationV1 | null,
) {
  const agentId = String(row.agent_definition_id);
  const activeDefinitionVersion = positiveVersion(row.active_definition_version);
  const previousDefinitionVersion = row.previous_definition_version === null
    ? null
    : positiveVersion(row.previous_definition_version);
  return parseAgentReleaseChannelV1({
    schemaVersion: Number(row.schema_version),
    agentId,
    state: row.state,
    releaseRevision: Number(row.release_revision),
    activeDefinitionVersion,
    activeDefinitionVersionId:
      `definition:custom:${agentId}:v${activeDefinitionVersion}`,
    previousDefinitionVersion,
    previousDefinitionVersionId: previousDefinitionVersion === null
      ? null
      : `definition:custom:${agentId}:v${previousDefinitionVersion}`,
    latestDefinitionVersion,
    latestDefinitionVersionId:
      `definition:custom:${agentId}:v${latestDefinitionVersion}`,
    candidateEvaluation,
    updatedAt: timestamp(row.updated_at),
    retiredAt: nullableTimestamp(row.retired_at),
  });
}

function parseDefinitionSnapshot(value: unknown) {
  return parseAgentDefinitionV1(value);
}

function appendReleaseEvent(
  sql: ReleaseSql,
  agentId: string,
  executionScope: ExecutionScope,
  type: (typeof AGENT_RELEASE_EVENT_TYPES)[keyof typeof AGENT_RELEASE_EVENT_TYPES],
  payload: Record<string, unknown>,
) {
  const eventDigest = payload.evaluationSha256 ||
    `${payload.releaseRevision || 1}:${payload.definitionVersion || payload.toDefinitionVersion}`;
  return appendScopedDomainEvent({
    id: `${type}:${agentId}:${String(eventDigest)}`,
    streamId: `agent:${agentId}`,
    type,
    payload,
    executionScope,
  }, { sql });
}

function releaseExecutionScope(
  owner: AgentReleaseOwner,
  agentId: string,
  action: string,
) {
  return createExecutionScope({
    tenantId: owner.tenantId,
    initiatingActorId: owner.canonicalActorId,
    executingPrincipalType: "user",
    executingPrincipalId: owner.canonicalActorId,
    correlationId: `agent-release:${agentId}:${action}:${randomUUID()}`,
    purpose: `agent.release.${action}.v1`,
  });
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new AgentReleaseUnavailableError();
}

function exactlyOne(rows: SqlRow[]) {
  if (rows.length !== 1) throw new AgentReleaseConflictError();
  return rows[0];
}

function positiveVersion(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new AgentReleaseConflictError();
  }
  return parsed;
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : timestamp(value);
}

function timestamp(value: unknown) {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new AgentReleaseConflictError();
  return parsed.toISOString();
}

function agentFromRow(row: SqlRow): CustomAgentDefinition {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    slug: String(row.slug),
    name: String(row.name),
    role: String(row.role),
    description: String(row.description),
    instructions: String(row.instructions),
    persona: parseAgentPersonaV1(row.persona_profile),
    status: String(row.status) as CustomAgentDefinition["status"],
    accent: String(row.accent) as CustomAgentDefinition["accent"],
    modelPolicy: String(row.model_policy) as CustomAgentDefinition["modelPolicy"],
    autonomy: String(row.autonomy) as CustomAgentDefinition["autonomy"],
    approvalPolicy: String(row.approval_policy) as CustomAgentDefinition["approvalPolicy"],
    memoryScope: String(row.memory_scope) as CustomAgentDefinition["memoryScope"],
    skillIds: stringArray(row.skill_ids),
    toolIds: stringArray(row.tool_ids),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.map(String) : [];
}
