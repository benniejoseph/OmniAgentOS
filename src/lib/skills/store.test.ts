import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtInSkills } from "@/lib/skills/catalog";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { customAgentPatchSchema } from "@/lib/skills/schema";
import {
  AgentSkillAssignmentError,
  createAgentSkill,
  createCustomAgent,
  deleteAgentSkill,
  getCustomAgentForRequest,
  listAgentSkills,
  listCustomAgents,
  updateCustomAgent,
} from "@/lib/skills/store";

describe("agent and skill studio store", () => {
  let dataDirectory = "";

  beforeEach(async () => {
    dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-agent-builder-"));
    process.env.OMNIAGENT_DATA_DIR = dataDirectory;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    delete process.env.OMNIAGENT_DATA_DIR;
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it("composes a custom agent from a reusable skill and keeps owners isolated", async () => {
    const scope = { tenantId: "private", actorId: "owner" };
    const skill = await createAgentSkill({
      name: "Daily synthesis",
      description: "Turns scattered inputs into a focused review.",
      instructions: "Summarize evidence, surface conflicts, and propose the next three actions.",
      category: "personal",
      status: "active",
      toolIds: ["memory.search"],
      tags: ["review"],
      knowledgeTags: ["daily"],
    }, scope);
    const agent = await createCustomAgent({
      name: "Compass",
      role: "Daily chief of staff",
      description: "Keeps the owner focused on the highest-leverage work.",
      instructions: "Use evidence before recommendations and make uncertainty explicit.",
      status: "ready",
      accent: "emerald",
      modelPolicy: "openai_fast",
      autonomy: "execute",
      approvalPolicy: "always",
      memoryScope: "project",
      skillIds: [skill.id],
      toolIds: ["runs.list"],
    }, scope);

    expect((await listAgentSkills(scope)).some((item) => item.id === skill.id)).toBe(true);
    expect(await listCustomAgents(scope)).toMatchObject([{ id: agent.id, skillIds: [skill.id] }]);
    expect(await listCustomAgents({ tenantId: "private", actorId: "someone-else" })).toEqual([]);

    const patched = await updateCustomAgent(agent.id, customAgentPatchSchema.parse({
      description: "Updated without changing the configured capabilities.",
      accent: "blue",
    }), scope);
    expect(patched).toMatchObject({
      description: "Updated without changing the configured capabilities.",
      accent: "blue",
      modelPolicy: "openai_fast",
      autonomy: "execute",
      approvalPolicy: "always",
      memoryScope: "project",
      skillIds: [skill.id],
      toolIds: ["runs.list"],
    });

    expect(await deleteAgentSkill(skill.id, scope)).toBe(true);
    expect(await listCustomAgents(scope)).toMatchObject([{ id: agent.id, skillIds: [] }]);
  });

  it("accepts only built-in or exact-owner custom Skills in file mode", async () => {
    const scope = { tenantId: "private", actorId: "owner" };
    const exactSkill = await createAgentSkill(skillInput("Exact Skill"), scope);
    const otherSkill = await createAgentSkill(
      skillInput("Other Skill"),
      { tenantId: "private", actorId: "other-owner" },
    );

    const agent = await createCustomAgent({
      ...agentInput("Exact Agent"),
      skillIds: [builtInSkills[0].id, ` ${exactSkill.id} `],
    }, scope);
    expect(agent.skillIds).toEqual([builtInSkills[0].id, exactSkill.id]);

    await expect(createCustomAgent({
      ...agentInput("Cross Owner Agent"),
      skillIds: [otherSkill.id],
    }, scope)).rejects.toBeInstanceOf(AgentSkillAssignmentError);
    await expect(createCustomAgent({
      ...agentInput("Missing Skill Agent"),
      skillIds: ["missing-skill"],
    }, scope)).rejects.toBeInstanceOf(AgentSkillAssignmentError);
    expect((await listCustomAgents(scope)).map((item) => item.name)).toEqual([
      "Exact Agent",
    ]);

    await expect(updateCustomAgent(agent.id, {
      description: "This update must not cross the actor boundary.",
      skillIds: [otherSkill.id],
    }, scope)).rejects.toBeInstanceOf(AgentSkillAssignmentError);
    expect(await listCustomAgents(scope)).toMatchObject([{
      id: agent.id,
      description: agent.description,
      skillIds: [builtInSkills[0].id, exactSkill.id],
    }]);
  });

  it("keeps request-bound custom Agent detail reads exact in file mode", async () => {
    const actorId = "owner@example.test";
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const canonicalActorId = `actor:${authUserId}`;
    const scope = { tenantId: "private", actorId };
    const binding: CanonicalRequestActorBindingV1 = {
      version: 1,
      kind: "auth_user",
      authUserId,
      canonicalActorId,
      legacyOwnerActorIds: Object.freeze([actorId]),
      readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
    };
    const exact = await createCustomAgent(agentInput("Exact Agent"), scope);
    const canonical = await createCustomAgent(
      agentInput("Canonical Agent"),
      { tenantId: scope.tenantId, actorId: canonicalActorId },
    );

    await expect(getCustomAgentForRequest(exact.id, {
      ...scope,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      id: exact.id,
      actorId,
      selectable: true,
      manageable: true,
    }));
    await expect(getCustomAgentForRequest(canonical.id, {
      ...scope,
      requestActorBinding: binding,
    })).resolves.toBeUndefined();
  });
});

function skillInput(name: string) {
  return {
    name,
    description: `Description for ${name}.`,
    instructions: `Instructions for ${name} with enough detail.`,
    category: "personal" as const,
    status: "active" as const,
    toolIds: [],
    tags: [],
    knowledgeTags: [],
  };
}

function agentInput(name: string) {
  return {
    name,
    role: "Specialist",
    description: `Description for ${name}.`,
    instructions: `Instructions for ${name} with enough detail.`,
    status: "ready" as const,
    accent: "emerald" as const,
    modelPolicy: "auto" as const,
    autonomy: "governed" as const,
    approvalPolicy: "risk_based" as const,
    memoryScope: "all" as const,
    skillIds: [],
    toolIds: [],
  };
}
