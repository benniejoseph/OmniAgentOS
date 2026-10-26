import { describe, expect, it } from "vitest";

import {
  collectDelegationReceipts,
  parseCarriedDelegationReceipts,
  projectSuccessfulDelegationReceipts,
  reconcileResponseWithDelegationReceipts,
  summarizeSuccessfulDelegationReceipts,
  type DelegationReceiptProjection,
} from "@/lib/delegation/receipt-summary";
import type { GovernedToolExecutionResult } from "@/lib/tools/executor";
import type { ToolExecutionRecord, ToolExecutionStatus } from "@/lib/tools/types";

const assignmentContinuation = "These assignment receipts do not mean the task is finished. Each specialist's result or blocker will return to this conversation; your coordinating Agent retains responsibility for the overall outcome.";

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
      response: [
        "Assigned specialist work:",
        "- Scout: queued at assignment (task `dar_scout`).",
        "- Mnemosyne: queued at assignment (task `dar_memory`).",
        "",
        assignmentContinuation,
      ].join("\n"),
      receiptCount: 2,
      replaced: true,
    });
  });

  it.each([
    "Scout finished the check.",
    "Scout has completed the research.",
    "Scout's review is complete.",
  ])("removes the unsupported completion claim %s while the specialist is only queued", (claim) => {
    const result = reconcileResponseWithDelegationReceipts(`Done. ${claim} The owner supplied two documents.`, [
      execution({ task: task("dar_scout", "run_scout", "scout", "queued") }),
    ]);
    expect(result.response).toBe([
      "Done.", "", "The owner supplied two documents.", "", "Assigned specialist work:",
      "- Scout: queued at assignment (task `dar_scout`).", "", assignmentContinuation,
    ].join("\n"));
    expect(result).toMatchObject({ receiptCount: 1, replaced: true });
  });

  it("preserves completion evidence for a different specialist beside a queued assignment", () => {
    const result = reconcileResponseWithDelegationReceipts("Scout finished the check. Mnemosyne finished the review.", [
      execution({ task: task("dar_scout", "run_scout", "scout", "queued") }),
      execution({ task: task("dar_memory", "run_memory", "mnemosyne", "verified") }),
    ]);
    expect(result.response).toBe([
      "Mnemosyne finished the review.", "", "Assigned specialist work:",
      "- Scout: queued at assignment (task `dar_scout`).",
      "- Mnemosyne: verified at assignment (task `dar_memory`).", "", assignmentContinuation,
    ].join("\n"));
  });

  it("keeps a named completion claim when that specialist also has verified task evidence", () => {
    const result = reconcileResponseWithDelegationReceipts("Scout finished the check.", [
      execution({ task: task("dar_scout_queued", "run_scout_queued", "scout", "queued") }),
      execution({ task: task("dar_scout_verified", "run_scout_verified", "scout", "verified") }),
    ]);
    expect(result.response).toBe([
      "Scout finished the check.", "", "Assigned specialist work:",
      "- Scout: queued at assignment (task `dar_scout_queued`).",
      "- Scout: verified at assignment (task `dar_scout_verified`).", "", assignmentContinuation,
    ].join("\n"));
  });

  it.each(["running", "failed", "canceled", "completed_proposed"] as const)(
    "does not treat a second %s receipt as completion evidence for a queued specialist",
    (state) => {
      const result = reconcileResponseWithDelegationReceipts("Scout finished the check.", [
        execution({ task: task("dar_scout_queued", "run_scout_queued", "scout", "queued") }),
        execution({ task: task("dar_scout_other", "run_scout_other", "scout", state) }),
      ]);
      expect(result.response).toBe([
        "Assigned specialist work:",
        "- Scout: queued at assignment (task `dar_scout_queued`).",
        `- Scout: ${state.replaceAll("_", " ")} at assignment (task \`dar_scout_other\`).`,
        "", assignmentContinuation,
      ].join("\n"));
    },
  );

  it("retains plans and negative status statements instead of mistaking them for completed work", () => {
    const response = "Scout will complete the check. Scout has not completed the review.";
    const result = reconcileResponseWithDelegationReceipts(response, [
      execution({ task: task("dar_scout", "run_scout", "scout", "queued") }),
    ]);
    expect(result.response).toBe([
      "Scout will complete the check.", "", "Scout has not completed the review.", "", "Assigned specialist work:",
      "- Scout: queued at assignment (task `dar_scout`).", "", assignmentContinuation,
    ].join("\n"));
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

  it("reports receipts carried across approval pauses before live ones, each task once", () => {
    const carriedScout = receipt("dar_scout", "run_scout", "scout", "queued");
    const carriedMemory = receipt("dar_memory", "run_memory", "mnemosyne", "running");
    const executions = [
      execution({ task: task("dar_scout", "run_scout_again", "meridian", "running") }),
      execution({ task: task("dar_new", "run_new", "scout", "queued") }),
    ];

    expect(collectDelegationReceipts(executions, [carriedScout, carriedMemory])).toEqual([
      carriedScout,
      carriedMemory,
      task("dar_new", "run_new", "scout", "queued"),
    ]);
    expect(collectDelegationReceipts(executions)).toEqual([
      task("dar_scout", "run_scout_again", "meridian", "running"),
      task("dar_new", "run_new", "scout", "queued"),
    ]);
    expect(reconcileResponseWithDelegationReceipts("Done.", [], [carriedScout])).toEqual({
      response: [
        "Done.", "", "Assigned specialist work:",
        "- Scout: queued at assignment (task `dar_scout`).", "", assignmentContinuation,
      ].join("\n"),
      receiptCount: 1,
      replaced: true,
    });
  });

  it("reads carried receipts only from a list of distinct, well-formed receipts", () => {
    const scout = task("dar_scout", "run_scout", "scout", "queued");
    const memory = task("dar_memory", "run_memory", "mnemosyne", "running");

    expect(parseCarriedDelegationReceipts([scout, memory])).toEqual([scout, memory]);
    expect(parseCarriedDelegationReceipts([])).toEqual([]);
    for (const damaged of [
      undefined,
      scout,
      [null],
      [scout, scout],
      [{ ...scout, note: "extra" }],
      [{ executionId: "dar_scout", childRunId: "run_scout", state: "queued" }],
      [task("dar scout", "run_scout", "scout", "queued")],
      [task("dar_scout", "run_scout", "scout", "done")],
      [scout, { ...memory, childRunId: 7 }],
    ]) {
      expect(parseCarriedDelegationReceipts(damaged)).toBeUndefined();
    }
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

function receipt(
  executionId: string,
  childRunId: string,
  delegateAgentId: string,
  state: DelegationReceiptProjection["state"],
): DelegationReceiptProjection {
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
