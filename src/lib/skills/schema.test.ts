import { describe, expect, it } from "vitest";
import {
  customAgentInputSchema,
  customAgentPatchSchema,
  skillInputSchema,
  skillPatchSchema,
} from "@/lib/skills/schema";
import { MAX_ASSIGNED_SKILLS } from "@/lib/skills/limits";

describe("skill and agent input schemas", () => {
  it("applies defaults when creating an agent or skill", () => {
    expect(customAgentInputSchema.parse({
      name: "Researcher",
      role: "Research agent",
      description: "Finds and synthesizes evidence.",
      instructions: "Return concise, cited findings.",
    })).toMatchObject({
      status: "ready",
      accent: "emerald",
      modelPolicy: "auto",
      autonomy: "governed",
      approvalPolicy: "risk_based",
      memoryScope: "all",
      skillIds: [],
      toolIds: [],
    });

    expect(skillInputSchema.parse({
      name: "Web research",
      description: "Researches public sources.",
      instructions: "Search, compare, and cite reliable sources.",
      category: "research",
    })).toMatchObject({
      status: "active",
      toolIds: [],
      tags: [],
      knowledgeTags: [],
    });
  });

  it("does not inject create defaults into partial agent updates", () => {
    expect(customAgentPatchSchema.parse({
      description: "Updated description",
      accent: "blue",
    })).toEqual({
      description: "Updated description",
      accent: "blue",
    });
    expect(customAgentPatchSchema.safeParse({}).success).toBe(false);
  });

  it("does not inject create defaults into partial skill updates", () => {
    expect(skillPatchSchema.parse({
      description: "Updated skill description",
    })).toEqual({
      description: "Updated skill description",
    });
    expect(skillPatchSchema.safeParse({}).success).toBe(false);
  });

  it("rejects create and update inputs above the assigned Skill limit", () => {
    const atLimit = Array.from(
      { length: MAX_ASSIGNED_SKILLS },
      (_, index) => `skill-${index + 1}`,
    );
    const overLimit = [...atLimit, "skill-over-limit"];
    const agent = {
      name: "Researcher",
      role: "Research agent",
      description: "Finds and synthesizes evidence.",
      instructions: "Return concise, cited findings.",
    };

    expect(customAgentInputSchema.safeParse({
      ...agent,
      skillIds: atLimit,
    }).success).toBe(true);
    expect(customAgentInputSchema.safeParse({
      ...agent,
      skillIds: overLimit,
    }).success).toBe(false);
    expect(customAgentPatchSchema.safeParse({ skillIds: atLimit }).success)
      .toBe(true);
    expect(customAgentPatchSchema.safeParse({ skillIds: overLimit }).success)
      .toBe(false);
  });
});
