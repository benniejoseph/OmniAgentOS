import { describe, expect, it, vi } from "vitest";

import { runDelegationBroker } from "@/lib/delegation/broker";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { ToolDefinition, ToolExecutionRecord } from "@/lib/tools/types";

describe("P8.2 delegation broker", () => {
  it("executes only a contract-granted tool under the attenuated principal", async () => {
    const executeTool = vi.fn(async ({ tool, executionScope }) => ({
      record: executionRecord(tool, "executed"),
      result: { matches: ["evidence-one"] },
      executionScope,
    }));
    const states: string[] = [];
    const result = await runDelegationBroker({
      contract: buildContract(),
      parentExecutionScope,
      tools: [tool],
      planToolCalls: async () => ({
        status: "execute",
        clarification: "",
        calls: [{
          callId: "call-one",
          toolId: tool.id,
          input: { query: "release evidence" },
          rationale: "Find the exact supporting evidence.",
        }],
      }),
      executeTool,
      onProgress: (progress) => {
        states.push(progress.state);
      },
      now: () => Date.parse("2026-09-07T06:02:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "completed",
      delegatedPrincipal: {
        audience: "asael-governed-tool-executor",
        governedToolIds: [tool.id],
        canRedelegate: false,
      },
      executionScope: {
        executingPrincipalId: result.delegatedPrincipal.principalId,
        delegationId: "delegation:one",
        capabilityGrantIds: ["grant:capability:one"],
      },
      toolResults: [{
        toolId: tool.id,
        status: "executed",
        executionId: "execution-one",
      }],
    });
    expect(executeTool).toHaveBeenCalledOnce();
    expect(executeTool.mock.calls[0]?.[0].executionScope).toMatchObject({
      executingPrincipalId: result.delegatedPrincipal.principalId,
      purpose: "delegation.tool.execute",
    });
    expect(states).toEqual([
      "accepted",
      "working",
      "tool_started",
      "tool_completed",
      "completed_proposed",
    ]);
  });

  it("fails before execution when a model requests an ungranted tool", async () => {
    const executeTool = vi.fn();
    await expect(runDelegationBroker({
      contract: buildContract(),
      parentExecutionScope,
      tools: [tool],
      planToolCalls: async () => ({
        status: "execute",
        clarification: "",
        calls: [{
          callId: "call-one",
          toolId: "memory.write",
          input: { content: "do not write" },
          rationale: "Attempt to broaden authority.",
        }],
      }),
      executeTool,
      now: () => Date.parse("2026-09-07T06:02:00.000Z"),
    })).rejects.toThrow(/ungranted tool/);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("returns a bounded clarification request without executing tools", async () => {
    const executeTool = vi.fn();
    const result = await runDelegationBroker({
      contract: buildContract(),
      parentExecutionScope,
      tools: [tool],
      planToolCalls: async () => ({
        status: "clarification_required",
        clarification: "Which release should be inspected?",
        calls: [],
      }),
      executeTool,
      now: () => Date.parse("2026-09-07T06:02:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "clarification_required",
      clarification: "Which release should be inspected?",
      toolResults: [],
    });
    expect(executeTool).not.toHaveBeenCalled();
  });

  it("stops on a governed approval boundary and reports waiting", async () => {
    const result = await runDelegationBroker({
      contract: buildContract(),
      parentExecutionScope,
      tools: [tool],
      planToolCalls: async () => ({
        status: "execute",
        clarification: "",
        calls: [{
          callId: "call-one",
          toolId: tool.id,
          input: { query: "release evidence" },
          rationale: "Find evidence.",
        }],
      }),
      executeTool: async ({ tool: grantedTool }) => ({
        record: executionRecord(grantedTool, "approval_required"),
      }),
      now: () => Date.parse("2026-09-07T06:02:00.000Z"),
    });
    expect(result).toMatchObject({
      status: "waiting",
      toolResults: [{ status: "approval_required" }],
    });
  });
});

const parentExecutionScope = createExecutionScope({
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:atlas:1",
  correlationId: "run-one",
  contextGrantIds: ["grant:context:one"],
  capabilityGrantIds: ["grant:capability:one"],
  purpose: "agent.run",
});

const tool: ToolDefinition = {
  id: "knowledge.search",
  name: "Knowledge search",
  description: "Search authorized knowledge.",
  category: "knowledge",
  status: "active",
  riskLevel: 0,
  dryRunSupported: true,
  approvalRequired: false,
  operationClass: "read_only",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string" } },
  },
};

function executionRecord(
  definition: ToolDefinition,
  status: ToolExecutionRecord["status"],
): ToolExecutionRecord {
  return {
    id: "execution-one",
    tenantId: "tenant-one",
    actorId: "actor-one",
    toolId: definition.id,
    toolName: definition.name,
    riskLevel: definition.riskLevel,
    status,
    dryRun: false,
    approvalRequired: status === "approval_required",
    input: { query: "release evidence" },
    createdAt: "2026-09-07T06:02:00.000Z",
    ...(status === "executed"
      ? { completedAt: "2026-09-07T06:02:01.000Z" }
      : {}),
  };
}
