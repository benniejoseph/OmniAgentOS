import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { customAgentPatchSchema } from "@/lib/skills/schema";
import { createAgentSkill, createCustomAgent, deleteAgentSkill, listAgentSkills, listCustomAgents, updateCustomAgent } from "@/lib/skills/store";

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
});
