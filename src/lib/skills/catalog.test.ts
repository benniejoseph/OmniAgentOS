import { describe, expect, it } from "vitest";
import {
  BUILT_IN_SKILL_IDS,
  builtInSkills,
  getBuiltInSkill,
} from "@/lib/skills/catalog";
import { skillInputSchema } from "@/lib/skills/schema";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { getGovernedTools } from "@/lib/tools/registry";

const curatedSkillIds = [
  "productivity.daily-focus",
  "productivity.project-planning",
  "productivity.meeting-steward",
  "productivity.decision-memo",
  "design.product-ux",
  "design.systems-accessibility",
  "design.visual-critique",
  "engineering.implementation",
  "engineering.debugging",
  "engineering.review-security",
  "engineering.quality-performance",
  "communication.clear-writing",
  "automation.workflow-design",
  "learning.knowledge-synthesis",
];

describe("built-in Skill catalog", () => {
  it("ships the curated productivity, design, engineering, and supporting library", () => {
    for (const id of curatedSkillIds) {
      expect(getBuiltInSkill(id), id).toBeDefined();
    }

    expect(builtInSkills.flatMap((skill) => skill.tags)).toEqual(
      expect.arrayContaining([
        "productivity",
        "design",
        "coding",
        "writing",
        "automation",
        "learning",
      ]),
    );
  });

  it("keeps every built-in stable, system-owned, active, and prompt-bounded", () => {
    expect(new Set(builtInSkills.map((skill) => skill.id)).size).toBe(builtInSkills.length);
    expect(new Set(builtInSkills.map((skill) => skill.slug)).size).toBe(builtInSkills.length);
    expect(BUILT_IN_SKILL_IDS).toEqual(builtInSkills.map((skill) => skill.id));
    expect(Object.isFrozen(BUILT_IN_SKILL_IDS)).toBe(true);

    for (const skill of builtInSkills) {
      expect(skill, skill.id).toMatchObject({
        tenantId: "system",
        actorId: "system",
        status: "active",
        version: 1,
        builtIn: true,
      });
      expect(skill.instructions.length, skill.id).toBeGreaterThanOrEqual(10);
      expect(skill.instructions.length, skill.id).toBeLessThanOrEqual(1_200);
      expect(skill.toolIds.length, skill.id).toBeLessThanOrEqual(50);
      expect(new Set(skill.toolIds).size, skill.id).toBe(skill.toolIds.length);
      expect(skillInputSchema.safeParse({
        name: skill.name,
        description: skill.description,
        instructions: skill.instructions,
        category: skill.category,
        status: skill.status,
        toolIds: skill.toolIds,
        tags: skill.tags,
        knowledgeTags: skill.knowledgeTags,
      }).success, skill.id).toBe(true);
    }
  });

  it("keeps every released built-in Skill v1 definition append-only", () => {
    const expectedSkillDigests = {
      "core.research": "03671be2d1509e9c5c5037b42148c237d2457cb1c6639bf173d06d4d875be089",
      "core.builder": "cd76bd8c4ffdd8e380230a7f1eb1150ba3b1a27398fcd100d7331e154e7898a6",
      "core.critic": "03cf2528f1adf2dd32e084be3ff4dcee7cc9abd5717aae55d1f5dacbbbe97c17",
      "core.memory": "9c47b698375f3a47bcbc2c04dd6990b89701927c970a256fc3518c32bbc749ea",
      "productivity.daily-focus": "2ca23fcf3940a41d92383d0ad015583f015a925ac68c454a7b7b8872b75db218",
      "productivity.project-planning": "2995d149c715a303f574af59350c986f908033ac37507540485a88de4b09b0ca",
      "productivity.meeting-steward": "900daa0411eb178d25c3882a788490b2fb5531c1246381a2f2ab9f666b40fbf2",
      "productivity.decision-memo": "8bc21db43ad9ac62900b593b2af60a65921b1935ca23f00a0fd75f55c556d725",
      "design.product-ux": "58a23a4310a3af20639cff62b5f9b287073500fe3def811d046328662adb1e02",
      "design.systems-accessibility": "72f55e534bb04f0609b7afbd944d508775e2dd4c4d82919ea1a09c44292b7c75",
      "design.visual-critique": "e48f5c3ce88982eafbb4ef6973b69cccdf42d5059217704b769925586c2b8632",
      "engineering.implementation": "41a9ea10dbef336175d624d0a1ec390d0b922fa5250d9592a73bc7edba4f2d43",
      "engineering.debugging": "4f1ed60df97842ede513536bc95bac3bee203a12b8a9546572d26fe953ecd107",
      "engineering.review-security": "90d91fd541ffde071a50a4f5668168ae942a466bed19b12587d1f5c67a4bf007",
      "engineering.quality-performance": "557845d867c44d13a2b6305724eda9a8ff8f676529627f99f3010e48f88f607f",
      "communication.clear-writing": "14407562a2c6a97b4c587cc492536d1702ea9ed6e42144aba5e861a47d94c0ec",
      "automation.workflow-design": "403054176ec73262579d3f90b0c8f50c0b4c978385bae2684a3d8bc00ac7629b",
      "learning.knowledge-synthesis": "5effb4af8fd1ba83b9a9a6fcf54a9171172f1c7278ecdf668a443066277a23f1",
    } as const;

    expect(Object.keys(expectedSkillDigests)).toEqual(BUILT_IN_SKILL_IDS);

    for (const [id, expectedDigest] of Object.entries(expectedSkillDigests)) {
      const skill = getBuiltInSkill(id);
      expect(skill, id).toBeDefined();
      expect(sourceContractSha256({
        skillId: skill!.id,
        version: skill!.version,
        name: skill!.name,
        description: skill!.description,
        instructions: skill!.instructions,
        category: skill!.category,
        toolIds: [...new Set(skill!.toolIds)].sort(),
      }), id).toBe(expectedDigest);
    }
  });

  it("references only operations exposed by the governed tool registry", () => {
    const governedToolIds = new Set(getGovernedTools().map((tool) => tool.id));
    const unknownToolBindings = builtInSkills.flatMap((skill) =>
      skill.toolIds
        .filter((toolId) => !governedToolIds.has(toolId))
        .map((toolId) => `${skill.id}:${toolId}`),
    );

    expect(unknownToolBindings).toEqual([]);
  });
});
