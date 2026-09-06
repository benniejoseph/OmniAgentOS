import { randomUUID } from "node:crypto";

import {
  resolveCustomAgentIdentityWithSql,
  rotateCustomAgentGrantAuthorityWithSql,
} from "@/lib/agents/identity-store";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  explainAgentMemoryGrantV1,
  parseAgentMemoryGrantDraftV1,
  type AgentMemoryGrantDraftV1,
  type AgentMemoryGrantViewV1,
} from "@/lib/memory/agent-grant-editor";
import {
  buildMemoryAccessGrantEventV1,
  parseMemoryAccessGrantRecordV1,
  type MemoryAccessGrantRecordV1,
} from "@/lib/memory/grant-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { parseAgentPersonaV1 } from "@/lib/agents/persona";
import type { CustomAgentDefinition } from "@/lib/skills/types";

type GrantSql = ReturnType<typeof getSql>;
type SqlRow = Record<string, unknown>;

export type AgentMemoryGrantOwner = Readonly<{
  tenantId: string;
  actorId: string;
  canonicalActorId: string;
}>;

export class AgentMemoryGrantConflictError extends Error {
  readonly code = "agent_memory_grant_conflict";

  constructor(message = "The Agent grant authority changed. Refresh and try again.") {
    super(message);
    this.name = "AgentMemoryGrantConflictError";
  }
}

export class AgentMemoryGrantUnavailableError extends Error {
  readonly code = "agent_memory_grant_unavailable";

  constructor(message = "Agent memory grants require the canonical database authority.") {
    super(message);
    this.name = "AgentMemoryGrantUnavailableError";
  }
}

export async function listAgentMemoryGrants(
  agentId: string,
  owner: AgentMemoryGrantOwner,
): Promise<AgentMemoryGrantViewV1[]> {
  requireDatabase();
  await ensureDatabaseSchema();
  const sql = getSql();
  const agent = await readOwnedAgent(sql, agentId, owner, false);
  if (!agent) throw new AgentMemoryGrantConflictError("Custom Agent not found.");
  const identity = await resolveCustomAgentIdentityWithSql({
    tenantId: owner.tenantId,
    agentId,
    ownerActorId: owner.canonicalActorId,
    sql,
  });
  const claimedIds = [
    ...identity.principal.contextGrantIds,
    ...identity.principal.capabilityGrantIds,
  ];
  if (!claimedIds.length) return [];
  const rows = await readClaimedGrantRows(
    sql,
    owner,
    identity.principal.principalId,
    identity.principal.principalGeneration,
    claimedIds,
    false,
  );
  if (rows.length !== claimedIds.length) throw new AgentMemoryGrantConflictError();
  return rows.map((row) => grantView(grantFromRow(row)));
}

export async function createAgentMemoryGrant(
  agentId: string,
  draftValue: unknown,
  owner: AgentMemoryGrantOwner,
): Promise<AgentMemoryGrantViewV1> {
  const draft = parseAgentMemoryGrantDraftV1(draftValue);
  assertValidityWindow(draft.expiresAt);
  const grantId = `${draft.grantKind}:${randomUUID()}`;
  const grants = await replaceGrantAuthority(agentId, owner, {
    action: "create",
    grantId,
    draft,
  });
  const created = grants.find((grant) => grant.record.grantId === grantId);
  if (!created) throw new AgentMemoryGrantConflictError();
  return created;
}

export async function revokeAgentMemoryGrant(
  agentId: string,
  grantId: string,
  owner: AgentMemoryGrantOwner,
): Promise<void> {
  if (!/^(context|capability):[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/.test(grantId)) {
    throw new AgentMemoryGrantConflictError("Memory grant not found.");
  }
  await replaceGrantAuthority(agentId, owner, {
    action: "revoke",
    grantId,
  });
}

async function replaceGrantAuthority(
  agentId: string,
  owner: AgentMemoryGrantOwner,
  change:
    | Readonly<{ action: "create"; grantId: string; draft: AgentMemoryGrantDraftV1 }>
    | Readonly<{ action: "revoke"; grantId: string }>,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return getSql().transaction(async (sql: GrantSql) => {
    const agent = await readOwnedAgent(sql, agentId, owner, true);
    if (!agent) throw new AgentMemoryGrantConflictError("Custom Agent not found.");
    const identity = await resolveCustomAgentIdentityWithSql({
      tenantId: owner.tenantId,
      agentId,
      ownerActorId: owner.canonicalActorId,
      sql,
    });
    const claimedIds = [
      ...identity.principal.contextGrantIds,
      ...identity.principal.capabilityGrantIds,
    ];
    const currentRows = claimedIds.length
      ? await readClaimedGrantRows(
          sql,
          owner,
          identity.principal.principalId,
          identity.principal.principalGeneration,
          claimedIds,
          true,
        )
      : [];
    if (currentRows.length !== claimedIds.length) {
      throw new AgentMemoryGrantConflictError();
    }
    const current = currentRows.map(grantFromRow);
    if (
      change.action === "create" &&
      current.some((grant) => equivalentDraft(grant, change.draft))
    ) {
      throw new AgentMemoryGrantConflictError(
        "An equivalent active grant already exists for this Agent.",
      );
    }
    if (
      change.action === "revoke" &&
      !current.some((grant) => grant.grantId === change.grantId)
    ) {
      throw new AgentMemoryGrantConflictError("Memory grant not found.");
    }

    const observedAt = Date.now();
    const retained = current.filter((grant) =>
      grant.grantId !== (change.action === "revoke" ? change.grantId : "") &&
      Date.parse(grant.expiresAt) > observedAt
    );
    const desiredIds = [
      ...retained.map((grant) => grant.grantId),
      ...(change.action === "create" ? [change.grantId] : []),
    ].sort();
    const contextGrantIds = desiredIds.filter((id) => id.startsWith("context:"));
    const capabilityGrantIds = desiredIds.filter((id) =>
      id.startsWith("capability:")
    );
    const governanceDecisionId = `agent-grant-editor:${randomUUID()}`;
    const executionScope = createExecutionScope({
      tenantId: owner.tenantId,
      initiatingActorId: owner.canonicalActorId,
      executingPrincipalType: "user",
      executingPrincipalId: owner.canonicalActorId,
      correlationId: governanceDecisionId,
      purpose: "agent.identity.grant_update.v1",
    });
    const activated: MemoryAccessGrantRecordV1[] = [];

    await rotateCustomAgentGrantAuthorityWithSql({
      agent,
      contextGrantIds,
      capabilityGrantIds,
      executionScope,
      sql,
      onPrincipalHeld: async (nextPrincipal) => {
        for (const grant of current) {
          const revoked = await transitionGrant(
            sql,
            grant,
            "revoked",
            owner.canonicalActorId,
          );
          await appendGrantEvent(
            sql,
            revoked,
            executionScope,
            governanceDecisionId,
          );
        }
        const desired = [
          ...retained,
          ...(change.action === "create"
            ? [draftRecordSeed(change.grantId, change.draft)]
            : []),
        ].sort((left, right) => left.grantId.localeCompare(right.grantId));
        for (const seed of desired) {
          const held = await insertHeldGrant(
            sql,
            seed,
            owner,
            nextPrincipal.principalId,
            nextPrincipal.principalGeneration,
          );
          await appendGrantEvent(
            sql,
            held,
            executionScope,
            governanceDecisionId,
          );
          const active = await transitionGrant(
            sql,
            held,
            "active",
            owner.canonicalActorId,
          );
          await appendGrantEvent(
            sql,
            active,
            executionScope,
            governanceDecisionId,
          );
          activated.push(active);
        }
      },
    });

    if (activated.length !== desiredIds.length) {
      throw new AgentMemoryGrantConflictError();
    }
    return activated.map(grantView);
  }) as Promise<AgentMemoryGrantViewV1[]>;
}

async function readOwnedAgent(
  sql: GrantSql,
  agentId: string,
  owner: AgentMemoryGrantOwner,
  lock: boolean,
) {
  const rows = lock
    ? await sql`
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
    : await sql`
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
  return rows[0] ? agentFromRow(rows[0]) : undefined;
}

function readClaimedGrantRows(
  sql: GrantSql,
  owner: AgentMemoryGrantOwner,
  principalId: string,
  principalGeneration: number,
  grantIds: readonly string[],
  lock: boolean,
) {
  return lock
    ? sql`
        SELECT *
        FROM omni_tenant_memory_access_grants
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.canonicalActorId}
          AND grantee_kind = 'agent'
          AND grantee_execution_principal_id = ${principalId}
          AND grantee_execution_principal_generation = ${principalGeneration}
          AND grant_id = ANY(${grantIds}::TEXT[])
          AND state = 'active'
        ORDER BY grant_kind, grant_id
        FOR UPDATE
      `
    : sql`
        SELECT *
        FROM omni_tenant_memory_access_grants
        WHERE tenant_id = ${owner.tenantId}
          AND owner_actor_id = ${owner.canonicalActorId}
          AND grantee_kind = 'agent'
          AND grantee_execution_principal_id = ${principalId}
          AND grantee_execution_principal_generation = ${principalGeneration}
          AND grant_id = ANY(${grantIds}::TEXT[])
          AND state = 'active'
        ORDER BY grant_kind, grant_id
      `;
}

async function insertHeldGrant(
  sql: GrantSql,
  seed: MemoryAccessGrantRecordV1,
  owner: AgentMemoryGrantOwner,
  principalId: string,
  principalGeneration: number,
) {
  const generationRows = await sql`
    SELECT COALESCE(MAX(grant_generation), 0) + 1 AS next_generation
    FROM omni_tenant_memory_access_grants
    WHERE tenant_id = ${owner.tenantId}
      AND grant_kind = ${seed.grantKind}
      AND grant_id = ${seed.grantId}
  `;
  const nextGeneration = Number(generationRows[0]?.next_generation || 1);
  const targetAgent = seed.target.visibility === "agent_private"
    ? principalId
    : null;
  const targetAgentGeneration = seed.target.visibility === "agent_private"
    ? principalGeneration
    : null;
  const rows = await sql`
    INSERT INTO omni_tenant_memory_access_grants (
      schema_version, tenant_id, grant_kind, grant_id, grant_generation,
      grantee_kind, grantee_key, grantee_actor_id,
      grantee_execution_principal_id,
      grantee_execution_principal_generation, purpose_id,
      target_visibility, owner_actor_id, owner_agent_id,
      owner_agent_principal_generation, workspace_id, project_id, mission_id,
      resource_ids, operation_ids, max_items, max_bytes, max_invocations,
      max_cost_microusd, max_duration_ms, not_before, expires_at,
      state, lifecycle_revision, created_by_actor_id
    ) VALUES (
      1, ${owner.tenantId}, ${seed.grantKind}, ${seed.grantId},
      ${nextGeneration}, 'agent', ${principalId}, NULL, ${principalId},
      ${principalGeneration}, ${seed.purposeId}, ${seed.target.visibility},
      ${owner.canonicalActorId}, ${targetAgent}, ${targetAgentGeneration},
      ${seed.target.workspaceId}, ${seed.target.projectId},
      ${seed.target.missionId}, ${[...seed.target.resourceIds]},
      ${seed.operationIds ? [...seed.operationIds] : null}, ${seed.maxItems},
      ${seed.maxBytes}, ${seed.maxInvocations}, ${seed.maxCostMicrousd},
      ${seed.maxDurationMs}, statement_timestamp(), ${seed.expiresAt},
      'held', 0, ${owner.canonicalActorId}
    )
    RETURNING *
  `;
  const persisted = grantFromRow(exactlyOne(rows));
  assertHeldGrantBinding({
    seed,
    persisted,
    owner,
    principalId,
    principalGeneration,
    grantGeneration: nextGeneration,
  });
  return persisted;
}

async function transitionGrant(
  sql: GrantSql,
  grant: MemoryAccessGrantRecordV1,
  state: "active" | "revoked",
  actorId: string,
) {
  const rows = state === "active"
    ? await sql`
        UPDATE omni_tenant_memory_access_grants
        SET state = 'active', lifecycle_revision = lifecycle_revision + 1,
            activated_by_actor_id = ${actorId}
        WHERE tenant_id = ${grant.tenantId}
          AND grant_kind = ${grant.grantKind}
          AND grant_id = ${grant.grantId}
          AND grant_generation = ${grant.grantGeneration}
          AND state = 'held'
        RETURNING *
      `
    : await sql`
        UPDATE omni_tenant_memory_access_grants
        SET state = 'revoked', lifecycle_revision = lifecycle_revision + 1,
            revoked_by_actor_id = ${actorId}
        WHERE tenant_id = ${grant.tenantId}
          AND grant_kind = ${grant.grantKind}
          AND grant_id = ${grant.grantId}
          AND grant_generation = ${grant.grantGeneration}
          AND state IN ('held', 'active')
        RETURNING *
      `;
  return grantFromRow(exactlyOne(rows));
}

async function appendGrantEvent(
  sql: GrantSql,
  grant: MemoryAccessGrantRecordV1,
  executionScope: ReturnType<typeof createExecutionScope>,
  governanceDecisionId: string,
) {
  const event = buildMemoryAccessGrantEventV1(grant, governanceDecisionId);
  return appendScopedDomainEvent({
    id: `memory-access-grant:${grant.grantKind}:${grant.grantId}:${grant.grantGeneration}:${grant.state}`,
    streamId: `memory-access-grant:${grant.grantKind}:${grant.grantId}`,
    type: event.type,
    payload: event.payload,
    executionScope,
  }, { sql });
}

function draftRecordSeed(
  grantId: string,
  draft: AgentMemoryGrantDraftV1,
): MemoryAccessGrantRecordV1 {
  const now = new Date().toISOString();
  const common = {
    schemaVersion: 1 as const,
    tenantId: "pending",
    grantKind: draft.grantKind,
    grantId,
    grantGeneration: 1,
    granteeKind: "agent" as const,
    granteeId: "agent:pending",
    granteePrincipalGeneration: 1,
    purposeId: draft.purposeId,
    target: {
      visibility: draft.target.visibility,
      ownerActorId: "actor:00000000-0000-4000-8000-000000000000",
      ownerAgentId: draft.target.visibility === "agent_private"
        ? "agent:pending"
        : null,
      ownerAgentPrincipalGeneration: draft.target.visibility === "agent_private"
        ? 1
        : null,
      workspaceId: draft.target.workspaceId,
      projectId: draft.target.projectId,
      missionId: draft.target.missionId,
      resourceIds: draft.target.resourceIds,
    },
    notBefore: now,
    expiresAt: draft.expiresAt,
    state: "held" as const,
    lifecycleRevision: 0,
    createdByActorId: "actor:00000000-0000-4000-8000-000000000000",
    activatedByActorId: null,
    revokedByActorId: null,
    createdAt: now,
    activatedAt: null,
    revokedAt: null,
    updatedAt: now,
  };
  return parseMemoryAccessGrantRecordV1(draft.grantKind === "context"
    ? {
        ...common,
        operationIds: null,
        maxItems: draft.maxItems,
        maxBytes: draft.maxBytes,
        maxInvocations: null,
        maxCostMicrousd: null,
        maxDurationMs: null,
      }
    : {
        ...common,
        operationIds: draft.operationIds,
        maxItems: null,
        maxBytes: null,
        maxInvocations: draft.maxInvocations,
        maxCostMicrousd: draft.maxCostMicrousd,
        maxDurationMs: draft.maxDurationMs,
      });
}

function grantFromRow(row: SqlRow): MemoryAccessGrantRecordV1 {
  return parseMemoryAccessGrantRecordV1({
    schemaVersion: Number(row.schema_version),
    tenantId: row.tenant_id,
    grantKind: row.grant_kind,
    grantId: row.grant_id,
    grantGeneration: Number(row.grant_generation),
    granteeKind: row.grantee_kind,
    granteeId: row.grantee_key,
    granteePrincipalGeneration: row.grantee_execution_principal_generation === null
      ? null
      : Number(row.grantee_execution_principal_generation),
    purposeId: row.purpose_id,
    target: {
      visibility: row.target_visibility,
      ownerActorId: row.owner_actor_id,
      ownerAgentId: row.owner_agent_id,
      ownerAgentPrincipalGeneration: row.owner_agent_principal_generation === null
        ? null
        : Number(row.owner_agent_principal_generation),
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      missionId: row.mission_id,
      resourceIds: row.resource_ids,
    },
    operationIds: row.operation_ids,
    maxItems: nullableNumber(row.max_items),
    maxBytes: nullableNumber(row.max_bytes),
    maxInvocations: nullableNumber(row.max_invocations),
    maxCostMicrousd: nullableNumber(row.max_cost_microusd),
    maxDurationMs: nullableNumber(row.max_duration_ms),
    notBefore: timestamp(row.not_before),
    expiresAt: timestamp(row.expires_at),
    state: row.state,
    lifecycleRevision: Number(row.lifecycle_revision),
    createdByActorId: row.created_by_actor_id,
    activatedByActorId: row.activated_by_actor_id,
    revokedByActorId: row.revoked_by_actor_id,
    createdAt: timestamp(row.created_at),
    activatedAt: nullableTimestamp(row.activated_at),
    revokedAt: nullableTimestamp(row.revoked_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function grantView(record: MemoryAccessGrantRecordV1): AgentMemoryGrantViewV1 {
  return Object.freeze({
    record,
    explanation: explainAgentMemoryGrantV1(record),
    manageable: record.state === "active" && Date.parse(record.expiresAt) > Date.now(),
  });
}

function assertHeldGrantBinding(input: {
  seed: MemoryAccessGrantRecordV1;
  persisted: MemoryAccessGrantRecordV1;
  owner: AgentMemoryGrantOwner;
  principalId: string;
  principalGeneration: number;
  grantGeneration: number;
}) {
  const { seed, persisted } = input;
  const targetAgentId = seed.target.visibility === "agent_private"
    ? input.principalId
    : null;
  const targetAgentGeneration = seed.target.visibility === "agent_private"
    ? input.principalGeneration
    : null;
  if (
    persisted.tenantId !== input.owner.tenantId ||
    persisted.grantKind !== seed.grantKind ||
    persisted.grantId !== seed.grantId ||
    persisted.grantGeneration !== input.grantGeneration ||
    persisted.granteeKind !== "agent" ||
    persisted.granteeId !== input.principalId ||
    persisted.granteePrincipalGeneration !== input.principalGeneration ||
    persisted.purposeId !== seed.purposeId ||
    persisted.target.visibility !== seed.target.visibility ||
    persisted.target.ownerActorId !== input.owner.canonicalActorId ||
    persisted.target.ownerAgentId !== targetAgentId ||
    persisted.target.ownerAgentPrincipalGeneration !== targetAgentGeneration ||
    persisted.target.workspaceId !== seed.target.workspaceId ||
    persisted.target.projectId !== seed.target.projectId ||
    persisted.target.missionId !== seed.target.missionId ||
    !arraysEqual(persisted.target.resourceIds, seed.target.resourceIds) ||
    !arraysEqual(persisted.operationIds || [], seed.operationIds || []) ||
    persisted.maxItems !== seed.maxItems ||
    persisted.maxBytes !== seed.maxBytes ||
    persisted.maxInvocations !== seed.maxInvocations ||
    persisted.maxCostMicrousd !== seed.maxCostMicrousd ||
    persisted.maxDurationMs !== seed.maxDurationMs ||
    persisted.expiresAt !== seed.expiresAt ||
    persisted.state !== "held" ||
    persisted.lifecycleRevision !== 0 ||
    persisted.createdByActorId !== input.owner.canonicalActorId
  ) {
    throw new AgentMemoryGrantConflictError(
      "Persisted Agent memory grant binding changed.",
    );
  }
}

function equivalentDraft(
  grant: MemoryAccessGrantRecordV1,
  draft: AgentMemoryGrantDraftV1,
) {
  if (
    grant.grantKind !== draft.grantKind ||
    grant.purposeId !== draft.purposeId ||
    grant.target.visibility !== draft.target.visibility ||
    grant.target.workspaceId !== draft.target.workspaceId ||
    grant.target.projectId !== draft.target.projectId ||
    grant.target.missionId !== draft.target.missionId ||
    !arraysEqual(grant.target.resourceIds, draft.target.resourceIds) ||
    grant.expiresAt !== draft.expiresAt
  ) {
    return false;
  }
  if (draft.grantKind === "context") {
    return grant.grantKind === "context" &&
      grant.maxItems === draft.maxItems &&
      grant.maxBytes === draft.maxBytes;
  }
  return grant.grantKind === "capability" &&
    arraysEqual(grant.operationIds, draft.operationIds) &&
    grant.maxInvocations === draft.maxInvocations &&
    grant.maxCostMicrousd === draft.maxCostMicrousd &&
    grant.maxDurationMs === draft.maxDurationMs;
}

function assertValidityWindow(expiresAt: string) {
  const lifetime = Date.parse(expiresAt) - Date.now();
  if (lifetime < 5 * 60_000 || lifetime > 365 * 24 * 60 * 60_000) {
    throw new AgentMemoryGrantConflictError(
      "Grant expiry must be between five minutes and one year from now.",
    );
  }
}

function requireDatabase() {
  if (!hasDatabaseUrl()) throw new AgentMemoryGrantUnavailableError();
}

function exactlyOne(rows: SqlRow[]) {
  if (rows.length !== 1) throw new AgentMemoryGrantConflictError();
  return rows[0];
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((entry, index) => entry === right[index]);
}

function nullableNumber(value: unknown) {
  return value === null || value === undefined ? null : Number(value);
}

function nullableTimestamp(value: unknown) {
  return value === null || value === undefined ? null : timestamp(value);
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new AgentMemoryGrantConflictError();
  return date.toISOString();
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
