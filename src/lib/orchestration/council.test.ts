import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ generateModelStructured: vi.fn() }));
vi.mock("@/lib/models/gateway", () => ({ generateModelStructured: mocks.generateModelStructured }));
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
  beforeEach(() => mocks.generateModelStructured.mockReset());

  it("runs non-primary specialists independently and reserves Sentinel for review", async () => {
    mocks.generateModelStructured
      .mockResolvedValueOnce({ text: JSON.stringify({ summary: "Research complete", findings: ["A"], risks: [], recommendation: "Use A", evidenceIds: ["memory:1"], confidence: 0.8 }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ summary: "Build plan complete", findings: ["B"], risks: ["C"], recommendation: "Build B", evidenceIds: [], confidence: 0.7 }) });

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
    expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2);
    expect(formatCouncilContributions(contributions)).toContain("Scout (Research)");
  });

  it("serializes enrolled members and observes delegation/model boundaries", async () => {
    const first = Promise.withResolvers<ReturnType<typeof modelResult>>();
    const second = Promise.withResolvers<ReturnType<typeof modelResult>>();
    mocks.generateModelStructured
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const events: string[] = [];
    const pending = runCouncilRound({
      goal: "Verify checkpoints",
      mode: "orchestrate",
      primaryAgentId: "atlas",
      specialistIds: ["scout", "forge"],
      contextBlock: "Evidence",
      checkpointHooks: {
        serializeMembers: true,
        beforeDelegation: async ({ agentId, requestSha256 }) => {
          events.push(`${agentId}:delegation:before:${requestSha256.length}`);
        },
        beforeModel: async ({ sourceId }) => {
          events.push(`${sourceId}:model:before`);
        },
        afterModel: async ({ sourceId, status }) => {
          events.push(`${sourceId}:model:${status}`);
        },
        afterDelegation: async ({ agentId, status, receiptSha256 }) => {
          events.push(
            `${agentId}:delegation:${status}:${receiptSha256.length}`,
          );
        },
      },
    });

    await vi.waitFor(() => expect(mocks.generateModelStructured).toHaveBeenCalledTimes(1));
    first.resolve(modelResult("Scout complete"));
    await vi.waitFor(() => expect(mocks.generateModelStructured).toHaveBeenCalledTimes(2));
    second.resolve(modelResult("Forge complete"));
    await expect(pending).resolves.toHaveLength(2);

    expect(events).toEqual([
      "scout:delegation:before:64",
      "delegation:scout:model:before",
      "delegation:scout:model:completed",
      "scout:delegation:completed:64",
      "forge:delegation:before:64",
      "delegation:forge:model:before",
      "delegation:forge:model:completed",
      "forge:delegation:completed:64",
    ]);
  });

  it("lets Sentinel fail a response and Atlas revise it", async () => {
    mocks.generateModelStructured
      .mockResolvedValueOnce({ text: JSON.stringify({ passed: false, score: 0.45, assessment: "Evidence is missing.", requiredChanges: ["Cite the source."] }) })
      .mockResolvedValueOnce({ text: JSON.stringify({ response: "Revised response [memory:1]." }) });
    const contributions = [{
      agentId: "scout" as const, name: "Scout", role: "Research", status: "completed" as const,
      summary: "Found evidence.", findings: ["Fact"], risks: [], recommendation: "Cite it",
      evidenceIds: ["memory:1"], confidence: 0.9, durationMs: 12,
    }];
    const events: string[] = [];
    const checkpointHooks = {
      beforeVerifier: async ({ requestSha256 }: { requestSha256: string }) => {
        events.push(`verifier:before:${requestSha256.length}`);
      },
      afterVerifier: async ({ status, receiptSha256 }: {
        status: "completed" | "failed";
        receiptSha256: string;
      }) => {
        events.push(`verifier:${status}:${receiptSha256.length}`);
      },
      beforeModel: async ({ sourceId }: { sourceId: string }) => {
        events.push(`${sourceId}:before`);
      },
      afterModel: async ({ sourceId, status }: {
        sourceId: string;
        status: "completed" | "failed";
      }) => {
        events.push(`${sourceId}:${status}`);
      },
    };
    const verdict = await reviewCouncilResponse({
      goal: "Answer",
      response: "Draft",
      contributions,
      contextBlock: "Evidence",
      checkpointHooks,
    });
    expect(verdict).toMatchObject({ passed: false, score: 0.45, requiredChanges: ["Cite the source."] });
    await expect(reviseCouncilResponse({
      goal: "Answer",
      response: "Draft",
      verdict,
      contributions,
      contextBlock: "[memory:1] Exact evidence",
      checkpointHooks,
    }))
      .resolves.toBe("Revised response [memory:1].");
    expect(mocks.generateModelStructured.mock.calls[1]?.[0]?.input).toContain("[memory:1] Exact evidence");
    expect(events).toEqual([
      "verifier:before:64",
      "verifier:sentinel:before",
      "verifier:sentinel:completed",
      "verifier:completed:64",
      "revision:atlas:before",
      "revision:atlas:completed",
    ]);
  });
});

function modelResult(summary: string) {
  return {
    text: JSON.stringify({
      summary,
      findings: [],
      risks: [],
      recommendation: "Continue.",
      evidenceIds: [],
      confidence: 0.8,
    }),
    provider: "openai" as const,
    model: "gpt-test",
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      totalTokens: 15,
    },
    latencyMs: 20,
    costKnown: false,
    attempts: [],
  };
}
