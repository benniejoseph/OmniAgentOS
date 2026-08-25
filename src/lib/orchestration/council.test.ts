import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ createStructuredResponse: vi.fn() }));
vi.mock("@/lib/openai/client", () => ({ createStructuredResponse: mocks.createStructuredResponse }));
vi.mock("@/lib/agents/learning", () => ({
  getAgentLearningGuidance: vi.fn(async (agentId: string) => [`Improve ${agentId} output with explicit evidence.`]),
}));

import {
  formatCouncilContributions,
  reviewCouncilResponse,
  reviseCouncilResponse,
  runCouncilRound,
} from "@/lib/orchestration/council";

describe("agent council", () => {
  beforeEach(() => mocks.createStructuredResponse.mockReset());

  it("runs non-primary specialists independently and reserves Sentinel for review", async () => {
    mocks.createStructuredResponse
      .mockResolvedValueOnce(JSON.stringify({ summary: "Research complete", findings: ["A"], risks: [], recommendation: "Use A", evidenceIds: ["memory:1"], confidence: 0.8 }))
      .mockResolvedValueOnce(JSON.stringify({ summary: "Build plan complete", findings: ["B"], risks: ["C"], recommendation: "Build B", evidenceIds: [], confidence: 0.7 }));

    const contributions = await runCouncilRound({
      goal: "Research and build a verified system",
      mode: "orchestrate",
      primaryAgentId: "atlas",
      specialistIds: ["atlas", "scout", "forge", "sentinel"],
      contextBlock: "[memory:1] Existing evidence",
      tenantId: "personal",
    });

    expect(contributions.map((item) => item.agentId)).toEqual(["scout", "forge"]);
    expect(contributions.every((item) => item.status === "completed")).toBe(true);
    expect(mocks.createStructuredResponse).toHaveBeenCalledTimes(2);
    expect(formatCouncilContributions(contributions)).toContain("Scout (Research)");
  });

  it("lets Sentinel fail a response and Atlas revise it", async () => {
    mocks.createStructuredResponse
      .mockResolvedValueOnce(JSON.stringify({ passed: false, score: 0.45, assessment: "Evidence is missing.", requiredChanges: ["Cite the source."] }))
      .mockResolvedValueOnce(JSON.stringify({ response: "Revised response [memory:1]." }));
    const contributions = [{
      agentId: "scout" as const, name: "Scout", role: "Research", status: "completed" as const,
      summary: "Found evidence.", findings: ["Fact"], risks: [], recommendation: "Cite it",
      evidenceIds: ["memory:1"], confidence: 0.9, durationMs: 12,
    }];
    const verdict = await reviewCouncilResponse({ goal: "Answer", response: "Draft", contributions, contextBlock: "Evidence" });
    expect(verdict).toMatchObject({ passed: false, score: 0.45, requiredChanges: ["Cite the source."] });
    await expect(reviseCouncilResponse({ goal: "Answer", response: "Draft", verdict, contributions }))
      .resolves.toBe("Revised response [memory:1].");
  });
});
