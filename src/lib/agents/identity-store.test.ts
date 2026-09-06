import { beforeEach, describe, expect, it, vi } from "vitest";

import { builtInSkills } from "@/lib/skills/catalog";
import type { CustomAgentDefinition } from "@/lib/skills/types";

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import {
  AGENT_IDENTITY_EVENT_TYPES,
  agentAuthorityChanged,
  agentDefinitionChanged,
  createAgentIdentityMutationScope,
  createCustomAgentIdentityWithSql,
  resolveCustomAgentIdentityWithSql,
  updateCustomAgentIdentityWithSql,
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
    expect(database.statements.some((value) =>
      /INSERT INTO omni_agent_principal_policies/.test(value.text)
    )).toBe(true);
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
      [{ definition_version: 4 }],
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
