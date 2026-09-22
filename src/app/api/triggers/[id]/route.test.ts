import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getTrigger: vi.fn(),
  preview: vi.fn(),
  occurrences: vi.fn(),
  receipts: vi.fn(),
  leases: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/workflows/triggers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/triggers")>()),
  getWorkflowTrigger: mocks.getTrigger,
  previewWorkflowSchedule: mocks.preview,
  listWorkflowScheduleOccurrences: mocks.occurrences,
  listWorkflowScheduleOccurrenceReceipts: mocks.receipts,
}));
vi.mock("@/lib/security/policy-lease-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/policy-lease-store")>()),
  listScheduledPolicyLeaseOutcomes: mocks.leases,
}));

import { GET } from "@/app/api/triggers/[id]/route";

describe("workflow schedule detail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "session",
    });
    mocks.getTrigger.mockResolvedValue({ id: "trigger-one" });
    mocks.preview.mockResolvedValue({ occurrences: [] });
    mocks.occurrences.mockResolvedValue([]);
    mocks.receipts.mockResolvedValue([]);
    mocks.leases.mockResolvedValue([{
      leaseId: `policy_lease_${"1".repeat(48)}`,
      status: "consumed",
      consumptionReceiptSha256: "2".repeat(64),
      contentIncluded: false,
      leaseGrantsAuthority: false,
    }]);
  });

  it("adds exact actor-scoped, content-free PolicyLease outcomes", async () => {
    const response = await GET(
      new Request("http://asael.test/api/triggers/trigger-one"),
      { params: Promise.resolve({ id: "trigger-one" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.leases).toHaveBeenCalledWith({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      triggerId: "trigger-one",
      limit: 100,
    });
    expect(body.policyLeases).toMatchObject({
      version: "scheduled-policy-lease-outcomes:1",
      available: true,
      contentIncluded: false,
      outcomes: [{
        status: "consumed",
        consumptionReceiptSha256: "2".repeat(64),
        contentIncluded: false,
        leaseGrantsAuthority: false,
      }],
    });
    expect(JSON.stringify(body.policyLeases)).not.toMatch(
      /lease_payload|consumption_payload|principalId|inputSha256|targetSha256/i,
    );
  });
});
