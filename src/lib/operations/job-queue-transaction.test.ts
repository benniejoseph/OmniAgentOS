import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getSql } from "@/lib/db/client";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(),
  rootQuery: vi.fn(),
  transactionQuery: vi.fn(),
  transaction: vi.fn(),
  appendDomainEvent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getDatabaseTenantContext: () => undefined,
  hasDatabaseUrl: () => true,
  getSql: () => Object.assign(mocks.rootQuery, { transaction: mocks.transaction }),
  runWithDatabaseSystemScope: vi.fn(),
}));
vi.mock("@/lib/events/store", () => ({ appendDomainEvent: mocks.appendDomainEvent }));

import { enqueueOperationJob } from "@/lib/operations/job-queue";

const row = {
  id: "coalesced-job",
  tenant_id: "tenant-atomic-enqueue",
  type: "workflow.tick",
  status: "running",
  payload: { workflowRunId: "workflow-atomic-enqueue", __rerunRequested: true },
  dedupe_key: "tenant-atomic-enqueue:workflow:workflow-atomic-enqueue",
  priority: 10,
  attempt: 3,
  max_attempts: 5,
  lease_lapses: 2,
  created_at: "2026-10-02T00:00:00.000Z",
  updated_at: "2026-10-02T00:00:00.000Z",
  run_at: "2026-10-02T00:00:00.000Z",
};

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.transaction.mockImplementation(async (
    callback: (sql: ReturnType<typeof getSql>) => Promise<unknown>,
  ) => callback(mocks.transactionQuery as unknown as ReturnType<typeof getSql>));
  mocks.transactionQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([row]);
  mocks.rootQuery.mockResolvedValue([row]);
});

describe("operation job coalescing transaction", () => {
  const input = {
    tenantId: "tenant-atomic-enqueue",
    type: "workflow.tick" as const,
    dedupeKey: "workflow:workflow-atomic-enqueue",
    payload: { workflowRunId: "workflow-atomic-enqueue" },
  };

  it("uses one transaction clock for lapse settlement and the coalescing write", async () => {
    await expect(enqueueOperationJob(input)).resolves.toMatchObject({
      id: row.id, status: "running", leaseLapses: 2,
    });

    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.transactionQuery).toHaveBeenCalledTimes(2);
    const [settlement, coalescing] = mocks.transactionQuery.mock.calls.map(
      ([strings]) => (strings as TemplateStringsArray).join("?"),
    );
    expect(settlement).toContain("SET lease_lapses = lease_lapses + 1");
    expect(coalescing).toContain("ON CONFLICT (dedupe_key)");
    // Separate statements on the root connection use different NOW() values;
    // a lease could then expire after settlement and evade its lapse count.
    expect(mocks.rootQuery).not.toHaveBeenCalled();
  });

  it("uses an existing caller transaction without opening another", async () => {
    await enqueueOperationJob(input, {
      sql: mocks.transactionQuery as unknown as ReturnType<typeof getSql>,
    });

    expect(mocks.transactionQuery).toHaveBeenCalledTimes(2);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.ensureDatabaseSchema).not.toHaveBeenCalled();
    expect(mocks.rootQuery).not.toHaveBeenCalled();
  });
});
