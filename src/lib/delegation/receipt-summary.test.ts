import { describe, expect, it } from "vitest";

import {
  projectSuccessfulDelegationReceipts,
  reconcileResponseWithDelegationReceipts,
  summarizeSuccessfulDelegationReceipts,
} from "@/lib/delegation/receipt-summary";
import type { GovernedToolExecutionResult } from "@/lib/tools/executor";
import type { ToolExecutionRecord, ToolExecutionStatus } from "@/lib/tools/types";

describe("delegation receipt reconciliation", () => {
  it("projects successful receipts once in governed execution order", () => {
    const scout = execution({
      task: task("dar_scout", "run_scout", "scout", "queued"),
    });
    const otherTool = execution({
      toolId: "app.runs.list",
      task: task("dar_other", "run_other", "scout", "queued"),
    });
    const duplicateScout = execution({
      task: task("dar_scout", "run_scout_changed", "meridian", "running"),
    });
    const mnemosyne = execution({
      task: task("dar_memory", "run_memory", "mnemosyne", "queued"),
    });

    expect(projectSuccessfulDelegationReceipts([
      scout,
      otherTool,
      duplicateScout,
      mnemosyne,
    ])).toEqual([
      {
        executionId: "dar_scout",
        childRunId: "run_scout",
        delegateAgentId: "scout",
        state: "queued",
      },
      {
        executionId: "dar_memory",
        childRunId: "run_memory",
        delegateAgentId: "mnemosyne",
        state: "queued",
      },
    ]);
  });

  it("formats only ordered child task IDs and their initial states", () => {
    expect(summarizeSuccessfulDelegationReceipts([
      execution({ task: task("dar_scout", "run_scout", "scout", "queued") }),
      execution({ task: task("dar_memory", "run_memory", "mnemosyne", "running") }),
    ])).toBe("- dar_scout — queued\n- dar_memory — running");
    expect(summarizeSuccessfulDelegationReceipts([])).toBeNull();
  });

  it("replaces a live model denial with server-owned delegation receipts", () => {
    const denial =
      "Delegation is unavailable in this session. No children were created, so there are no task IDs or initial states to report.";
    expect(reconcileResponseWithDelegationReceipts(denial, [
      execution({ task: task("dar_scout", "run_scout", "scout", "queued") }),
      execution({ task: task("dar_memory", "run_memory", "mnemosyne", "queued") }),
    ])).toEqual({
      response: "- dar_scout — queued\n- dar_memory — queued",
      receiptCount: 2,
      replaced: true,
    });
  });

  it.each([
    ["dry run", { dryRun: true }],
    ["approval required", { approvalRequired: true }],
    ["approved execution", { approvalDecision: "approved" as const }],
    ["approval metadata", { approvedBy: "operator-one" }],
    ["failed", { status: "failed" as const }],
    ["blocked", { status: "blocked" as const }],
    ["approval boundary", { status: "approval_required" as const }],
  ])("rejects a %s delegation record", (_label, override) => {
    expect(projectSuccessfulDelegationReceipts([
      execution({
        ...override,
        task: task("dar_rejected", "run_rejected", "scout", "queued"),
      }),
    ])).toEqual([]);
  });

  it.each([
    ["missing task", {}],
    ["array task", { task: [] }],
    ["nested pre-dispatch envelope", {
      data: { task: task("dar_nested", "run_nested", "scout", "queued") },
    }],
    ["blank execution ID", { task: task("", "run_one", "scout", "queued") }],
    ["invalid child run ID", { task: task("dar_one", "run one", "scout", "queued") }],
    ["missing agent ID", { task: task("dar_one", "run_one", "", "queued") }],
    ["unknown state", { task: task("dar_one", "run_one", "scout", "unknown") }],
  ])("rejects malformed result payload: %s", (_label, result) => {
    expect(projectSuccessfulDelegationReceipts([
      execution({ result }),
    ])).toEqual([]);
  });

  it("rejects malformed execution envelopes without throwing", () => {
    const malformed = (
      [null, {}, { record: null }, { record: {} }] as unknown
    ) as GovernedToolExecutionResult[];

    expect(projectSuccessfulDelegationReceipts(malformed)).toEqual([]);
  });
});

function task(
  executionId: string,
  childRunId: string,
  delegateAgentId: string,
  state: string,
) {
  return { executionId, childRunId, delegateAgentId, state };
}

function execution(input: {
  toolId?: string;
  status?: ToolExecutionStatus;
  dryRun?: boolean;
  approvalRequired?: boolean;
  approvalDecision?: "approved" | "rejected";
  approvedBy?: string;
  task?: ReturnType<typeof task>;
  result?: unknown;
} = {}): GovernedToolExecutionResult {
  const record: ToolExecutionRecord = {
    id: "tool_execution",
    toolId: input.toolId || "app.agents.delegate",
    toolName: "Delegate bounded agent task",
    riskLevel: 1,
    status: input.status || "executed",
    dryRun: input.dryRun ?? false,
    approvalRequired: input.approvalRequired ?? false,
    input: {},
    ...(input.approvalDecision
      ? { approvalDecision: input.approvalDecision }
      : {}),
    ...(input.approvedBy ? { approvedBy: input.approvedBy } : {}),
    createdAt: "2026-09-23T06:00:00.000Z",
    completedAt: "2026-09-23T06:00:01.000Z",
  };
  return {
    record,
    result: input.result ?? { task: input.task },
  };
}
