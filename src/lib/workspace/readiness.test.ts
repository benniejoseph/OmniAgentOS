import { describe, expect, it } from "vitest";
import {
  calculateWorkspaceReadiness,
  loadWorkspaceReadiness,
} from "@/lib/workspace/readiness";

describe("workspace readiness", () => {
  it("maps aggregate tenant stats to five readiness checks", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 1,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 1,
      activeOAuthConnectors: 0,
      completedAgentRuns: 0,
      completedWorkflows: 1,
      evaluationTotal: 1,
    })).toMatchObject({
      checks: {
        identity: true,
        knowledge: true,
        connector: true,
        firstRun: true,
        evaluation: true,
      },
      completedCount: 5,
      totalCount: 5,
      firstSuccessfulRun: true,
    });
  });

  it("treats optional missing setup as incomplete rather than an error", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 0,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 0,
      activeOAuthConnectors: 0,
      completedAgentRuns: 0,
      completedWorkflows: 0,
      evaluationTotal: 0,
    })).toMatchObject({
      completedCount: 1,
      firstSuccessfulRun: false,
    });
  });

  it("loads every aggregate for the requested tenant", async () => {
    const calls: string[] = [];
    const aggregate = async (tenantId: string) => {
      calls.push(tenantId);
      return 0;
    };
    const readiness = await loadWorkspaceReadiness(
      { tenantId: "tenant-a", identityReady: true },
      {
        memoryTotal: aggregate,
        knowledgeTotal: aggregate,
        activeMcpConnectors: aggregate,
        activeOpenApiConnectors: aggregate,
        activeOAuthConnectors: aggregate,
        completedAgentRuns: aggregate,
        completedWorkflows: aggregate,
        evaluationTotal: aggregate,
      },
    );
    expect(calls).toEqual(Array(8).fill("tenant-a"));
    expect(readiness.checks.identity).toBe(true);
  });

  it("treats a personal Google grant as an active connector", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 0,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 0,
      activeOAuthConnectors: 1,
      completedAgentRuns: 0,
      completedWorkflows: 0,
      evaluationTotal: 0,
    }).checks.connector).toBe(true);
  });
});
