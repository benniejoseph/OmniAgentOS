import { beforeEach, describe, expect, it, vi } from "vitest";
import { builtInSkills } from "@/lib/skills/catalog";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const responses: Array<Record<string, unknown>[] | Error> = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      const response = responses.shift() || [];
      return response instanceof Error
        ? Promise.reject(response)
        : Promise.resolve(response);
    },
  );
  const transaction = vi.fn(
    async (callback: (client: typeof sql) => Promise<unknown>) => callback(sql),
  );
  Object.assign(sql, { transaction });
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getDatabaseTenantContext: vi.fn(() => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    responses,
    sql,
    statements,
    transaction,
  };
});

const identityMocks = vi.hoisted(() => ({
  createAgentIdentityMutationScope: vi.fn(() => ({ purpose: "test" })),
  createCustomAgentIdentityWithSql: vi.fn(async () => ({
    definition: {
      definitionVersion: 1,
      ownerActorId: "actor:11111111-1111-4111-8111-111111111111",
    },
  })),
  revokeCustomAgentIdentityWithSql: vi.fn(async () => undefined),
  updateCustomAgentIdentityWithSql: vi.fn(async () => undefined),
  versionCustomAgentsForSkillChangeWithSql: vi.fn(async () => 0),
}));

const releaseMocks = vi.hoisted(() => ({
  initializeAgentReleaseChannelWithSql: vi.fn(async () => undefined),
  retireAgentReleaseChannelWithSql: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
  getDatabaseTenantContext: dbMocks.getDatabaseTenantContext,
  getSql: dbMocks.getSql,
  hasDatabaseUrl: dbMocks.hasDatabaseUrl,
}));

vi.mock("@/lib/agents/identity-store", () => identityMocks);
vi.mock("@/lib/agents/release-store", () => releaseMocks);

import {
  AgentSkillAssignmentError,
  CustomAgentReadConflictError,
  createCustomAgent,
  deleteCustomAgent,
  getCustomAgent,
  getCustomAgentForRequest,
  listCustomAgentsForRequest,
  updateCustomAgent,
} from "@/lib/skills/store";

const scope = { tenantId: "tenant-a", actorId: "owner@example.test" };
const authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const requestActorBinding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([scope.actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, scope.actorId]),
};

beforeEach(() => {
  dbMocks.responses.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.sql.mockClear();
  dbMocks.transaction.mockClear();
  for (const mock of Object.values(identityMocks)) mock.mockClear();
  for (const mock of Object.values(releaseMocks)) mock.mockClear();
});

describe("Postgres custom Agent Skill integrity", () => {
  it("validates normalized exact-owner custom Skill IDs in the Agent insert transaction", async () => {
    const customSkillId = "custom-skill";
    dbMocks.responses.push(
      [],
      [skillOwnerRow(customSkillId)],
      [agentRow("agent-a", [builtInSkills[0].id, customSkillId])],
    );

    const agent = await createCustomAgent(agentInput([
      builtInSkills[0].id,
      ` ${customSkillId} `,
      customSkillId,
    ]), scope);

    expect(agent.skillIds).toEqual([builtInSkills[0].id, customSkillId]);
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    const validation = dbMocks.statements.find((statement) =>
      /FROM omni_custom_skills/.test(statement.text),
    );
    expect(validation?.text).toMatch(
      /ORDER BY id COLLATE "C"[\s\S]*FOR KEY SHARE/,
    );
    expect(validation?.params).toEqual([
      scope.tenantId,
      scope.actorId,
      [customSkillId],
    ]);
    expect(dbMocks.statements.some((statement) =>
      /INSERT INTO omni_custom_agents/.test(statement.text)
    )).toBe(true);
    expect(identityMocks.createCustomAgentIdentityWithSql).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-a" }),
        sql: dbMocks.sql,
      }),
    );
    expect(releaseMocks.initializeAgentReleaseChannelWithSql)
      .toHaveBeenCalledWith(expect.objectContaining({
        definitionVersion: 1,
        canonicalActorId,
        sql: dbMocks.sql,
      }));
  });

  it("fails closed before insert when a custom Skill is missing or belongs to another actor", async () => {
    dbMocks.responses.push([], []);
    await expect(createCustomAgent(agentInput(["missing-skill"]), scope))
      .rejects.toBeInstanceOf(AgentSkillAssignmentError);
    expect(dbMocks.statements.some((statement) =>
      /INSERT INTO omni_custom_agents/.test(statement.text)
    )).toBe(false);

    dbMocks.responses.push(
      [],
      [{
        id: "cross-owner-skill",
        tenant_id: scope.tenantId,
        actor_id: "another-owner@example.test",
      }],
    );
    await expect(createCustomAgent(agentInput(["cross-owner-skill"]), scope))
      .rejects.toBeInstanceOf(AgentSkillAssignmentError);
  });

  it("locks the exact Agent and validates the final normalized Skill set before update", async () => {
    dbMocks.responses.push(
      [agentRow("agent-a", [builtInSkills[0].id])],
      [skillOwnerRow("custom-skill")],
      [agentRow("agent-a", ["custom-skill"], "Updated description")],
    );

    const agent = await updateCustomAgent("agent-a", {
      description: "Updated description",
      skillIds: [" custom-skill ", "custom-skill"],
    }, scope);

    expect(agent).toMatchObject({
      id: "agent-a",
      description: "Updated description",
      skillIds: ["custom-skill"],
    });
    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.statements[0].text).toMatch(
      /SELECT \* FROM omni_custom_agents[\s\S]*FOR UPDATE/,
    );
    expect(dbMocks.statements[1].text).toMatch(
      /FROM omni_custom_skills[\s\S]*FOR KEY SHARE/,
    );
    expect(dbMocks.statements[2].text).toMatch(
      /UPDATE omni_custom_agents/,
    );
    expect(identityMocks.updateCustomAgentIdentityWithSql).toHaveBeenCalledWith(
      expect.objectContaining({
        current: expect.objectContaining({ id: "agent-a" }),
        next: expect.objectContaining({ description: "Updated description" }),
        sql: dbMocks.sql,
      }),
    );
  });

  it("translates the migration trigger constraint without leaking database details", async () => {
    const customSkillId = "sensitive-skill-id";
    dbMocks.responses.push(
      [],
      [skillOwnerRow(customSkillId)],
      Object.assign(new Error("database detail with sensitive-skill-id"), {
        code: "23514",
        constraint_name: "omni_custom_agents_skill_references_valid",
      }),
    );

    let caught: unknown;
    try {
      await createCustomAgent(agentInput([customSkillId]), scope);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AgentSkillAssignmentError);
    expect(caught).toMatchObject({
      code: "agent_skill_assignment_invalid",
      message: "One or more selected skills are unavailable for this agent.",
    });
    expect(String(caught)).not.toContain(customSkillId);
  });

  it("translates the same trigger constraint on update", async () => {
    const customSkillId = "custom-skill";
    dbMocks.responses.push(
      [agentRow("agent-a", [])],
      [skillOwnerRow(customSkillId)],
      Object.assign(new Error("raw update failure"), {
        code: "23514",
        constraint: "omni_custom_agents_skill_references_valid",
      }),
    );

    await expect(updateCustomAgent("agent-a", {
      skillIds: [customSkillId],
    }, scope)).rejects.toBeInstanceOf(AgentSkillAssignmentError);
  });

  it("revokes the split principal before deleting the compatibility row", async () => {
    dbMocks.responses.push(
      [agentRow("agent-a", [])],
      [{ owner_actor_id: canonicalActorId }],
      [{ id: "agent-a" }],
    );

    await expect(deleteCustomAgent("agent-a", scope)).resolves.toBe(true);

    expect(dbMocks.transaction).toHaveBeenCalledTimes(1);
    expect(identityMocks.revokeCustomAgentIdentityWithSql).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: "agent-a" }),
        sql: dbMocks.sql,
      }),
    );
    expect(dbMocks.statements[0].text).toMatch(/FOR UPDATE/);
    expect(dbMocks.statements[1].text).toMatch(/omni_agent_release_channels/);
    expect(dbMocks.statements[2].text).toMatch(/DELETE FROM omni_custom_agents/);
    expect(releaseMocks.retireAgentReleaseChannelWithSql)
      .toHaveBeenCalledWith(expect.objectContaining({
        canonicalActorId,
        sql: dbMocks.sql,
      }));
  });
});

describe("Postgres custom Agent request detail reads", () => {
  it("reads one global ID across the owner pair and derives actionability before projection", async () => {
    dbMocks.responses.push([{
      ...agentRow("canonical-agent", []),
      actor_id: canonicalActorId,
    }]);

    await expect(getCustomAgentForRequest("canonical-agent", {
      ...scope,
      requestActorBinding,
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-agent",
      tenantId: scope.tenantId,
      actorId: scope.actorId,
      selectable: false,
      manageable: false,
    }));
    expect(dbMocks.statements).toHaveLength(1);
    expect(dbMocks.statements[0].text).toMatch(
      /FROM omni_custom_agents agent[\s\S]*WHERE agent\.id = \$\d+ AND agent\.tenant_id = \$\d+[\s\S]*AND \(agent\.actor_id = \$\d+ OR agent\.actor_id = \$\d+\)[\s\S]*LIMIT 1/,
    );
    expect(dbMocks.statements[0].text).not.toMatch(/\bORDER BY\b/);
    expect(dbMocks.statements[0].params).toEqual([
      "canonical-agent",
      scope.tenantId,
      canonicalActorId,
      scope.actorId,
    ]);
  });

  it("falls back to an exact request query while leaving the exact helper unchanged", async () => {
    dbMocks.responses.push([agentRow("exact-request", [])]);
    await expect(getCustomAgentForRequest("exact-request", scope)).resolves.toEqual(
      expect.objectContaining({ selectable: true, manageable: true }),
    );
    expect(dbMocks.statements[0].params).toEqual([
      "exact-request",
      scope.tenantId,
      scope.actorId,
      scope.actorId,
    ]);

    dbMocks.responses.push([agentRow("exact-helper", [])]);
    const exact = await getCustomAgent("exact-helper", scope);
    expect(exact).not.toHaveProperty("selectable");
    expect(exact).not.toHaveProperty("manageable");
    expect(dbMocks.statements[1].text).not.toContain(" OR actor_id = ");
    expect(dbMocks.statements[1].params).toEqual([
      scope.tenantId,
      scope.actorId,
    ]);
  });

  it("rejects unexpected ownership and malformed or reserved custom Agent IDs", async () => {
    dbMocks.responses.push([{
      ...agentRow("wrong-owner", []),
      actor_id: "third-owner@example.test",
    }]);
    await expect(getCustomAgentForRequest("wrong-owner", {
      ...scope,
      requestActorBinding,
    })).rejects.toBeInstanceOf(CustomAgentReadConflictError);

    dbMocks.statements.splice(0);
    dbMocks.ensureDatabaseSchema.mockClear();
    await expect(getCustomAgentForRequest("atlas", {
      ...scope,
      requestActorBinding,
    })).rejects.toBeInstanceOf(CustomAgentReadConflictError);
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.statements).toHaveLength(0);

    await expect(getCustomAgentForRequest("malformed agent", {
      ...scope,
      requestActorBinding,
    })).rejects.toBeInstanceOf(CustomAgentReadConflictError);
    expect(dbMocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(dbMocks.statements).toHaveLength(0);
  });
});

describe("Postgres custom Agent request list reads", () => {
  it("keeps retired Agents visible but non-actionable", async () => {
    dbMocks.responses.push([{
      ...agentRow("retired-agent", []),
      release_state: "retired",
      active_definition_version: 1,
      latest_definition_version: 2,
    }]);

    await expect(listCustomAgentsForRequest({
      ...scope,
      requestActorBinding,
    })).resolves.toEqual([
      expect.objectContaining({
        id: "retired-agent",
        releaseState: "retired",
        activeDefinitionVersion: 1,
        latestDefinitionVersion: 2,
        selectable: false,
        manageable: false,
      }),
    ]);
  });

  it("reads both owner partitions in deterministic order and projects actionability", async () => {
    dbMocks.responses.push([
      {
        ...agentRow("canonical-agent", []),
        actor_id: canonicalActorId,
        slug: "canonical-agent",
      },
      {
        ...agentRow("exact-agent", []),
        slug: "exact-agent",
      },
    ]);

    await expect(listCustomAgentsForRequest({
      ...scope,
      requestActorBinding,
    })).resolves.toEqual([
      expect.objectContaining({
        id: "canonical-agent",
        actorId: scope.actorId,
        selectable: false,
        manageable: false,
      }),
      expect.objectContaining({
        id: "exact-agent",
        actorId: scope.actorId,
        selectable: true,
        manageable: true,
      }),
    ]);
    expect(dbMocks.statements[0].text).toMatch(
      /FROM omni_custom_agents agent[\s\S]*agent\.tenant_id = \$\d+[\s\S]*agent\.actor_id = \$\d+ OR agent\.actor_id = \$\d+[\s\S]*ORDER BY agent\.updated_at DESC, agent\.id ASC/,
    );
    expect(dbMocks.statements[0].params).toEqual([
      scope.tenantId,
      canonicalActorId,
      scope.actorId,
    ]);
  });

  it("fails the whole list on cross-owner slug collisions or invalid IDs", async () => {
    dbMocks.responses.push([
      {
        ...agentRow("canonical-agent", []),
        actor_id: canonicalActorId,
        slug: "shared-agent",
      },
      {
        ...agentRow("exact-agent", []),
        slug: "shared-agent",
      },
    ]);
    await expect(listCustomAgentsForRequest({
      ...scope,
      requestActorBinding,
    })).rejects.toBeInstanceOf(CustomAgentReadConflictError);

    dbMocks.responses.push([agentRow("malformed agent", [])]);
    await expect(listCustomAgentsForRequest({
      ...scope,
      requestActorBinding,
    })).rejects.toBeInstanceOf(CustomAgentReadConflictError);

    dbMocks.responses.push([agentRow("atlas", [])]);
    await expect(listCustomAgentsForRequest({
      ...scope,
      requestActorBinding,
    })).rejects.toBeInstanceOf(CustomAgentReadConflictError);
  });
});

function agentInput(skillIds: string[]) {
  return {
    name: "Agent A",
    role: "Specialist",
    description: "A focused custom agent.",
    instructions: "Use approved skills and stay within the requested scope.",
    status: "ready" as const,
    accent: "emerald" as const,
    modelPolicy: "auto" as const,
    autonomy: "governed" as const,
    approvalPolicy: "risk_based" as const,
    memoryScope: "all" as const,
    skillIds,
    toolIds: [],
  };
}

function skillOwnerRow(id: string) {
  return {
    id,
    tenant_id: scope.tenantId,
    actor_id: scope.actorId,
  };
}

function agentRow(
  id: string,
  skillIds: string[],
  description = "A focused custom agent.",
) {
  return {
    id,
    tenant_id: scope.tenantId,
    actor_id: scope.actorId,
    slug: "agent-a",
    name: "Agent A",
    role: "Specialist",
    description,
    instructions: "Use approved skills and stay within the requested scope.",
    status: "ready",
    accent: "emerald",
    model_policy: "auto",
    autonomy: "governed",
    approval_policy: "risk_based",
    memory_scope: "all",
    skill_ids: skillIds,
    tool_ids: [],
    release_state: "active",
    active_definition_version: 1,
    latest_definition_version: 1,
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
