import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const TENANT_ID = "tenant-approval-withdrawal";
const OWNER_ID = "owner-approval-withdrawal";
const DAY_MS = 86_400_000;
const EXPIRED_REASON =
  "Withdrawn: the approval expired before a decision was made.";
const LEFT_REASON =
  "Withdrawn: the member who requested this action no longer belongs to this workspace.";

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-approval-withdrawal-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS;
});

function pending(id: string, ageMs = 60_000): ToolExecutionRecord {
  return {
    id,
    tenantId: TENANT_ID,
    actorId: OWNER_ID,
    toolId: "http.request",
    toolName: "HTTP request",
    riskLevel: 2,
    status: "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: { url: "https://8.8.8.8/example", method: "POST" },
    createdAt: new Date(Date.now() - ageMs).toISOString(),
  };
}

async function operations(id: string) {
  const events = await listStreamEvents(`tool_execution:${id}`, {
    tenantId: TENANT_ID,
  });
  return events.map((event) => event.payload.operation);
}

function claim(id: string) {
  return import("@/lib/tools/audit-store").then((store) =>
    store.approveAndClaimToolExecution({
      id,
      tenantId: TENANT_ID,
      approvedBy: OWNER_ID,
      approvedRole: "admin",
      claimToken: `${id}-token`,
    })
  );
}

describe("approving an approval past its window (file mode)", () => {
  it("withdraws it instead of claiming it", async () => {
    const store = await import("@/lib/tools/audit-store");
    const saved = await store.saveToolExecution(
      pending("expired-approval", 7 * DAY_MS + 60_000),
    );

    const result = await claim(saved.id);

    expect(result).toMatchObject({
      outcome: "withdrawn",
      record: {
        id: saved.id,
        status: "rejected",
        approvalDecision: "rejected",
        approvalReason: EXPIRED_REASON,
        reason: EXPIRED_REASON,
        input: saved.input,
      },
    });
    await expect(store.getToolExecution(saved.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "rejected", reason: EXPIRED_REASON });
    expect(await operations(saved.id)).toContain("withdrawn");
  });

  it("follows a shorter pending approval window", async () => {
    process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS = "1";
    const store = await import("@/lib/tools/audit-store");
    const saved = await store.saveToolExecution(
      pending("short-window-approval", DAY_MS + 60_000),
    );

    await expect(claim(saved.id)).resolves.toMatchObject({
      outcome: "withdrawn",
      record: { reason: EXPIRED_REASON },
    });
  });

  it("still claims an approval inside its window", async () => {
    const store = await import("@/lib/tools/audit-store");
    const saved = await store.saveToolExecution(
      pending("fresh-approval", 7 * DAY_MS - 60_000),
    );

    await expect(claim(saved.id)).resolves.toMatchObject({
      outcome: "claimed",
      record: { status: "executing", approvalDecision: "approved" },
    });
    expect(await operations(saved.id)).not.toContain("withdrawn");
  });
});

describe("withdrawing a pending approval (file mode)", () => {
  it("rejects it with the reason and records the withdrawal", async () => {
    const store = await import("@/lib/tools/audit-store");
    const saved = await store.saveToolExecution(pending("lapsed-approval"));

    const withdrawn = await store.withdrawPendingToolApproval({
      id: saved.id,
      tenantId: TENANT_ID,
      reason: LEFT_REASON,
    });

    expect(withdrawn).toMatchObject({
      id: saved.id,
      status: "rejected",
      approvalDecision: "rejected",
      approvalReason: LEFT_REASON,
      reason: LEFT_REASON,
      completedAt: expect.any(String),
    });
    await expect(store.getToolExecution(saved.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "rejected", reason: LEFT_REASON });
    expect(await operations(saved.id)).toEqual(["saved", "withdrawn"]);
    // A decided approval cannot be claimed afterwards.
    await expect(claim(saved.id)).resolves.toMatchObject({
      outcome: "conflict",
    });
  });

  it("leaves an approval that is no longer pending as it is", async () => {
    const store = await import("@/lib/tools/audit-store");
    const saved = await store.saveToolExecution(pending("decided-approval"));
    await claim(saved.id);

    await expect(store.withdrawPendingToolApproval({
      id: saved.id,
      tenantId: TENANT_ID,
      reason: LEFT_REASON,
    })).resolves.toBeUndefined();
    await expect(store.getToolExecution(saved.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "executing" });
    expect(await operations(saved.id)).not.toContain("withdrawn");
  });

  it("does not reach another tenant's approval", async () => {
    const store = await import("@/lib/tools/audit-store");
    const saved = await store.saveToolExecution(pending("other-tenant-approval"));

    await expect(store.withdrawPendingToolApproval({
      id: saved.id,
      tenantId: "tenant-elsewhere",
      reason: LEFT_REASON,
    })).resolves.toBeUndefined();
    await expect(store.getToolExecution(saved.id, { tenantId: TENANT_ID }))
      .resolves.toMatchObject({ status: "approval_required" });
  });
});
