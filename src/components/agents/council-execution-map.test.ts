import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CouncilExecutionMap } from "@/components/agents/council-execution-map";
import type { AgentCouncilMap } from "@/lib/agents/council-map-contract";

describe("P11.5 Council execution map", () => {
  it("renders governed member facts and verifier state", () => {
    const markup = renderToStaticMarkup(createElement(CouncilExecutionMap, {
      map,
      state: "ready",
    }));
    expect(markup).toContain("Live Council map");
    expect(markup).toContain("Scout");
    expect(markup).toContain("1 context grant");
    expect(markup).toContain("knowledge.search");
    expect(markup).toContain("Evidence verified");
    expect(markup).toContain("Sentinel");
    expect(markup).toContain("91%");
  });

  it("does not imply authority when the ledger is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(CouncilExecutionMap, {
      state: "unavailable",
    }));
    expect(markup).toContain("Council map unavailable");
    expect(markup).toContain("No authority was inferred");
  });
});

const identity = {
  agentId: "scout", name: "Scout", role: "Research",
  charter: "Verify evidence.", visualIdentity: "Blue trailfinder",
  definitionVersion: 1, source: "agent_definition" as const,
};

const map: AgentCouncilMap = {
  version: "p11.5-agent-council-map:1",
  authority: "canonical_delegation_ledger",
  generatedAt: "2026-09-07T06:01:00.000Z",
  state: "ready",
  summary: {
    executionCount: 1, memberCount: 1, activeMemberCount: 1,
    waitingMemberCount: 0, acceptedMemberCount: 0,
    knownEstimatedCostMicrousd: 1_650,
  },
  executions: [{
    parentExecutionId: "run-one",
    href: "/app/command?run=run-one",
    status: "running",
    currentWork: "Verify the release evidence.",
    startedAt: "2026-09-07T06:00:00.000Z",
    updatedAt: "2026-09-07T06:00:30.000Z",
    verifierCost: {
      authority: "ai_usage_ledger_v1", state: "exact", receiptCount: 1,
      unknownCostReceiptCount: 0, totalTokens: 120, knownEstimatedCostMicrousd: 400,
    },
    members: [{
      taskId: "task-one", delegationId: "delegation-one", identity,
      state: "working", lifecycleRevision: 2,
      currentWork: "Verify the release evidence.", updatedAt: "2026-09-07T06:00:30.000Z",
      authority: {
        source: "delegation_grants", receiptSha256: "a".repeat(64), contractSha256: "b".repeat(64),
        purpose: "council.member.scout",
        scope: { workspaceId: null, projectId: "project-one", missionId: "mission-one" },
        context: { state: "granted", grantCount: 1 },
        capabilities: { state: "granted", grantCount: 1 },
        tools: { state: "granted", ids: ["knowledge.search"] },
        budgets: { modelTurns: 2, tokens: 2_000, costMicrousd: 5_000, wallTimeMs: 60_000, toolCalls: 1, browserActions: 0 },
      },
      messages: { state: "available", items: [] },
      outputs: {
        state: "shared", proposalReceiptSha256: null,
        items: [{
          artifactId: "output-one", title: "Scout contribution", kind: "council_contribution",
          mediaType: "text/plain", content: "Evidence verified.",
          createdAt: "2026-09-07T06:00:30.000Z", trust: "untrusted_shared_content",
        }],
      },
      cost: {
        authority: "ai_usage_ledger_v1", state: "exact", receiptCount: 1,
        unknownCostReceiptCount: 0, totalTokens: 420, knownEstimatedCostMicrousd: 1_250,
      },
      confidence: .91,
      verifier: {
        identity: { ...identity, agentId: "sentinel", name: "Sentinel", role: "Critic" },
        acceptanceThreshold: .8, method: "deterministic_schema_and_evidence",
        verdict: "pending", score: null,
      },
    }],
  }],
};
