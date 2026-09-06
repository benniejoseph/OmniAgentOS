import { randomUUID } from "node:crypto";

import {
  buildBuiltInAgentIdentityV1,
  buildCustomAgentIdentityV1,
  isBuiltInAgentIdentityId,
  parseAgentDefinitionV1,
  parseAgentPrincipalDefinitionV1,
  type ResolvedAgentIdentityV1,
} from "@/lib/agents/identity-contracts";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { builtInSkills } from "@/lib/skills/catalog";
import { parseAgentPersonaV1 } from "@/lib/agents/persona";
import type { AgentSkill, CustomAgentDefinition } from "@/lib/skills/types";

type IdentitySql = ReturnType<typeof getSql>;

export const AGENT_IDENTITY_EVENT_TYPES = Object.freeze({
  definitionVersioned: "agent.definition.versioned",
  principalVersioned: "agent.principal.versioned",
  principalRevoked: "agent.principal.revoked",
} as const);

export class AgentIdentityResolutionError extends Error {
  readonly code = "agent_identity_unavailable";

  constructor(message = "The exact agent identity could not be resolved.") {
    super(message);
    this.name = "AgentIdentityResolutionError";
  }
}

export async function resolveAgentIdentityForExecution(input: {
  tenantId: string;
  actorId: string;
  agentId: string;
  customAgent?: CustomAgentDefinition;
  customSkills?: readonly AgentSkill[];
}): Promise<ResolvedAgentIdentityV1> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const sql = getSql();
    const ownerActorId = await resolveCanonicalOwnerActorId(
      input.tenantId,
      input.actorId,
      sql,
    );
    if (isBuiltInAgentIdentityId(input.agentId)) {
      return buildBuiltInAgentIdentityV1({
        agentId: input.agentId,
        tenantId: input.tenantId,
        controllerActorId: ownerActorId,
      });
    }
    return resolveCustomAgentIdentityWithSql({
      tenantId: input.tenantId,
      agentId: input.agentId,
      ownerActorId,
      sql,
    });
  }
  if (isBuiltInAgentIdentityId(input.agentId)) {
    return buildBuiltInAgentIdentityV1({
      agentId: input.agentId,
      tenantId: input.tenantId,
      controllerActorId: input.actorId,
    });
  }
  if (!input.customAgent) throw new AgentIdentityResolutionError();
  return buildCustomAgentIdentityV1({
    agent: input.customAgent,
    skills: input.customSkills || [],
    definitionVersion: 1,
    principalGeneration: 1,
  });
}

export function createAgentIdentityMutationScope(
  agent: Pick<CustomAgentDefinition, "id" | "tenantId" | "actorId">,
  operation: "create" | "update" | "delete" | "skill_update",
): ExecutionScope {
  return createExecutionScope({
    tenantId: agent.tenantId,
    initiatingActorId: agent.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: agent.actorId,
    correlationId: `agent-identity:${agent.id}:${randomUUID()}`,
    purpose: `agent.identity.${operation}.v1`,
  });
}

export async function createCustomAgentIdentityWithSql(input: {
  agent: CustomAgentDefinition;
  skills: readonly AgentSkill[];
  executionScope: ExecutionScope;
  sql: IdentitySql;
}): Promise<ResolvedAgentIdentityV1> {
  const ownerActorId = await resolveCanonicalOwnerActorId(
    input.agent.tenantId,
    input.agent.actorId,
    input.sql,
  );
  const definition = await appendDefinitionVersion({
    agent: input.agent,
    skills: input.skills,
    ownerActorId,
    executionScope: input.executionScope,
    sql: input.sql,
  });
  const principal = await appendPrincipalGeneration({
    agent: input.agent,
    ownerActorId,
    definitionVersion: definition.definitionVersion,
    executionScope: input.executionScope,
    sql: input.sql,
  });
  return Object.freeze({ definition, principal });
}

export async function updateCustomAgentIdentityWithSql(input: {
  current: CustomAgentDefinition;
  next: CustomAgentDefinition;
  skills: readonly AgentSkill[];
  executionScope: ExecutionScope;
  sql: IdentitySql;
}): Promise<void> {
  const definitionChanged = agentDefinitionChanged(input.current, input.next);
  const authorityChanged = agentAuthorityChanged(input.current, input.next);
  if (!definitionChanged && !authorityChanged) return;

  const ownerActorId = await resolveCanonicalOwnerActorId(
    input.next.tenantId,
    input.next.actorId,
    input.sql,
  );
  const definitionVersion = definitionChanged
    ? (await appendDefinitionVersion({
        agent: input.next,
        skills: input.skills,
        ownerActorId,
        executionScope: input.executionScope,
        sql: input.sql,
      })).definitionVersion
    : Number((await readLatestDefinitionRow(
        input.next.tenantId,
        input.next.id,
        ownerActorId,
        input.sql,
      )).definition_version);

  if (authorityChanged) {
    await revokeCurrentPrincipal({
      tenantId: input.next.tenantId,
      agentId: input.next.id,
      ownerActorId,
      executionScope: input.executionScope,
      sql: input.sql,
    });
    await appendPrincipalGeneration({
      agent: input.next,
      ownerActorId,
      definitionVersion,
      executionScope: input.executionScope,
      sql: input.sql,
    });
  }
}

export async function revokeCustomAgentIdentityWithSql(input: {
  agent: CustomAgentDefinition;
  executionScope: ExecutionScope;
  sql: IdentitySql;
}): Promise<void> {
  const ownerActorId = await resolveCanonicalOwnerActorId(
    input.agent.tenantId,
    input.agent.actorId,
    input.sql,
  );
  await revokeCurrentPrincipal({
    tenantId: input.agent.tenantId,
    agentId: input.agent.id,
    ownerActorId,
    executionScope: input.executionScope,
    sql: input.sql,
  });
}

export async function versionCustomAgentsForSkillChangeWithSql(input: {
  tenantId: string;
  actorId: string;
  skillId: string;
  removeSkill: boolean;
  sql: IdentitySql;
}): Promise<number> {
  const rows = await input.sql`
    SELECT *
    FROM omni_custom_agents
    WHERE tenant_id = ${input.tenantId}
      AND actor_id = ${input.actorId}
      AND ${input.skillId} = ANY(skill_ids)
    ORDER BY id
    FOR UPDATE
  `;
  for (const row of rows) {
    const updatedRows = input.removeSkill
      ? await input.sql`
          UPDATE omni_custom_agents
          SET skill_ids = array_remove(skill_ids, ${input.skillId}),
              updated_at = GREATEST(
                clock_timestamp(), updated_at + INTERVAL '1 millisecond'
              )
          WHERE tenant_id = ${input.tenantId}
            AND actor_id = ${input.actorId}
            AND id = ${String(row.id)}
          RETURNING *
        `
      : await input.sql`
          UPDATE omni_custom_agents
          SET updated_at = GREATEST(
            clock_timestamp(), updated_at + INTERVAL '1 millisecond'
          )
          WHERE tenant_id = ${input.tenantId}
            AND actor_id = ${input.actorId}
            AND id = ${String(row.id)}
          RETURNING *
        `;
    if (!updatedRows[0]) {
      throw new AgentIdentityResolutionError(
        "A referenced agent could not be locked for skill versioning.",
      );
    }
    const agent = compatibilityAgentFromRow(updatedRows[0]);
    const skills = await resolveCompatibilityAgentSkills(agent, input.sql);
    const ownerActorId = await resolveCanonicalOwnerActorId(
      agent.tenantId,
      agent.actorId,
      input.sql,
    );
    await appendDefinitionVersion({
      agent,
      skills,
      ownerActorId,
      executionScope: createAgentIdentityMutationScope(agent, "skill_update"),
      sql: input.sql,
    });
  }
  return rows.length;
}

export async function resolveCustomAgentIdentityWithSql(input: {
  tenantId: string;
  agentId: string;
  ownerActorId: string;
  sql: IdentitySql;
}): Promise<ResolvedAgentIdentityV1> {
  const rows = await input.sql`
    SELECT
      definition.*,
      principal.principal_id,
      principal.principal_generation,
      principal.controller_actor_id,
      principal.state AS principal_state,
      principal.created_at AS principal_created_at,
      principal.revoked_at AS principal_revoked_at,
      policy.authority_mode,
      policy.autonomy,
      policy.approval_policy,
      policy.memory_scope,
      policy.tool_grant_ids,
      policy.context_grant_ids,
      policy.capability_grant_ids,
      policy.budget_policy_version_id,
      policy.expires_at
    FROM omni_agent_definition_versions definition
    JOIN omni_tenant_execution_principals principal
      ON principal.tenant_id = definition.tenant_id
      AND principal.agent_definition_id = definition.agent_definition_id
      AND principal.principal_kind = 'agent'
      AND principal.state = 'active'
    JOIN omni_agent_principal_policies policy
      ON policy.tenant_id = principal.tenant_id
      AND policy.principal_id = principal.principal_id
      AND policy.principal_generation = principal.principal_generation
    WHERE definition.tenant_id = ${input.tenantId}
      AND definition.agent_definition_id = ${input.agentId}
      AND definition.owner_actor_id = ${input.ownerActorId}
      AND definition.definition_version = (
        SELECT MAX(candidate.definition_version)
        FROM omni_agent_definition_versions candidate
        WHERE candidate.tenant_id = definition.tenant_id
          AND candidate.agent_definition_id = definition.agent_definition_id
      )
    LIMIT 1
  `;
  if (!rows[0]) throw new AgentIdentityResolutionError();
  return identityFromJoinedRow(rows[0], await resolveDefinitionSkills(
    rows[0],
    input.sql,
  ));
}

async function appendDefinitionVersion(input: {
  agent: CustomAgentDefinition;
  skills: readonly AgentSkill[];
  ownerActorId: string;
  executionScope: ExecutionScope;
  sql: IdentitySql;
}) {
  const latestRows = await input.sql`
    SELECT definition_version
    FROM omni_agent_definition_versions
    WHERE tenant_id = ${input.agent.tenantId}
      AND agent_definition_id = ${input.agent.id}
    ORDER BY definition_version DESC
    LIMIT 1
    FOR UPDATE
  `;
  const definitionVersion = latestRows[0]
    ? Number(latestRows[0].definition_version) + 1
    : 1;
  const identity = buildCustomAgentIdentityV1({
    agent: input.agent,
    skills: input.skills,
    ownerActorId: input.ownerActorId,
    definitionVersion,
    definitionPublishedAt: input.agent.updatedAt,
    principalId: principalId(input.agent.id),
    principalGeneration: 1,
  });
  const definition = identity.definition;
  const rows = await input.sql`
    INSERT INTO omni_agent_definition_versions (
      tenant_id, agent_definition_id, definition_version,
      previous_definition_version, owner_actor_id, slug, name, role,
      description, instructions, persona_profile, status, accent, model_policy, skill_ids,
      published_at
    ) VALUES (
      ${input.agent.tenantId}, ${input.agent.id},
      ${definition.definitionVersion},
      ${definition.definitionVersion === 1
        ? null
        : definition.definitionVersion - 1},
      ${input.ownerActorId}, ${definition.slug}, ${definition.name},
      ${definition.role}, ${definition.description}, ${definition.instructions},
      ${definition.persona}::jsonb,
      ${definition.status}, ${definition.accent}, ${definition.modelPolicy},
      ${definition.declaredSkills.map((skill) => skill.skillId)},
      ${definition.publishedAt}
    )
    RETURNING definition_version, published_at
  `;
  if (
    Number(rows[0]?.definition_version) !== definition.definitionVersion ||
    timestamp(rows[0]?.published_at) !== definition.publishedAt
  ) {
    throw new AgentIdentityResolutionError(
      "The immutable agent definition version was not persisted exactly.",
    );
  }
  await appendIdentityEvent({
    eventType: AGENT_IDENTITY_EVENT_TYPES.definitionVersioned,
    eventId: `agent-definition:${definition.definitionSha256}`,
    agentId: input.agent.id,
    executionScope: input.executionScope,
    payload: {
      schemaVersion: 1,
      definitionVersion: definition.definitionVersion,
      definitionVersionId: definition.definitionVersionId,
      definitionSha256: definition.definitionSha256,
    },
    sql: input.sql,
  });
  return definition;
}

async function appendPrincipalGeneration(input: {
  agent: CustomAgentDefinition;
  ownerActorId: string;
  definitionVersion: number;
  executionScope: ExecutionScope;
  sql: IdentitySql;
}) {
  const id = principalId(input.agent.id);
  const generationRows = await input.sql`
    SELECT COALESCE(MAX(principal_generation), 0) + 1 AS next_generation
    FROM omni_tenant_execution_principals
    WHERE tenant_id = ${input.agent.tenantId}
      AND principal_id = ${id}
  `;
  const principalGeneration = Number(generationRows[0]?.next_generation || 1);
  const heldRows = await input.sql`
    INSERT INTO omni_tenant_execution_principals (
      tenant_id, principal_kind, principal_id, principal_generation,
      controller_actor_id, agent_definition_id, system_principal_class,
      state, lifecycle_revision, created_by_actor_id
    ) VALUES (
      ${input.agent.tenantId}, 'agent', ${id}, ${principalGeneration},
      ${input.ownerActorId}, ${input.agent.id}, NULL, 'held', 0,
      ${input.ownerActorId}
    )
    RETURNING created_at
  `;
  if (!heldRows[0]) {
    throw new AgentIdentityResolutionError("The held agent principal was not created.");
  }
  const principalCreatedAt = timestamp(heldRows[0].created_at);
  const principal = buildCustomAgentIdentityV1({
    agent: input.agent,
    skills: [],
    ownerActorId: input.ownerActorId,
    definitionVersion: input.definitionVersion,
    principalId: id,
    principalGeneration,
    principalCreatedAt,
  }).principal;
  await input.sql`
    INSERT INTO omni_agent_principal_policies (
      tenant_id, principal_id, principal_generation, owner_actor_id,
      agent_definition_id, agent_definition_version, authority_mode,
      autonomy, approval_policy, memory_scope, tool_grant_ids,
      context_grant_ids, capability_grant_ids, budget_policy_version_id,
      expires_at, created_at
    ) VALUES (
      ${input.agent.tenantId}, ${id}, ${principalGeneration},
      ${input.ownerActorId}, ${input.agent.id}, ${input.definitionVersion},
      ${principal.authorityMode}, ${principal.autonomy},
      ${principal.approvalPolicy}, ${principal.memoryScope},
      ${principal.toolGrantIds}, ${principal.contextGrantIds},
      ${principal.capabilityGrantIds}, ${principal.budgetPolicyVersionId},
      ${principal.expiresAt}, ${principalCreatedAt}
    )
  `;
  const activeRows = await input.sql`
    UPDATE omni_tenant_execution_principals
    SET state = 'active', lifecycle_revision = 1,
        activated_by_actor_id = ${input.ownerActorId}
    WHERE tenant_id = ${input.agent.tenantId}
      AND principal_id = ${id}
      AND principal_generation = ${principalGeneration}
      AND state = 'held'
    RETURNING state
  `;
  if (activeRows[0]?.state !== "active") {
    throw new AgentIdentityResolutionError("The agent principal was not activated.");
  }
  await appendIdentityEvent({
    eventType: AGENT_IDENTITY_EVENT_TYPES.principalVersioned,
    eventId: `agent-principal:${principal.principalSha256}`,
    agentId: input.agent.id,
    executionScope: input.executionScope,
    payload: {
      schemaVersion: 1,
      principalGeneration: principal.principalGeneration,
      principalVersionId: principal.principalVersionId,
      principalSha256: principal.principalSha256,
      definitionVersion: input.definitionVersion,
      state: "active",
    },
    sql: input.sql,
  });
  return principal;
}

async function revokeCurrentPrincipal(input: {
  tenantId: string;
  agentId: string;
  ownerActorId: string;
  executionScope: ExecutionScope;
  sql: IdentitySql;
}) {
  const id = principalId(input.agentId);
  const rows = await input.sql`
    UPDATE omni_tenant_execution_principals
    SET state = 'revoked',
        lifecycle_revision = lifecycle_revision + 1,
        revoked_by_actor_id = ${input.ownerActorId}
    WHERE tenant_id = ${input.tenantId}
      AND principal_id = ${id}
      AND controller_actor_id = ${input.ownerActorId}
      AND principal_kind = 'agent'
      AND state IN ('held', 'active')
    RETURNING principal_generation, state
  `;
  if (!rows[0] || rows[0].state !== "revoked") {
    throw new AgentIdentityResolutionError(
      "The current agent principal could not be revoked.",
    );
  }
  await appendIdentityEvent({
    eventType: AGENT_IDENTITY_EVENT_TYPES.principalRevoked,
    eventId: `agent-principal-revoked:${input.agentId}:${rows[0].principal_generation}`,
    agentId: input.agentId,
    executionScope: input.executionScope,
    payload: {
      schemaVersion: 1,
      principalGeneration: Number(rows[0].principal_generation),
      principalVersionId: `${id}:g${rows[0].principal_generation}`,
      state: "revoked",
    },
    sql: input.sql,
  });
}

async function resolveCanonicalOwnerActorId(
  tenantId: string,
  actorId: string,
  sql: IdentitySql,
) {
  const rows = await sql`
    SELECT DISTINCT identifier.canonical_actor_id
    FROM omni_auth_user_actor_identifiers identifier
    JOIN omni_auth_users auth_user
      ON auth_user.actor_id = identifier.canonical_actor_id
    JOIN omni_auth_memberships membership
      ON membership.user_id = auth_user.id
      AND membership.tenant_id = ${tenantId}
      AND membership.status = 'active'
    WHERE identifier.actor_identifier = ${actorId}
      AND auth_user.status = 'active'
    ORDER BY identifier.canonical_actor_id
    LIMIT 2
  `;
  if (rows.length !== 1) {
    throw new AgentIdentityResolutionError(
      "The agent owner does not have one canonical active tenant identity.",
    );
  }
  return String(rows[0].canonical_actor_id);
}

async function readLatestDefinitionRow(
  tenantId: string,
  agentId: string,
  ownerActorId: string,
  sql: IdentitySql,
) {
  const rows = await sql`
    SELECT *
    FROM omni_agent_definition_versions
    WHERE tenant_id = ${tenantId}
      AND agent_definition_id = ${agentId}
      AND owner_actor_id = ${ownerActorId}
    ORDER BY definition_version DESC
    LIMIT 1
    FOR UPDATE
  `;
  if (!rows[0]) throw new AgentIdentityResolutionError();
  return rows[0];
}

async function resolveDefinitionSkills(
  definitionRow: Record<string, unknown>,
  sql: IdentitySql,
) {
  const skillIds = stringArray(definitionRow.skill_ids);
  const selectedBuiltIns = builtInSkills.filter((skill) => skillIds.includes(skill.id));
  const customIds = skillIds.filter((id) =>
    !selectedBuiltIns.some((skill) => skill.id === id)
  );
  const customRows = customIds.length
    ? await sql`
        SELECT skill.*
        FROM omni_custom_skills skill
        JOIN omni_auth_user_actor_identifiers identifier
          ON identifier.actor_identifier = skill.actor_id
          AND identifier.canonical_actor_id = ${String(definitionRow.owner_actor_id)}
        WHERE skill.tenant_id = ${String(definitionRow.tenant_id)}
          AND skill.id = ANY(${customIds}::text[])
        ORDER BY skill.id
      `
    : [];
  const customSkills = customRows.map(skillFromRow);
  if (selectedBuiltIns.length + customSkills.length !== skillIds.length) {
    throw new AgentIdentityResolutionError(
      "One or more exact agent skill versions are unavailable.",
    );
  }
  return [...selectedBuiltIns, ...customSkills];
}

async function resolveCompatibilityAgentSkills(
  agent: CustomAgentDefinition,
  sql: IdentitySql,
) {
  const selectedBuiltIns = builtInSkills.filter((skill) =>
    agent.skillIds.includes(skill.id)
  );
  const customIds = agent.skillIds.filter((id) =>
    !selectedBuiltIns.some((skill) => skill.id === id)
  );
  const rows = customIds.length
    ? await sql`
        SELECT *
        FROM omni_custom_skills
        WHERE tenant_id = ${agent.tenantId}
          AND actor_id = ${agent.actorId}
          AND id = ANY(${customIds}::text[])
        ORDER BY id
        FOR KEY SHARE
      `
    : [];
  if (selectedBuiltIns.length + rows.length !== agent.skillIds.length) {
    throw new AgentIdentityResolutionError(
      "One or more referenced skill versions are unavailable.",
    );
  }
  return [...selectedBuiltIns, ...rows.map(skillFromRow)];
}

function identityFromJoinedRow(
  row: Record<string, unknown>,
  skills: readonly AgentSkill[],
): ResolvedAgentIdentityV1 {
  const definitionVersion = Number(row.definition_version);
  const principalGeneration = Number(row.principal_generation);
  if (
    !Number.isSafeInteger(definitionVersion) || definitionVersion < 1 ||
    !Number.isSafeInteger(principalGeneration) || principalGeneration < 1 ||
    row.principal_state !== "active" ||
    row.controller_actor_id !== row.owner_actor_id
  ) {
    throw new AgentIdentityResolutionError("The stored agent identity is inconsistent.");
  }
  const agent: CustomAgentDefinition = {
    id: String(row.agent_definition_id),
    tenantId: String(row.tenant_id),
    actorId: String(row.owner_actor_id),
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
    toolIds: stringArray(row.tool_grant_ids),
    createdAt: timestamp(row.published_at),
    updatedAt: timestamp(row.published_at),
  };
  const identity = buildCustomAgentIdentityV1({
    agent,
    skills,
    definitionVersion,
    definitionPublishedAt: timestamp(row.published_at),
    ownerActorId: String(row.owner_actor_id),
    principalId: String(row.principal_id),
    principalGeneration,
    principalState: "active",
    principalAuthorityMode: String(row.authority_mode) as "server_policy" | "explicit_grants",
    principalContextGrantIds: stringArray(row.context_grant_ids),
    principalCapabilityGrantIds: stringArray(row.capability_grant_ids),
    principalBudgetPolicyVersionId: String(row.budget_policy_version_id),
    principalExpiresAt: row.expires_at ? timestamp(row.expires_at) : null,
    principalCreatedAt: timestamp(row.principal_created_at),
  });
  return Object.freeze({
    definition: parseAgentDefinitionV1(identity.definition),
    principal: parseAgentPrincipalDefinitionV1(identity.principal),
  });
}

function appendIdentityEvent(input: {
  eventType: string;
  eventId: string;
  agentId: string;
  executionScope: ExecutionScope;
  payload: Record<string, unknown>;
  sql: IdentitySql;
}) {
  return appendScopedDomainEvent({
    id: input.eventId,
    type: input.eventType,
    streamId: `agent:${input.agentId}`,
    executionScope: input.executionScope,
    payload: input.payload,
  }, { sql: input.sql });
}

export function agentDefinitionChanged(
  current: CustomAgentDefinition,
  next: CustomAgentDefinition,
) {
  return fieldsChanged(current, next, [
    "slug", "name", "role", "description", "instructions", "status",
    "persona", "accent", "modelPolicy", "skillIds",
  ]);
}

export function agentAuthorityChanged(
  current: CustomAgentDefinition,
  next: CustomAgentDefinition,
) {
  return fieldsChanged(current, next, [
    "autonomy", "approvalPolicy", "memoryScope", "toolIds",
  ]);
}

function fieldsChanged(
  current: CustomAgentDefinition,
  next: CustomAgentDefinition,
  fields: readonly (keyof CustomAgentDefinition)[],
) {
  return fields.some((field) =>
    JSON.stringify(current[field]) !== JSON.stringify(next[field])
  );
}

function principalId(agentId: string) {
  return `agent:${agentId}`;
}

function skillFromRow(row: Record<string, unknown>): AgentSkill {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.actor_id),
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    instructions: String(row.instructions),
    category: String(row.category) as AgentSkill["category"],
    status: String(row.status) as AgentSkill["status"],
    version: Number(row.version),
    toolIds: stringArray(row.tool_ids),
    tags: stringArray(row.tags),
    knowledgeTags: stringArray(row.knowledge_tags),
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function compatibilityAgentFromRow(
  row: Record<string, unknown>,
): CustomAgentDefinition {
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

function timestamp(value: unknown) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new AgentIdentityResolutionError("An agent identity timestamp is invalid.");
  }
  return parsed.toISOString();
}
