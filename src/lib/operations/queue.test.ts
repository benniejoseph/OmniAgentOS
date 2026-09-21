import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "@/lib/tools/types";

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-operations-overview-"),
  );
  delete process.env.DATABASE_URL;
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
