import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadInboxCount } from "@/lib/approvals/inbox-count";
import type { AccessRequestStatus } from "@/lib/onboarding/access-request-store";

const tenantId = "tenant-inbox-count";

beforeEach(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-inbox-count-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OMNIAGENT_ACCESS_REQUEST_FILE;
});

function counters(approvals: number | Error, accessRequests: number | Error) {
  const answer = (value: number | Error) =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  return {
    countApprovals: vi.fn((_tenantId: string) => answer(approvals)),
    countAccessRequests: vi.fn((_tenantId: string) => answer(accessRequests)),
  };
}

describe("inbox count", () => {
  it("counts nothing for a viewer and reads no queue", async () => {
    const dependencies = counters(3, 2);

    await expect(loadInboxCount({ tenantId, role: "viewer" }, dependencies))
      .resolves.toStrictEqual({ pending: 0 });
    expect(dependencies.countApprovals).not.toHaveBeenCalled();
    expect(dependencies.countAccessRequests).not.toHaveBeenCalled();
  });

  it("counts only action approvals for an operator", async () => {
    const dependencies = counters(3, 2);

    await expect(loadInboxCount({ tenantId, role: "operator" }, dependencies))
      .resolves.toStrictEqual({ pending: 3, approvals: 3 });
    expect(dependencies.countApprovals).toHaveBeenCalledWith(tenantId);
    expect(dependencies.countAccessRequests).not.toHaveBeenCalled();
  });

  it("adds access requests for an admin", async () => {
    const dependencies = counters(3, 2);

    await expect(loadInboxCount({ tenantId, role: "admin" }, dependencies))
      .resolves.toStrictEqual({ pending: 5, approvals: 3, accessRequests: 2 });
    expect(dependencies.countAccessRequests).toHaveBeenCalledWith(tenantId);
  });

  it("reports an empty queue as zero rather than leaving it out", async () => {
    await expect(loadInboxCount({ tenantId, role: "admin" }, counters(0, 0)))
      .resolves.toStrictEqual({ pending: 0, approvals: 0, accessRequests: 0 });
  });

  it("leaves out a queue it cannot read and keeps the other", async () => {
    await expect(loadInboxCount(
      { tenantId, role: "admin" },
      counters(new Error("database unavailable"), 2),
    )).resolves.toStrictEqual({ pending: 2, accessRequests: 2 });
    await expect(loadInboxCount(
      { tenantId, role: "admin" },
      counters(3, new Error("store unavailable")),
    )).resolves.toStrictEqual({ pending: 3, approvals: 3 });
    await expect(loadInboxCount(
      { tenantId, role: "system" },
      counters(-1, 1.5),
    )).resolves.toStrictEqual({ pending: 0 });
  });

  it("counts the stored queues by default", async () => {
    const slo = await import("@/lib/observability/slo-policy-store");
    await savePendingToolApproval("inbox-count-tool-a");
    await savePendingToolApproval("inbox-count-tool-b");
    await savePendingToolApproval("inbox-count-tool-other", "tenant-inbox-other");
    await slo.requestObservabilitySloPolicyChange({
      policyId: "latency-p95",
      action: "delete_policy",
      tenantId,
      requestedBy: "queue-owner",
      reason: "Retire the latency policy.",
    });
    // Each waiting status has its own count, so counting the wrong one shows.
    const statuses: AccessRequestStatus[] = [
      "pending_review",
      "pending_review",
      "provisioning_pending",
      "provisioning_pending",
      "provisioning_pending",
      "approved",
      "provisioned",
      "declined",
    ];
    for (const [index, status] of statuses.entries()) {
      await saveAccessRequest(`inbox-count-access-${index}`, status);
    }
    await saveAccessRequest("inbox-count-access-other", "pending_review", "tenant-inbox-other");

    await expect(loadInboxCount({ tenantId, role: "admin" }))
      .resolves.toStrictEqual({ pending: 8, approvals: 3, accessRequests: 5 });
    await expect(loadInboxCount({ tenantId, role: "operator" }))
      .resolves.toStrictEqual({ pending: 3, approvals: 3 });
  });
});

async function savePendingToolApproval(id: string, tenant = tenantId) {
  const store = await import("@/lib/tools/audit-store");
  await store.saveToolExecution({
    id,
    tenantId: tenant,
    actorId: "queue-owner",
    toolId: "http.request",
    toolName: "HTTP Request",
    riskLevel: 2,
    status: "approval_required",
    dryRun: false,
    approvalRequired: true,
    input: { url: "https://status.example.com" },
    createdAt: new Date().toISOString(),
  });
}

async function saveAccessRequest(
  id: string,
  status: AccessRequestStatus,
  tenant = tenantId,
) {
  const { getAccessRequestStore } = await import("@/lib/onboarding/access-request-store");
  const now = new Date().toISOString();
  await getAccessRequestStore().save({
    id,
    tenantId: tenant,
    name: "Sam Reviewer",
    email: `${id}@example.com`,
    company: "Example Co",
    role: "engineering",
    timeline: "now",
    useCase: "Review the weekly operations summary.",
    status,
    createdAt: now,
    updatedAt: now,
  });
}
