import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunContinuation } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-operations-overview-"),
  );
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("operations overview", () => {
  it("excludes actor-private semantic jobs and projects visible jobs", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-overview-private-jobs";
    const visible = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      payload: {
        workflowRunId: "visible-workflow",
        request: { privateInput: "must-not-reach-overview" },
      },
    });
    await queue.enqueueOperationJob({
      tenantId,
      type: "conversation.summary.enrich",
      payload: {
        actorId: "private-actor",
        request: { transcript: "private transcript" },
        result: { sourceSha256: "private-source-hash" },
      },
    });

    const overview = await operations.getOperationsOverview({ tenantId });

    expect(overview.latest.operationJobs).toEqual([
      expect.objectContaining({ id: visible.id, type: "workflow.tick" }),
    ]);
    expect(overview.latest.operationJobs[0]).not.toHaveProperty("payload");
    expect(JSON.stringify(overview.latest.operationJobs)).not.toContain(
      "private transcript",
    );
    expect(JSON.stringify(overview.latest.operationJobs)).not.toContain(
      "must-not-reach-overview",
    );
  });

  it("surfaces exact stale approved reads as redacted reconciliations", async () => {
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-read-reconciliation";
    await saveApprovedExecution({
      id: "durable-read",
      tenantId,
      toolId: "moltbook.home.read",
      operationClass: "read_only",
    });
    await saveApprovedExecution({
      id: "legacy-read",
      tenantId,
      toolId: "moltbook.feed.read",
      omitOperationClass: true,
    });
    await saveStaleMemoryForget(tenantId);

    const queue = await operations.getApprovalQueue(25, { tenantId });
    const durable = queue.items.find((item) => item.id === "durable-read");
    const legacy = queue.items.find((item) => item.id === "legacy-read");
    const memoryForget = queue.items.find(
      (item) => item.id === "stale-memory-forget",
    );

    expect(durable).toMatchObject({
      kind: "tool",
      status: "reconciliation_required",
      canonicalStatus: { sourceStatus: "reconciliation_required" },
      reason:
        "Approval is already recorded, but this read-only action stopped before returning a result. Retry the exact approved request to fetch a fresh result; this recovery cannot perform a mutation.",
      input: {},
      record: { output: {} },
    });
    expect(legacy).toMatchObject({
      kind: "tool",
      status: "reconciliation_required",
    });
    expect(memoryForget).toMatchObject({
      status: "reconciliation_required",
      reason:
        "Approval is already recorded, but the deletion outcome was not finalized before its execution claim expired. Reconcile the immutable receipt or safely replay the same bound request.",
    });
    expect(queue.stats).toMatchObject({
      tools: 3,
      reconciliations: 3,
    });
    expect(JSON.stringify(durable)).not.toContain("durable-read-claim");
    expect(JSON.stringify(durable)).not.toContain("__sealedInput");
    expect(JSON.stringify(durable)).not.toContain("__operationClass");
  });

  it("excludes unsafe, malformed, fresh, effect-bound, and other-tenant executions", async () => {
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-read-reconciliation-exclusions";
    await saveApprovedExecution({
      id: "durable-mutation",
      tenantId,
      toolId: "moltbook.post.create",
      operationClass: "mutation",
    });
    await saveApprovedExecution({
      id: "legacy-non-read",
      tenantId,
      toolId: "moltbook.post.create",
      omitOperationClass: true,
    });
    await saveApprovedExecution({
      id: "malformed-read",
      tenantId,
      toolId: "moltbook.home.read",
      operationClass: "read_only",
      malformed: true,
    });
    await saveApprovedExecution({
      id: "fresh-read",
      tenantId,
      toolId: "moltbook.home.read",
      operationClass: "read_only",
      stale: false,
    });
    await saveApprovedExecution({
      id: "effect-bound-read",
      tenantId,
      toolId: "memory.write",
      operationClass: "read_only",
      effectBound: true,
    });
    await saveApprovedExecution({
      id: "other-tenant-read",
      tenantId: "tenant-read-reconciliation-other",
      toolId: "moltbook.home.read",
      operationClass: "read_only",
    });

    const queue = await operations.getApprovalQueue(25, { tenantId });

    expect(queue.items).toEqual([]);
    expect(queue.stats).toMatchObject({ tools: 0, reconciliations: 0 });
  });
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("approval queue order", () => {
  it("lists reconciliations first, then by waiting time less a day per risk", async () => {
    const operations = await import("@/lib/operations/queue");
    const seeded = await seedOrderedApprovals("tenant-approval-order");

    const queue = await operations.getApprovalQueue(25, {
      tenantId: "tenant-approval-order",
    });

    expect(queue.items.map(queueKey)).toEqual(seeded.order);
    expect(queue.stats).toEqual(seeded.stats);
    expect(queue.nextCursor).toBeNull();
  });

  it.each([1, 2, 3, 4])(
    "pages %i at a time without skipping or repeating an item",
    async (limit) => {
      const operations = await import("@/lib/operations/queue");
      const seeded = await seedOrderedApprovals("tenant-approval-pages");
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const page: Awaited<ReturnType<typeof operations.getApprovalQueue>> =
          await operations.getApprovalQueue(limit, {
            tenantId: "tenant-approval-pages",
            cursor,
          });
        expect(page.items.length).toBeLessThanOrEqual(limit);
        if (page.nextCursor) expect(page.items).toHaveLength(limit);
        expect(page.stats).toEqual(seeded.stats);
        seen.push(...page.items.map(queueKey));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(seeded.order.length + 1);
      } while (cursor);

      expect(seen).toEqual(seeded.order);
    },
  );

  it.each([1, 2, 3])(
    "pages %i at a time through items that tie across every source",
    async (limit) => {
      const operations = await import("@/lib/operations/queue");
      const tenantId = "tenant-approval-ties";
      const order = await seedTiedApprovals(tenantId);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;

      do {
        const page: Awaited<ReturnType<typeof operations.getApprovalQueue>> =
          await operations.getApprovalQueue(limit, { tenantId, cursor });
        if (page.nextCursor) expect(page.items).toHaveLength(limit);
        seen.push(...page.items.map(queueKey));
        cursor = page.nextCursor;
        pages += 1;
        expect(pages).toBeLessThanOrEqual(order.length + 1);
      } while (cursor);

      expect(seen).toEqual(order);
    },
  );

  it.each([1, 2, 3, 4])(
    "fills every page but the last, %i at a time, as the sources interleave",
    async (limit) => {
      const operations = await import("@/lib/operations/queue");
      const tenantId = "tenant-approval-interleaved";
      const order = await seedInterleavedApprovals(tenantId);
      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const page: Awaited<ReturnType<typeof operations.getApprovalQueue>> =
          await operations.getApprovalQueue(limit, { tenantId, cursor });
        if (page.nextCursor) expect(page.items).toHaveLength(limit);
        seen.push(...page.items.map(queueKey));
        cursor = page.nextCursor;
        expect(seen.length).toBeLessThanOrEqual(order.length);
      } while (cursor);

      expect(seen).toEqual(order);
    },
  );

  it("reads every source a full page deep", async () => {
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-approval-full-page";
    const order = await seedTiedApprovals(tenantId);

    const queue = await operations.getApprovalQueue(25, { tenantId });

    expect(queue.items.map(queueKey)).toEqual(order);
    expect(queue.nextCursor).toBeNull();
  });

  it("pages through a source that holds every item, and ends on the page it fills", async () => {
    const operations = await import("@/lib/operations/queue");
    const slo = await import("@/lib/observability/slo-policy-store");
    const now = Date.now();
    for (const [index, id] of ["tool-alone-a", "tool-alone-b"].entries()) {
      await savePendingToolApproval({
        id,
        tenantId: "tenant-approval-tools-alone",
        riskLevel: 1,
        createdAt: now - (2 - index) * HOUR,
      });
    }
    await writeWorkflowRuns(["workflow-alone-a", "workflow-alone-b"].map((id, index) =>
      workflowRun({
        id,
        tenantId: "tenant-approval-workflows-alone",
        status: "waiting_approval",
        updatedAt: now - (2 - index) * HOUR,
      })
    ));
    for (const policyId of ["latency-p95", "error-rate"]) {
      await slo.requestObservabilitySloPolicyChange({
        policyId,
        action: "delete_policy",
        tenantId: "tenant-approval-slo-alone",
        requestedBy: "queue-owner",
      });
    }

    for (const tenantId of [
      "tenant-approval-tools-alone",
      "tenant-approval-workflows-alone",
      "tenant-approval-slo-alone",
    ]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const page: Awaited<ReturnType<typeof operations.getApprovalQueue>> =
          await operations.getApprovalQueue(1, { tenantId, cursor });
        seen.push(...page.items.map(queueKey));
        cursor = page.nextCursor;
        expect(seen.length).toBeLessThanOrEqual(2);
      } while (cursor);
      expect(new Set(seen).size).toBe(2);

      const full = await operations.getApprovalQueue(2, { tenantId });
      expect(full.items.map(queueKey)).toEqual(seen);
      expect(full.nextCursor).toBeNull();
    }
  });

  it("caps a page at 100 items", async () => {
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-approval-cap";
    const now = Date.now();
    for (let index = 0; index < 101; index += 1) {
      await savePendingToolApproval({
        id: `tool-cap-${String(index).padStart(3, "0")}`,
        tenantId,
        riskLevel: 1,
        createdAt: now - index * 1_000,
      });
    }

    const first = await operations.getApprovalQueue(1_000, { tenantId });
    expect(first.items).toHaveLength(100);
    expect(first.stats.total).toBe(101);
    expect(first.nextCursor).not.toBeNull();

    const rest = await operations.getApprovalQueue(1_000, {
      tenantId,
      cursor: first.nextCursor,
    });
    expect(rest.items.map((item) => item.id)).toEqual(["tool-cap-000"]);
    expect(rest.nextCursor).toBeNull();
  });

  it("continues a page from its cursor after an earlier item is decided", async () => {
    const operations = await import("@/lib/operations/queue");
    const store = await import("@/lib/tools/audit-store");
    const tenantId = "tenant-approval-decided";
    const seeded = await seedOrderedApprovals(tenantId);
    const first = await operations.getApprovalQueue(3, { tenantId });
    const decided = await store.getToolExecution("tool-risk0-old", { tenantId });
    await store.saveToolExecution({
      ...decided!,
      status: "rejected",
      approvalDecision: "rejected",
      completedAt: new Date().toISOString(),
    });

    const second = await operations.getApprovalQueue(25, {
      tenantId,
      cursor: first.nextCursor,
    });

    expect([...first.items, ...second.items].map(queueKey)).toEqual(seeded.order);
    expect(second.stats).toEqual({
      ...seeded.stats,
      total: seeded.stats.total - 1,
      tools: seeded.stats.tools - 1,
    });
  });

  it("rejects a cursor it did not issue", async () => {
    const operations = await import("@/lib/operations/queue");
    const { ApprovalCursorError } = await import("@/lib/approvals/order");

    await expect(
      operations.getApprovalQueue(5, {
        tenantId: "tenant-approval-cursor",
        cursor: "not a cursor",
      }),
    ).rejects.toBeInstanceOf(ApprovalCursorError);
  });
});

describe("approval queue item", () => {
  it("finds a pending item by id and kind in the caller's tenant only", async () => {
    const operations = await import("@/lib/operations/queue");
    const tenantId = "tenant-approval-item";
    const seeded = await seedOrderedApprovals(tenantId);

    await expect(
      operations.getApprovalQueueItem("tool-risk1-mid", { tenantId }),
    ).resolves.toMatchObject({ kind: "tool", id: "tool-risk1-mid", riskLevel: 1 });
    await expect(
      operations.getApprovalQueueItem(" tool-risk1-mid ", { tenantId, kind: "tool" }),
    ).resolves.toMatchObject({ kind: "tool", id: "tool-risk1-mid" });
    await expect(
      operations.getApprovalQueueItem("stale-memory-forget", { tenantId }),
    ).resolves.toMatchObject({ kind: "tool", status: "reconciliation_required" });
    await expect(
      operations.getApprovalQueueItem("workflow-waiting", { tenantId }),
    ).resolves.toMatchObject({ kind: "workflow", id: "workflow-waiting" });
    await expect(
      operations.getApprovalQueueItem("workflow-waiting", { tenantId, kind: "workflow" }),
    ).resolves.toMatchObject({ kind: "workflow", id: "workflow-waiting" });
    await expect(
      operations.getApprovalQueueItem(seeded.sloChangeId, { tenantId }),
    ).resolves.toMatchObject({ kind: "slo_policy", id: seeded.sloChangeId, riskLevel: 3 });
    await expect(
      operations.getApprovalQueueItem(seeded.sloChangeId, { tenantId, kind: "slo_policy" }),
    ).resolves.toMatchObject({ kind: "slo_policy", id: seeded.sloChangeId });

    for (const [id, kind] of [
      ["tool-risk1-mid", "workflow"],
      ["tool-risk1-mid", "slo_policy"],
      ["workflow-waiting", "tool"],
      ["workflow-waiting", "slo_policy"],
      [seeded.sloChangeId, "tool"],
      [seeded.sloChangeId, "workflow"],
    ] as const) {
      await expect(
        operations.getApprovalQueueItem(id, { tenantId, kind }),
      ).resolves.toBeNull();
    }
    for (const id of [
      "tool-decided",
      "workflow-running",
      seeded.rejectedSloChangeId,
      "other-tenant-tool",
      "other-tenant-workflow",
      seeded.otherTenantSloChangeId,
      "missing",
      "   ",
    ]) {
      await expect(
        operations.getApprovalQueueItem(id, { tenantId }),
      ).resolves.toBeNull();
    }
  });
});

describe("approval queue origin", () => {
  it("links a tool item to its paused run only for the run's owner", async () => {
    const operations = await import("@/lib/operations/queue");
    const runs = await import("@/lib/runs/store");
    const tenantId = "tenant-approval-origin";
    await seedOrderedApprovals(tenantId);
    const owned = await runs.createAgentRun({
      mode: "orchestrate",
      prompt: "Fetch the status page.",
      messages: [{ role: "user", content: "Fetch the status page." }],
      tenantId,
      actorId: "queue-owner",
      threadId: "thread-approvals",
    });
    await runs.markAgentRunWaitingForApproval(owned.id, {
      response: "partial",
      continuation: continuationFor("tool-risk3-recent", tenantId, "queue-owner"),
    });
    const threadless = await runs.createAgentRun({
      mode: "orchestrate",
      prompt: "Old request.",
      messages: [{ role: "user", content: "Old request." }],
      tenantId,
      actorId: "queue-owner",
    });
    await runs.markAgentRunWaitingForApproval(threadless.id, {
      response: "partial",
      continuation: continuationFor("tool-risk0-old", tenantId, "queue-owner"),
    });
    const canceled = await runs.createAgentRun({
      mode: "orchestrate",
      prompt: "Canceled request.",
      messages: [{ role: "user", content: "Canceled request." }],
      tenantId,
      actorId: "queue-owner",
      threadId: "thread-canceled",
    });
    await runs.markAgentRunWaitingForApproval(canceled.id, {
      response: "partial",
      continuation: continuationFor("tool-risk1-mid", tenantId, "queue-owner"),
    });
    await runs.cancelAgentRun(canceled.id, "Canceled by the operator.", { tenantId });
    const elsewhere = await runs.createAgentRun({
      mode: "orchestrate",
      prompt: "Other tenant request.",
      messages: [{ role: "user", content: "Other tenant request." }],
      tenantId: `${tenantId}-other`,
      actorId: "queue-owner",
      threadId: "thread-elsewhere",
    });
    await runs.markAgentRunWaitingForApproval(elsewhere.id, {
      response: "partial",
      continuation: continuationFor("tool-tie", `${tenantId}-other`, "queue-owner"),
    });

    const ownerQueue = await operations.getApprovalQueue(25, {
      tenantId,
      actorId: "queue-owner",
    });
    const origins = Object.fromEntries(
      ownerQueue.items.flatMap((item) =>
        item.kind === "tool" && item.origin ? [[item.id, item.origin]] : []
      ),
    );

    expect(origins).toStrictEqual({
      "tool-risk3-recent": { runId: owned.id, threadId: "thread-approvals" },
      "tool-risk0-old": { runId: threadless.id },
    });
    for (const actorId of ["someone-else", undefined]) {
      const queue = await operations.getApprovalQueue(25, { tenantId, actorId });
      expect(queue.items.some((item) => "origin" in item)).toBe(false);
    }
    await expect(
      operations.getApprovalQueueItem("tool-risk3-recent", {
        tenantId,
        actorId: "queue-owner",
      }),
    ).resolves.toMatchObject({
      origin: { runId: owned.id, threadId: "thread-approvals" },
    });
    for (const actorId of ["someone-else", undefined]) {
      const item = await operations.getApprovalQueueItem("tool-risk3-recent", {
        tenantId,
        actorId,
      });
      expect(item).not.toHaveProperty("origin");
    }
  });
});

function queueKey(item: { kind: string; id: string }) {
  return `${item.kind}:${item.id}`;
}

/**
 * Pending items at known positions, plus decided and other-tenant items
 * that must stay out. With N as now, each pending item's priority is:
 * tool-risk0-old N-5d; tool-tie and workflow-waiting N-4d-1h (the tool
 * sorts first on the tie); tool-risk1-mid N-4d; the SLO change N-3d-2h;
 * tool-risk3-recent N-3d-1h. The stale memory deletion is a
 * reconciliation and comes before all of them.
 */
async function seedOrderedApprovals(tenantId: string) {
  const slo = await import("@/lib/observability/slo-policy-store");
  const now = Date.now();
  await saveStaleMemoryForget(tenantId);
  await savePendingToolApproval({
    id: "tool-risk3-recent",
    tenantId,
    riskLevel: 3,
    createdAt: now - HOUR,
  });
  await savePendingToolApproval({
    id: "tool-risk0-old",
    tenantId,
    riskLevel: 0,
    createdAt: now - 5 * DAY,
  });
  await savePendingToolApproval({
    id: "tool-risk1-mid",
    tenantId,
    riskLevel: 1,
    createdAt: now - 3 * DAY,
  });
  await savePendingToolApproval({
    id: "tool-tie",
    tenantId,
    riskLevel: 2,
    createdAt: now - 2 * DAY - HOUR,
  });
  await savePendingToolApproval({
    id: "tool-decided",
    tenantId,
    riskLevel: 3,
    createdAt: now - 9 * DAY,
    status: "rejected",
  });
  await savePendingToolApproval({
    id: "other-tenant-tool",
    tenantId: `${tenantId}-other`,
    riskLevel: 3,
    createdAt: now - 9 * DAY,
  });
  await writeWorkflowRuns([
    workflowRun({
      id: "workflow-waiting",
      tenantId,
      status: "waiting_approval",
      updatedAt: now - 2 * DAY - HOUR,
    }),
    workflowRun({
      id: "workflow-running",
      tenantId,
      status: "running",
      updatedAt: now - 9 * DAY,
    }),
    workflowRun({
      id: "other-tenant-workflow",
      tenantId: `${tenantId}-other`,
      status: "waiting_approval",
      updatedAt: now - 9 * DAY,
    }),
  ]);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now - 2 * HOUR);
  const sloChange = await slo.requestObservabilitySloPolicyChange({
    policyId: "latency-p95",
    action: "delete_policy",
    tenantId,
    requestedBy: "queue-owner",
    reason: "Retire the latency policy.",
  });
  vi.setSystemTime(now - 9 * DAY);
  const rejected = await slo.requestObservabilitySloPolicyChange({
    policyId: "error-rate",
    action: "delete_policy",
    tenantId,
    requestedBy: "queue-owner",
  });
  const otherTenant = await slo.requestObservabilitySloPolicyChange({
    policyId: "error-rate",
    action: "delete_policy",
    tenantId: `${tenantId}-other`,
    requestedBy: "queue-owner",
  });
  vi.useRealTimers();
  await slo.rejectObservabilitySloPolicyChange(rejected.id, {
    reviewedBy: "queue-reviewer",
    reviewedRole: "admin",
    tenantId,
  });

  return {
    sloChangeId: sloChange.id,
    rejectedSloChangeId: rejected.id,
    otherTenantSloChangeId: otherTenant.id,
    order: [
      "tool:stale-memory-forget",
      "tool:tool-risk0-old",
      "tool:tool-tie",
      "workflow:workflow-waiting",
      "tool:tool-risk1-mid",
      `slo_policy:${sloChange.id}`,
      "tool:tool-risk3-recent",
    ],
    stats: {
      total: 7,
      tools: 5,
      reconciliations: 1,
      workflows: 1,
      sloPolicies: 1,
    },
  };
}

/**
 * Two pending items from each source, all at priority N-3d: risk-three tools
 * made at N, workflows paused at N-1d, and SLO deletions (risk three)
 * requested at N. Their ids sort in the reverse of the source order, so a
 * source that resumed on another source's id would skip or repeat items.
 */
async function seedTiedApprovals(tenantId: string) {
  const slo = await import("@/lib/observability/slo-policy-store");
  const now = Date.now();
  for (const id of ["zzz-tool-b", "zzz-tool-a"]) {
    await savePendingToolApproval({ id, tenantId, riskLevel: 3, createdAt: now });
  }
  await writeWorkflowRuns(["zz-workflow-b", "zz-workflow-a"].map((id) =>
    workflowRun({ id, tenantId, status: "waiting_approval", updatedAt: now - DAY })
  ));
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const changeIds: string[] = [];
  for (const policyId of ["latency-p95", "error-rate"]) {
    const change = await slo.requestObservabilitySloPolicyChange({
      policyId,
      action: "delete_policy",
      tenantId,
      requestedBy: "queue-owner",
    });
    changeIds.push(change.id);
  }
  vi.useRealTimers();

  return [
    "tool:zzz-tool-a",
    "tool:zzz-tool-b",
    "workflow:zz-workflow-a",
    "workflow:zz-workflow-b",
    ...changeIds.sort().map((id) => `slo_policy:${id}`),
  ];
}

/**
 * Four pending items from each source, one hour apart in priority and taking
 * turns: tool, workflow, SLO deletion, tool, and so on. Each source reads a
 * row ahead of every page, so a source that ended its page on the wrong row
 * would cut the next page short.
 */
async function seedInterleavedApprovals(tenantId: string) {
  const slo = await import("@/lib/observability/slo-policy-store");
  const base = Date.now() - 3 * DAY - 12 * HOUR;
  const order: string[] = [];
  const workflows: WorkflowRunRecord[] = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  for (let index = 0; index < 12; index += 1) {
    const priorityMs = base + index * HOUR;
    const turn = Math.floor(index / 3);
    if (index % 3 === 0) {
      const id = `interleaved-tool-${turn}`;
      await savePendingToolApproval({ id, tenantId, riskLevel: 1, createdAt: priorityMs + DAY });
      order.push(`tool:${id}`);
    } else if (index % 3 === 1) {
      const id = `interleaved-workflow-${turn}`;
      workflows.push(workflowRun({
        id,
        tenantId,
        status: "waiting_approval",
        updatedAt: priorityMs + 2 * DAY,
      }));
      order.push(`workflow:${id}`);
    } else {
      vi.setSystemTime(priorityMs + 3 * DAY);
      const change = await slo.requestObservabilitySloPolicyChange({
        policyId: turn % 2 ? "error-rate" : "latency-p95",
        action: "delete_policy",
        tenantId,
        requestedBy: "queue-owner",
      });
      order.push(`slo_policy:${change.id}`);
    }
  }
  vi.useRealTimers();
  await writeWorkflowRuns(workflows);
  return order;
}

async function savePendingToolApproval(input: {
  id: string;
  tenantId: string;
  riskLevel: ToolExecutionRecord["riskLevel"];
  createdAt: number;
  status?: ToolExecutionRecord["status"];
}) {
  const store = await import("@/lib/tools/audit-store");
  await store.saveToolExecution({
    id: input.id,
    tenantId: input.tenantId,
    actorId: "queue-owner",
    toolId: "http.request",
    toolName: "HTTP Request",
    riskLevel: input.riskLevel,
    status: input.status || "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: { url: `https://status.example.com/${input.id}` },
    reason: "Requires approval.",
    createdAt: new Date(input.createdAt).toISOString(),
  });
}

function workflowRun(input: {
  id: string;
  tenantId: string;
  status: WorkflowRunRecord["status"];
  updatedAt: number;
}): WorkflowRunRecord {
  const updatedAt = new Date(input.updatedAt).toISOString();
  return {
    id: input.id,
    tenantId: input.tenantId,
    workflowType: "agent.orchestrate",
    status: input.status,
    goal: `Workflow ${input.id}`,
    input: { goal: `Workflow ${input.id}`, requireApproval: true },
    attempt: 0,
    maxAttempts: 3,
    approvalRequired: true,
    // Created well before it paused: a run waits from its last update.
    createdAt: new Date(input.updatedAt - 7 * DAY).toISOString(),
    updatedAt,
  };
}

async function writeWorkflowRuns(runs: WorkflowRunRecord[]) {
  await writeFile(
    path.join(process.env.OMNIAGENT_DATA_DIR!, "workflows.json"),
    JSON.stringify({ runs, steps: [], events: [] }),
  );
}

function continuationFor(
  executionId: string,
  tenantId: string,
  actorId: string,
): AgentRunContinuation {
  return {
    conversationItems: [{ role: "user", content: "test" }],
    instructions: "test",
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call_1",
      toolId: "http.request",
      toolName: "HTTP Request",
      riskLevel: 2,
      executionId,
    },
    context: { tenantId, actorId, role: "operator" },
    createdAt: new Date().toISOString(),
  };
}

async function saveApprovedExecution(input: {
  id: string;
  tenantId: string;
  toolId: string;
  operationClass?: "read_only" | "mutation";
  omitOperationClass?: boolean;
  malformed?: boolean;
  stale?: boolean;
  effectBound?: boolean;
}) {
  const store = await import("@/lib/tools/audit-store");
  const { toolApprovalFingerprint } = await import("@/lib/tools/fingerprint");
  const { getGovernedTool } = await import("@/lib/tools/registry");
  const tool = getGovernedTool(input.toolId);
  if (!tool) throw new Error(`Missing governed test tool ${input.toolId}.`);
  const approvedInput = approvedInputForTool(input.toolId, input.id);
  const record: ToolExecutionRecord = {
    id: input.id,
    tenantId: input.tenantId,
    actorId: "queue-owner",
    toolId: tool.id,
    toolName: tool.name,
    riskLevel: tool.riskLevel,
    status: "executing",
    dryRun: false,
    approvalRequired: true,
    approvalDecision: "approved",
    approvedBy: "queue-owner",
    approvedAt: new Date(Date.now() - 180_000).toISOString(),
    input: approvedInput,
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  };
  const sealed: Record<string, unknown> = store.sealToolExecutionInput(
    approvedInput,
    record,
    toolApprovalFingerprint(tool),
    input.operationClass
      ? { operationClass: input.operationClass }
      : undefined,
  );
  if (input.omitOperationClass) {
    delete sealed.__operationClass;
  }
  if (input.malformed) {
    delete sealed.__sealedInput;
  }
  const claimedAt = input.stale === false
    ? new Date().toISOString()
    : new Date(Date.now() - 360_000).toISOString();
  await store.saveToolExecution({
    ...record,
    output: {
      ...sealed,
      ...(input.effectBound
        ? { __effectInputSha256: "0".repeat(64) }
        : {}),
      __executionClaim: {
        token: `${input.id}-claim`,
        claimedAt,
      },
    },
  });
}

function approvedInputForTool(toolId: string, id: string) {
  if (toolId === "moltbook.home.read") return {};
  if (toolId === "moltbook.feed.read") {
    return { sort: "new", limit: 5 };
  }
  if (toolId === "moltbook.post.create") {
    return { submoltName: "agents", title: `Queue fixture ${id}` };
  }
  if (toolId === "memory.write") {
    return { title: `Queue fixture ${id}`, content: "Bounded test content." };
  }
  throw new Error(`Missing approved input fixture for ${toolId}.`);
}

async function saveStaleMemoryForget(tenantId: string) {
  const store = await import("@/lib/tools/audit-store");
  await store.saveToolExecution({
    id: "stale-memory-forget",
    tenantId,
    actorId: "queue-owner",
    toolId: "memory.forget",
    toolName: "Forget memory",
    riskLevel: 2,
    status: "executing",
    dryRun: false,
    approvalRequired: true,
    approvalDecision: "approved",
    approvedBy: "queue-owner",
    approvedAt: new Date(Date.now() - 180_000).toISOString(),
    input: { id: "memory-1" },
    output: {
      __executionClaim: {
        token: "stale-memory-forget-claim",
        claimedAt: new Date(Date.now() - 360_000).toISOString(),
      },
    },
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  });
}
