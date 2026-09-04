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

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
  getDatabaseTenantContext: dbMocks.getDatabaseTenantContext,
  getSql: dbMocks.getSql,
  hasDatabaseUrl: dbMocks.hasDatabaseUrl,
}));

import {
  AgentSkillAssignmentError,
  CustomAgentReadConflictError,
  createCustomAgent,
  getCustomAgent,
  getCustomAgentForRequest,
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
      /FROM omni_custom_agents[\s\S]*WHERE id = \$\d+ AND tenant_id = \$\d+[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*LIMIT 1/,
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
