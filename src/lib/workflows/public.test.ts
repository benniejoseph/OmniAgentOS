import { describe, expect, it } from "vitest";
import { publicWorkflowRun } from "@/lib/workflows/public";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

describe("public workflow projection", () => {
  it("never exposes the private durable shared-context envelope", () => {
    const run: WorkflowRunRecord = {
      id: "workflow-a",
      tenantId: "tenant-a",
      workflowType: "agent.workflow.v1",
      status: "queued",
      goal: "Prepare the Project brief",
      input: {
        goal: "Prepare the Project brief",
        metadata: {
          contextScope: "project",
          _workflowSharedContext: {
            actorBinding: { legacyOwnerActorIds: ["owner@example.test"] },
          },
        },
      },
      attempt: 0,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    };

    expect(publicWorkflowRun(run).input.metadata).toEqual({
      contextScope: "project",
    });
    expect(run.input.metadata?._workflowSharedContext).toBeDefined();
  });

  it("never exposes the private durable Agent context envelope", () => {
    const run: WorkflowRunRecord = {
      id: "workflow-agent-a",
      tenantId: "tenant-a",
      workflowType: "agent.workflow.v1",
      status: "queued",
      goal: "Use the Agent's private memory",
      input: {
        goal: "Use the Agent's private memory",
        metadata: {
          contextScope: "agent_private",
          agentId: "atlas",
          _workflowAgentPrivateContext: {
            agentIdentity: { principal: { contextGrantIds: ["grant-a"] } },
          },
        },
      },
      attempt: 0,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    };

    expect(publicWorkflowRun(run).input.metadata).toEqual({
      contextScope: "agent_private",
      agentId: "atlas",
    });
    expect(
      run.input.metadata?._workflowAgentPrivateContext,
    ).toBeDefined();
  });
});
