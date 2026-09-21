import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildCustomAgentIdentityV1 } from "@/lib/agents/identity-contracts";
import { builtInSkills } from "@/lib/skills/catalog";
import { DEFAULT_CUSTOM_AGENT_PERSONA } from "@/lib/agents/persona";
import type { CustomAgentDefinition } from "@/lib/skills/types";

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import {
  AGENT_IDENTITY_EVENT_TYPES,
  AgentIdentityResolutionError,
  agentAuthorityChanged,
  agentDefinitionChanged,
  createAgentIdentityMutationScope,
  createCustomAgentIdentityWithSql,
  resolveCustomAgentIdentityWithSql,
  rotateCustomAgentGrantAuthorityWithSql,
  updateCustomAgentIdentityWithSql,
  versionCustomAgentsForSkillChangeWithSql,
} from "@/lib/agents/identity-store";

const canonicalActorId = "actor:11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  eventMocks.appendScopedDomainEvent.mockClear();
});

describe("P7.1 custom agent identity store", () => {
  it("persists definition and authority as separate immutable versions", async () => {
    const database = fakeSql([
      [{ canonical_actor_id: canonicalActorId }],
      [],
      [{ definition_version: 1, published_at: agent().updatedAt }],
      [{ next_generation: 1 }],
      [{ created_at: agent().createdAt }],
      [],
      [{ state: "active" }],
    ]);
    const executionScope = createAgentIdentityMutationScope(agent(), "create");

    const identity = await createCustomAgentIdentityWithSql({
      agent: agent(),
      skills: [builtInSkills[0]],
      executionScope,
      sql: database.sql,
    });

    expect(identity.definition).toMatchObject({
      definitionVersion: 1,
      ownerActorId: canonicalActorId,
      declaredSkills: [{ skillId: builtInSkills[0].id, skillVersion: 1 }],
    });
    expect(identity.principal).toMatchObject({
      principalId: "agent:agent-one",
      principalGeneration: 1,
      controllerActorId: canonicalActorId,
      toolGrantIds: ["runs.list"],
    });
    expect(database.statements.some((value) =>
      /INSERT INTO omni_agent_definition_versions/.test(value.text)
    )).toBe(true);
    expect(database.statements.find((value) =>
      /SELECT definition_version\s+FROM omni_agent_definition_versions/.test(
        value.text,
      )
    )?.text).not.toMatch(/FOR UPDATE/);
    expect(database.statements.some((value) =>
      /INSERT INTO omni_agent_principal_policies/.test(value.text)
    )).toBe(true);
    expect(database.statements[0].text)
      .toMatch(/omni_ensure_personal_workspace_v1/);
    expect(database.statements.some((value) =>
      /omni_auth_user_actor_identifiers/.test(value.text)
    )).toBe(false);
    expect(database.statements.some((value) =>
      /SET state = 'active'/.test(value.text)
    )).toBe(true);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: AGENT_IDENTITY_EVENT_TYPES.definitionVersioned,
        streamId: "agent:agent-one",
        executionScope,
        payload: expect.not.objectContaining({
          instructions: expect.anything(),
          toolGrantIds: expect.anything(),
        }),
      }),
      { sql: database.sql },
    );
  });

  it("versions behavior without rotating unchanged authority", async () => {
    const current = agent();
    const next = {
      ...current,
      description: "A revised behavior description.",
      updatedAt: "2026-09-07T02:00:00.000Z",
    };
    const database = fakeSql([
      [{ canonical_actor_id: canonicalActorId }],
      [{ definition_version: 1 }],
      [{ definition_version: 2, published_at: next.updatedAt }],
    ]);

    await updateCustomAgentIdentityWithSql({
      current,
      next,
      skills: [builtInSkills[0]],
      executionScope: createAgentIdentityMutationScope(next, "update"),
      sql: database.sql,
    });

    expect(database.statements.some((value) =>
      /INSERT INTO omni_agent_definition_versions/.test(value.text)
    )).toBe(true);
    expect(database.statements.some((value) =>
      /INSERT INTO omni_tenant_execution_principals/.test(value.text)
    )).toBe(false);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(1);
  });

  it("rotates authority without creating a behavioral revision", async () => {
    const current = agent();
    const next = { ...current, autonomy: "execute" as const };
    const database = fakeSql([
      [{ canonical_actor_id: canonicalActorId }],
      [{ active_definition_version: 4 }],
      [{ principal_generation: 2, state: "revoked" }],
      [{ next_generation: 3 }],
      [{ created_at: "2026-09-07T03:00:00.000Z" }],
      [],
      [{ state: "active" }],
    ]);

    await updateCustomAgentIdentityWithSql({
      current,
      next,
      skills: [builtInSkills[0]],
      executionScope: createAgentIdentityMutationScope(next, "update"),
      sql: database.sql,
    });

    expect(database.statements.some((value) =>
      /INSERT INTO omni_agent_definition_versions/.test(value.text)
    )).toBe(false);
    expect(database.statements.some((value) =>
      /SET state = 'revoked'/.test(value.text)
    )).toBe(true);
    expect(database.statements.some((value) =>
      /INSERT INTO omni_tenant_execution_principals/.test(value.text)
    )).toBe(true);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
  });

  it("pins exact context and capability grants on a new principal generation", async () => {
    const onPrincipalHeld = vi.fn(async () => undefined);
    const database = fakeSql([
      [{ canonical_actor_id: canonicalActorId }],
      [{ active_definition_version: 4 }],
      [{ principal_generation: 2, state: "revoked" }],
      [{ next_generation: 3 }],
      [{ created_at: "2026-09-07T03:00:00.000Z" }],
      [],
      [{ state: "active" }],
    ]);

    const principal = await rotateCustomAgentGrantAuthorityWithSql({
      agent: agent(),
      contextGrantIds: ["context:read-one"],
      capabilityGrantIds: ["capability:read-one"],
      executionScope: createAgentIdentityMutationScope(agent(), "grant_update"),
      onPrincipalHeld,
      sql: database.sql,
    });

    expect(principal).toMatchObject({
      principalId: "agent:agent-one",
      principalGeneration: 3,
      contextGrantIds: ["context:read-one"],
      capabilityGrantIds: ["capability:read-one"],
    });
    expect(onPrincipalHeld).toHaveBeenCalledWith(principal);
    expect(database.statements.find((statement) =>
      /INSERT INTO omni_agent_principal_policies/.test(statement.text)
    )?.params).toEqual(expect.arrayContaining([
      ["context:read-one"],
      ["capability:read-one"],
    ]));
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledTimes(2);
  });

  it("reconstructs the exact active identity from split rows", async () => {
    const database = fakeSql([[
      {
        schema_version: 1,
        tenant_id: "tenant-one",
        agent_definition_id: "agent-one",
        definition_version: 3,
        previous_definition_version: 2,
        owner_actor_id: canonicalActorId,
        slug: "researcher",
        name: "Researcher",
        role: "Research specialist",
        description: "Finds exact evidence.",
        instructions: "Use exact evidence.",
        status: "ready",
        accent: "blue",
        model_policy: "openai_fast",
        skill_ids: [builtInSkills[0].id],
        published_at: "2026-09-07T04:00:00.000Z",
        principal_id: "agent:agent-one",
        principal_generation: 2,
        controller_actor_id: canonicalActorId,
        principal_state: "active",
        principal_created_at: "2026-09-07T03:00:00.000Z",
        principal_revoked_at: null,
        authority_mode: "explicit_grants",
        autonomy: "governed",
        approval_policy: "risk_based",
        memory_scope: "all",
        tool_grant_ids: ["runs.list"],
        context_grant_ids: [],
        capability_grant_ids: [],
        budget_policy_version_id: "agent-run-budget:2",
        expires_at: null,
      },
    ]]);

    const identity = await resolveCustomAgentIdentityWithSql({
      tenantId: "tenant-one",
      agentId: "agent-one",
      ownerActorId: canonicalActorId,
      sql: database.sql,
    });

    expect(identity.definition.definitionVersionId)
      .toBe("definition:custom:agent-one:v3");
    expect(identity.principal.principalVersionId).toBe("agent:agent-one:g2");
    expect(identity.definition.declaredSkills[0].skillSha256)
      .toMatch(/^[a-f0-9]{64}$/);
  });

  it("resolves custom skills through scoped actor functions", async () => {
    const customSkill = {
      id: "skill-one",
      tenant_id: "tenant-one",
      actor_id: "owner@example.test",
      slug: "evidence",
      name: "Evidence",
      description: "Find exact evidence.",
      instructions: "Use exact sources.",
      category: "research",
      status: "active",
      version: 1,
      tool_ids: ["runs.list"],
      tags: [],
      knowledge_tags: [],
      created_at: "2026-09-07T01:00:00.000Z",
      updated_at: "2026-09-07T01:00:00.000Z",
    };
    const database = fakeSql([[
      {
        schema_version: 1,
        tenant_id: "tenant-one",
        agent_definition_id: "agent-one",
        definition_version: 3,
        previous_definition_version: 2,
        owner_actor_id: canonicalActorId,
        slug: "researcher",
        name: "Researcher",
        role: "Research specialist",
        description: "Finds exact evidence.",
        instructions: "Use exact evidence.",
        persona_profile: DEFAULT_CUSTOM_AGENT_PERSONA,
        status: "ready",
        accent: "blue",
        model_policy: "openai_fast",
        skill_ids: ["skill-one"],
        published_at: "2026-09-07T04:00:00.000Z",
        principal_id: "agent:agent-one",
        principal_generation: 2,
        controller_actor_id: canonicalActorId,
        principal_state: "active",
        principal_created_at: "2026-09-07T03:00:00.000Z",
        principal_revoked_at: null,
        authority_mode: "explicit_grants",
        autonomy: "governed",
        approval_policy: "risk_based",
        memory_scope: "all",
        tool_grant_ids: ["runs.list"],
        context_grant_ids: [],
        capability_grant_ids: [],
        budget_policy_version_id: "agent-run-budget:2",
        expires_at: null,
      },
    ], [customSkill]]);

    const identity = await resolveCustomAgentIdentityWithSql({
      tenantId: "tenant-one",
      agentId: "agent-one",
      ownerActorId: canonicalActorId,
      sql: database.sql,
    });

    expect(identity.definition.declaredSkills).toHaveLength(1);
    expect(identity.definition.declaredSkills[0].skillId).toBe("skill-one");
    expect(database.statements[1].text)
      .toMatch(/omni_actor_scope_v1_allows\(/);
    expect(database.statements[1].text)
      .toMatch(/omni_actor_scope_v1_allows_canonical/);
    expect(database.statements[1].text)
      .not.toMatch(/omni_auth_user_actor_identifiers/);
  });

  it("executes the exact evaluated snapshot after promotion", async () => {
    const promotedAgent = {
      ...agent(),
      instructions: "Use promoted evidence policy v2.",
      updatedAt: "2026-09-07T04:00:00.000Z",
    };
    const snapshot = buildCustomAgentIdentityV1({
      agent: promotedAgent,
      skills: [builtInSkills[0]],
      ownerActorId: canonicalActorId,
      definitionVersion: 2,
      definitionPublishedAt: promotedAgent.updatedAt,
      principalGeneration: 2,
    }).definition;
    const database = fakeSql([[
      {
        schema_version: 1,
        tenant_id: promotedAgent.tenantId,
        agent_definition_id: promotedAgent.id,
        definition_version: 2,
        previous_definition_version: 1,
        owner_actor_id: canonicalActorId,
        slug: promotedAgent.slug,
        name: promotedAgent.name,
        role: promotedAgent.role,
        description: promotedAgent.description,
        instructions: "This unevaluated row must not be reconstructed.",
        persona_profile: promotedAgent.persona,
        status: promotedAgent.status,
        accent: promotedAgent.accent,
        model_policy: promotedAgent.modelPolicy,
        skill_ids: promotedAgent.skillIds,
        published_at: promotedAgent.updatedAt,
        principal_id: "agent:agent-one",
        principal_generation: 2,
        controller_actor_id: canonicalActorId,
        principal_state: "active",
        principal_created_at: "2026-09-07T03:00:00.000Z",
        principal_revoked_at: null,
        authority_mode: "explicit_grants",
        autonomy: "governed",
        approval_policy: "risk_based",
        memory_scope: "all",
        tool_grant_ids: ["runs.list"],
        context_grant_ids: [],
        capability_grant_ids: [],
        budget_policy_version_id: "agent-run-budget:2",
        expires_at: null,
        definition_snapshot: snapshot,
      },
    ]]);

    const identity = await resolveCustomAgentIdentityWithSql({
      tenantId: promotedAgent.tenantId,
      agentId: promotedAgent.id,
      ownerActorId: canonicalActorId,
      sql: database.sql,
    });

    expect(identity.definition).toEqual(snapshot);
    expect(identity.definition.instructions).toBe("Use promoted evidence policy v2.");
    expect(database.statements).toHaveLength(1);
  });

  it("fails closed when a promoted snapshot references a disabled Plugin Skill", async () => {
    const pluginSkill = {
      id: "plugin.skill.1111111111111111111111111111111111111111",
      tenantId: "tenant-one",
      actorId: "owner@example.test",
      slug: "plugin-repository-triage",
      name: "Repository triage",
      description: "Triages repository work.",
      instructions: "Review repository evidence before recommending changes.",
      category: "automation" as const,
      status: "active" as const,
      version: 1,
      toolIds: ["runs.list"],
      tags: ["repository"],
      knowledgeTags: [],
      sourcePluginInstallationId: "plugin-installation:11111111111111111111",
      sourcePluginId: "asael.github-project-kit",
      sourcePluginVersion: "1.0.0",
      sourcePluginSkillKey: "repository-triage",
      sourcePluginManifestSha256: "a".repeat(64),
      sourcePluginSkillSha256: "b".repeat(64),
      createdAt: "2026-09-07T01:00:00.000Z",
      updatedAt: "2026-09-07T01:00:00.000Z",
    };
    const promotedAgent = {
      ...agent(),
      skillIds: [pluginSkill.id],
      updatedAt: "2026-09-07T04:00:00.000Z",
    };
    const snapshot = buildCustomAgentIdentityV1({
      agent: promotedAgent,
      skills: [pluginSkill],
      ownerActorId: canonicalActorId,
      definitionVersion: 2,
      definitionPublishedAt: promotedAgent.updatedAt,
      principalGeneration: 2,
    }).definition;
    const database = fakeSql([[
      {
        schema_version: 1,
        tenant_id: promotedAgent.tenantId,
        agent_definition_id: promotedAgent.id,
        definition_version: 2,
        previous_definition_version: 1,
        owner_actor_id: canonicalActorId,
        slug: promotedAgent.slug,
        name: promotedAgent.name,
        role: promotedAgent.role,
        description: promotedAgent.description,
        instructions: promotedAgent.instructions,
        persona_profile: promotedAgent.persona,
        status: promotedAgent.status,
        accent: promotedAgent.accent,
        model_policy: promotedAgent.modelPolicy,
        skill_ids: promotedAgent.skillIds,
        published_at: promotedAgent.updatedAt,
        principal_id: "agent:agent-one",
        principal_generation: 2,
        controller_actor_id: canonicalActorId,
        principal_state: "active",
        principal_created_at: "2026-09-07T03:00:00.000Z",
        principal_revoked_at: null,
        authority_mode: "explicit_grants",
        autonomy: "governed",
        approval_policy: "risk_based",
        memory_scope: "all",
        tool_grant_ids: ["runs.list"],
        context_grant_ids: [],
        capability_grant_ids: [],
        budget_policy_version_id: "agent-run-budget:2",
        expires_at: null,
        definition_snapshot: snapshot,
      },
    ], [{
      id: pluginSkill.id,
      status: "disabled",
      source_plugin_installation_id: pluginSkill.sourcePluginInstallationId,
      source_plugin_state: "disabled",
    }]]);

    await expect(resolveCustomAgentIdentityWithSql({
      tenantId: promotedAgent.tenantId,
      agentId: promotedAgent.id,
      ownerActorId: canonicalActorId,
      sql: database.sql,
    })).rejects.toBeInstanceOf(AgentIdentityResolutionError);
    expect(database.statements[1].text).toMatch(/omni_plugin_installations/);
    expect(database.statements[1].text).toMatch(/omni_actor_scope_v1_allows/);
  });

  it("classifies behavioral and authority edits independently", () => {
    const current = agent();
    expect(agentDefinitionChanged(current, {
      ...current,
      instructions: "New behavior.",
    })).toBe(true);
    expect(agentAuthorityChanged(current, {
      ...current,
      instructions: "New behavior.",
    })).toBe(false);
    expect(agentDefinitionChanged(current, {
      ...current,
      toolIds: ["runs.list", "memory.search"],
    })).toBe(false);
    expect(agentAuthorityChanged(current, {
      ...current,
      toolIds: ["runs.list", "memory.search"],
    })).toBe(true);
  });

  it("publishes a new agent definition when a referenced skill changes", async () => {
    const changedAt = "2026-09-07T05:00:00.000Z";
    const compatibilityRow = {
      id: "agent-one",
      tenant_id: "tenant-one",
      actor_id: "owner@example.test",
      slug: "researcher",
      name: "Researcher",
      role: "Research specialist",
      description: "Finds exact evidence.",
      instructions: "Use exact evidence.",
      status: "ready",
      accent: "blue",
      model_policy: "openai_fast",
      autonomy: "governed",
      approval_policy: "risk_based",
      memory_scope: "all",
      skill_ids: ["skill-one"],
      tool_ids: ["runs.list"],
      created_at: "2026-09-07T01:00:00.000Z",
      updated_at: changedAt,
    };
    const customSkill = {
      id: "skill-one",
      tenant_id: "tenant-one",
      actor_id: "owner@example.test",
      slug: "evidence",
      name: "Evidence",
      description: "Find evidence.",
      instructions: "Use the revised exact process.",
      category: "research",
      status: "active",
      version: 4,
      tool_ids: ["runs.list"],
      tags: [],
      knowledge_tags: [],
      created_at: "2026-09-07T01:00:00.000Z",
      updated_at: changedAt,
    };
    const database = fakeSql([
      [compatibilityRow],
      [compatibilityRow],
      [customSkill],
      [{ canonical_actor_id: canonicalActorId }],
      [{ definition_version: 2 }],
      [{ definition_version: 3, published_at: changedAt }],
    ]);

    await expect(versionCustomAgentsForSkillChangeWithSql({
      tenantId: "tenant-one",
      actorId: "owner@example.test",
      skillId: "skill-one",
      removeSkill: false,
      sql: database.sql,
    })).resolves.toBe(1);

    expect(database.statements[1].text).toMatch(/UPDATE omni_custom_agents/);
    expect(database.statements[2].text).toMatch(/FROM omni_custom_skills/);
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AGENT_IDENTITY_EVENT_TYPES.definitionVersioned,
        payload: expect.objectContaining({ definitionVersion: 3 }),
      }),
      { sql: database.sql },
    );
  });
});

function agent(): CustomAgentDefinition {
  return {
    id: "agent-one",
    tenantId: "tenant-one",
    actorId: "owner@example.test",
    slug: "researcher",
    name: "Researcher",
    role: "Research specialist",
    description: "Finds exact evidence.",
    instructions: "Use exact evidence.",
    persona: DEFAULT_CUSTOM_AGENT_PERSONA,
    status: "ready",
    accent: "blue",
    modelPolicy: "openai_fast",
    autonomy: "governed",
    approvalPolicy: "risk_based",
    memoryScope: "all",
    skillIds: [builtInSkills[0].id],
    toolIds: ["runs.list"],
    createdAt: "2026-09-07T01:00:00.000Z",
    updatedAt: "2026-09-07T01:00:00.000Z",
  };
}

function fakeSql(responses: Record<string, unknown>[][]) {
  const queued = [...responses];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const callable = Object.assign(
    async (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return queued.shift() || [];
    },
    { transaction: vi.fn() },
  );
  const sql = callable as unknown as Parameters<
    typeof createCustomAgentIdentityWithSql
  >[0]["sql"];
  return { sql, statements };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
