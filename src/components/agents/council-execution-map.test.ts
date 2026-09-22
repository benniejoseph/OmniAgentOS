import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CouncilExecutionMap } from "@/components/agents/council-execution-map";
import type { AgentCouncilMap } from "@/lib/agents/council-map-contract";

describe("Agent Control Center live work", () => {
  it("renders the selected execution, governed member facts, and verifier state", () => {
    const markup = renderToStaticMarkup(createElement(CouncilExecutionMap, {
      map,
      state: "ready",
    }));
    expect(markup).toContain("Live work");
    expect(markup).toContain("Execution queue");
    expect(markup).toContain("Authority &amp; limits");
    expect(markup).toContain("Scout");
    expect(markup).toContain("Context</dt><dd>1 grant");
    expect(markup).toContain("knowledge.search");
    expect(markup).toContain("Evidence verified");
    expect(markup).toContain("Sentinel");
    expect(markup).toContain("91%");
    expect(markup).toContain("Open in Command");
    expect(markup).toContain("Cancel task");
    expect(markup).toContain("Not recorded in this read-only Council projection");
  });

  it("does not imply authority when the ledger is unavailable", () => {
    const markup = renderToStaticMarkup(createElement(CouncilExecutionMap, {
      state: "unavailable",
    }));
    expect(markup).toContain("Live work unavailable");
    expect(markup).toContain("No authority was inferred");
  });

  it("provides an actionable empty state without fabricating activity", () => {
    const markup = renderToStaticMarkup(createElement(CouncilExecutionMap, {
      state: "ready",
      map: {
        ...map,
        state: "empty",
        summary: {
          executionCount: 0,
          memberCount: 0,
          activeMemberCount: 0,
          waitingMemberCount: 0,
          acceptedMemberCount: 0,
          knownEstimatedCostMicrousd: 0,
        },
        executions: [],
      },
    }));
    expect(markup).toContain("No delegated work yet");
    expect(markup).toContain("Start in Command");
    expect(markup).not.toContain("Atlas</strong><small>Coordinator");
  });

  it("selects a URL-addressed execution and worker", () => {
    const secondMember = {
      ...map.executions[0].members[0],
      taskId: "task-two",
      delegationId: "delegation-two",
      currentWork: "Build the focused interface.",
      identity: {
        ...map.executions[0].members[0].identity,
        agentId: "forge",
        name: "Forge",
      },
    };
    const secondExecution = {
      ...map.executions[0],
      parentExecutionId: "run-two",
      href: "/app/command?run=run-two" as const,
      currentWork: secondMember.currentWork,
      members: [secondMember],
    };
    const markup = renderToStaticMarkup(createElement(CouncilExecutionMap, {
      state: "ready",
      initialRunId: "run-two",
      initialTaskId: "task-two",
      map: {
        ...map,
        summary: {
          ...map.summary,
          executionCount: 2,
          memberCount: 2,
          activeMemberCount: 2,
        },
        executions: [map.executions[0], secondExecution],
      },
    }));
    expect(markup).toContain('id="current-work-title">Build the focused interface.');
    expect(markup).toContain("Forge");
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
      canCancel: true,
      runtime: null,
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
        runtime: null,
        acceptanceThreshold: .8, method: "deterministic_schema_and_evidence",
        verdict: "pending", score: null,
      },
    }],
  }],
};
