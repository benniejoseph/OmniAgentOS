import { afterEach, describe, expect, it, vi } from "vitest";

const sourceMocks = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    listAgentRunSummaries: vi.fn(),
    unstableCache: (
      callback: (...args: unknown[]) => Promise<unknown>,
      keyParts: string[] = [],
    ) =>
      async (...args: unknown[]) => {
        // Next keys an entry by the callback source, key parts, and arguments.
        const key = `${callback.toString()}-${keyParts.join(",")}-${JSON.stringify(args)}`;
        if (!entries.has(key)) entries.set(key, await callback(...args));
        return entries.get(key);
      },
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: sourceMocks.unstableCache,
}));

vi.mock("@/lib/runs/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/store")>()),
  listAgentRunSummaries: sourceMocks.listAgentRunSummaries,
}));

vi.mock("@/lib/workflows/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/store")>()),
  listWorkflowRunSummaries: async () => [],
}));

vi.mock("@/lib/operations/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/queue")>()),
  getApprovalQueue: async () => ({ items: [] }),
}));

import {
  getDatabaseActorContext,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import type { AgentRunRecord } from "@/lib/runs/types";
import { loadWorkspaceSummary } from "@/lib/workspace/summary";

afterEach(() => {
  vi.unstubAllEnvs();
  sourceMocks.entries.clear();
  sourceMocks.listAgentRunSummaries.mockReset();
});

describe("workspace summary", () => {
  it("loads tenant-scoped sources independently and projects private fields", async () => {
    const listRuns = vi.fn().mockResolvedValue([
      {
        id: "run-1",
        tenantId: "tenant-a",
        mode: "research",
        status: "completed",
        prompt: "Summarize",
        response: "Done",
        messages: [{ role: "user", content: "private" }],
        memoryContextCount: 1,
        continuation: {
          pendingToolCall: {
            executionId: "execution-1",
            toolId: "tool-1",
            toolName: "Private tool",
          },
          secret: true,
        },
        startedAt: "2026-08-23T00:00:00.000Z",
        completedAt: "2026-08-23T00:00:01.000Z",
      },
    ]);
    const listWorkflows = vi.fn().mockRejectedValue(new Error("workflow unavailable"));
    const getApprovals = vi.fn().mockResolvedValue({
      items: [
        {
          kind: "tool",
          id: "approval-1",
          title: "Approve tool",
          status: "approval_required",
          riskLevel: 2,
          createdAt: "2026-08-23T00:00:00.000Z",
          input: { secret: true },
          record: { output: "sealed" },
        },
      ],
    });

    const summary = await loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "operator", limit: 8 },
      { listRuns, listWorkflows, getApprovals },
    );

    expect(listRuns).toHaveBeenCalledWith(8, { tenantId: "tenant-a" });
    expect(listWorkflows).toHaveBeenCalledWith(8, { tenantId: "tenant-a" });
    expect(getApprovals).toHaveBeenCalledWith(8, { tenantId: "tenant-a" });
    expect(summary.sources.runs).toMatchObject({
      status: "ready",
      data: [{ id: "run-1", response: "Done" }],
    });
    expect(JSON.stringify(summary.sources.runs)).not.toContain("messages");
    expect(summary.sources.workflows).toEqual({
      status: "error",
      error: "workflow unavailable",
    });
    expect(summary.sources.approvals).toMatchObject({
      status: "ready",
      data: [{ id: "approval-1", title: "Approve tool" }],
    });
    expect(JSON.stringify(summary.sources.approvals)).not.toContain("sealed");
    expect(JSON.stringify(summary.sources.approvals)).not.toContain("secret");
  });

  it("does not query approvals for viewer sessions", async () => {
    const getApprovals = vi.fn();
    const summary = await loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "viewer" },
      {
        listRuns: vi.fn().mockResolvedValue([]),
        listWorkflows: vi.fn().mockResolvedValue([]),
        getApprovals,
      },
    );

    expect(getApprovals).not.toHaveBeenCalled();
    expect(summary.sources.approvals).toEqual({
      status: "restricted",
      error: "Operator role required for approval items.",
    });
  });

  it("projects completed workflow reports for summary consumers", async () => {
    const summary = await loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "viewer" },
      {
        listRuns: vi.fn().mockResolvedValue([]),
        listWorkflows: vi.fn().mockResolvedValue([
          {
            id: "workflow-1",
            workflowType: "research",
            status: "completed",
            goal: "Prepare a report",
            input: { goal: "Prepare a report" },
            currentStep: "persist_report",
            attempt: 1,
            maxAttempts: 1,
            approvalRequired: false,
            result: { report: "Final workflow report" },
            createdAt: "2026-08-23T00:00:00.000Z",
            updatedAt: "2026-08-23T00:00:01.000Z",
            completedAt: "2026-08-23T00:00:01.000Z",
          },
        ]),
        getApprovals: vi.fn(),
      },
    );

    expect(summary.sources.workflows).toMatchObject({
      status: "ready",
      data: [{ id: "workflow-1", report: "Final workflow report" }],
    });
  });

  it("never serves one actor's cached runs to another actor", async () => {
    const privateRuns = [
      privateRun("run-a", "actor-a", "Draft my offer letter"),
      privateRun("run-b", "actor-b", "Plan the team offsite"),
    ];
    // Row-level security returns only the active actor scope's runs.
    sourceMocks.listAgentRunSummaries.mockImplementation(async () => {
      const actorIds = getDatabaseActorContext();
      return privateRuns.filter((run) => actorIds.includes(run.ownerActorId));
    });
    const readAs = (actorId: string) =>
      runWithDatabaseActorScope("tenant-a", [actorId], () =>
        loadWorkspaceSummary({ tenantId: "tenant-a", role: "operator" }));

    const ownerA = await readAs("actor-a");
    const repeatA = await readAs("actor-a");
    const ownerB = await readAs("actor-b");

    expect(repeatA).toEqual(ownerA);
    expect(ownerA.sources.runs).toMatchObject({
      status: "ready",
      data: [{ id: "run-a", prompt: "Draft my offer letter" }],
    });
    expect(ownerB.sources.runs).toMatchObject({
      status: "ready",
      data: [{ id: "run-b", prompt: "Plan the team offsite" }],
    });
    expect(JSON.stringify(ownerB)).not.toContain("Draft my offer letter");
    expect(sourceMocks.listAgentRunSummaries).toHaveBeenCalledTimes(2);
  });

  it("serializes source reads when the runtime has one database connection", async () => {
    vi.stubEnv("VERCEL", "1");
    let releaseRuns!: (value: AgentRunRecord[]) => void;
    const listRuns = vi.fn(() => new Promise<AgentRunRecord[]>((resolve) => {
      releaseRuns = resolve;
    }));
    const listWorkflows = vi.fn().mockResolvedValue([]);
    const getApprovals = vi.fn().mockResolvedValue({ items: [] });

    const pending = loadWorkspaceSummary(
      { tenantId: "tenant-a", role: "admin" },
      { listRuns, listWorkflows, getApprovals },
    );
    await vi.waitFor(() => expect(listRuns).toHaveBeenCalledOnce());
    expect(listWorkflows).not.toHaveBeenCalled();
    expect(getApprovals).not.toHaveBeenCalled();

    releaseRuns([]);
    await pending;

    expect(listWorkflows).toHaveBeenCalledOnce();
    expect(getApprovals).toHaveBeenCalledOnce();
  });
});

function privateRun(
  id: string,
  ownerActorId: string,
  prompt: string,
): AgentRunRecord {
  return {
    id,
    tenantId: "tenant-a",
    ownerActorId,
    mode: "research",
    status: "completed",
    prompt,
    messages: [],
    memoryContextCount: 0,
    response: `Done: ${prompt}`,
    startedAt: "2026-09-26T00:00:00.000Z",
    completedAt: "2026-09-26T00:00:01.000Z",
  };
}
