import { describe, expect, it } from "vitest";

import { listInternalAgentCardsV1 } from "@/lib/agents/discovery-card";
import {
  discoverInternalAgentsV1,
  selectAgentTeamFromCardsV1,
  validateAgentCardCompatibilityV1,
  type AgentDiscoveryRequestV1,
} from "@/lib/agents/discovery";

const cards = listInternalAgentCardsV1({
  tenantId: "tenant-one",
  controllerActorId: "actor-one",
});

describe("P8.5 internal Agent discovery", () => {
  it("ranks semantic specialists from validated card capabilities", () => {
    const receipt = discoverInternalAgentsV1({
      cards,
      request: request("research", "Compare primary sources and citations"),
    });

    expect(receipt).toMatchObject({
      version: "p8.5-agent-discovery-receipt:1",
      authorityImpact: "none",
    });
    expect(receipt.matches.map((match) => match.agentId)).toEqual([
      "scout",
      "meridian",
    ]);
    expect(receipt.matches[0]).toMatchObject({
      agentId: "scout",
      matchedTaskKinds: ["research"],
    });
    expect(receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("prefers the market specialist when the query carries domain evidence", () => {
    const receipt = discoverInternalAgentsV1({
      cards,
      request: request("research", "Analyze XAUUSD ICT market structure"),
    });

    expect(receipt.matches[0]).toMatchObject({
      agentId: "meridian",
      matchedTaskKinds: ["research"],
    });
  });

  it("selects and verifies a complete multi-specialist team", () => {
    const team = selectAgentTeamFromCardsV1({
      cards,
      query: "Research the evidence, implement it, and verify the result",
      taskKinds: ["research", "build"],
      consequential: false,
    });

    expect(team.primaryAgentId).toBe("forge");
    expect(team.specialistIds).toEqual(["forge", "scout", "sentinel"]);
    expect(team.cardSha256s).toHaveLength(3);
    expect(team.selectionSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("selects Sentinel as the primary agent for a verification task", () => {
    const team = selectAgentTeamFromCardsV1({
      cards,
      query: "Verify the exact claims and report the evidence",
      taskKinds: ["verify"],
      consequential: false,
    });

    expect(team.primaryAgentId).toBe("sentinel");
    expect(team.specialistIds).toEqual(["sentinel"]);
  });

  it("does not accept a preferred agent that lacks the primary capability", () => {
    const team = selectAgentTeamFromCardsV1({
      cards,
      query: "Verify the exact claims and report the evidence",
      taskKinds: ["verify"],
      consequential: false,
      preferredAgentId: "meridian",
    });

    expect(team.primaryAgentId).toBe("sentinel");
    expect(team.specialistIds).toEqual(["sentinel"]);
  });

  it("rejects requests that exceed advertised limits", () => {
    const scout = cards.find((card) => card.logicalAgentId === "scout")!;
    expect(validateAgentCardCompatibilityV1({
      card: scout,
      request: {
        ...request("research", "Research"),
        limits: {
          ...request("research", "Research").limits,
          maxFanOut: 1,
        },
      },
    })).toEqual({
      compatible: false,
      reasons: ["limits_exceeded"],
    });
  });
});

function request(
  taskKind: "research" | "build",
  query: string,
): AgentDiscoveryRequestV1 {
  return {
    query,
    taskKinds: [taskKind],
    inputModalities: ["text", "artifact_reference"],
    outputModalities: ["application/json", "artifact_reference"],
    limits: {
      maxInputArtifacts: 32,
      maxOutputArtifacts: 8,
      maxOutputBytes: 64_000,
      maxWallClockMs: 900_000,
      maxFanOut: 0,
    },
    authenticationScheme: "delegated_principal",
  };
}
