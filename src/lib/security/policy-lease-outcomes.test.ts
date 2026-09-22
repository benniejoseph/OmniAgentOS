import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  sql: vi.fn(),
  actorScope: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: () => mocks.sql,
  hasDatabaseUrl: () => true,
  runWithDatabaseActorScope: mocks.actorScope,
}));

import { listScheduledPolicyLeaseOutcomes } from "@/lib/security/policy-lease-store";

describe("scheduled PolicyLease outcome projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rows.splice(0);
    mocks.sql.mockImplementation(async () => mocks.rows);
    mocks.actorScope.mockImplementation(async (
      _tenantId: string,
      _actorIds: string[],
      operation: () => unknown,
    ) => operation());
  });

  it("lists exact actor-owned lease outcomes without raw authority payloads", async () => {
    mocks.rows.push(
      row({ state: "active", expiresAt: "2026-09-22T10:05:00.000Z" }),
      row({
        state: "consumed",
        expiresAt: "2026-09-22T10:05:00.000Z",
        leaseId: `policy_lease_${"a".repeat(48)}`,
        consumedAt: "2026-09-22T10:02:00.000Z",
        receiptId: `policy_lease_receipt_${"b".repeat(48)}`,
        receiptSha256: "c".repeat(64),
      }),
    );

    const outcomes = await listScheduledPolicyLeaseOutcomes({
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      triggerId: "trigger-one",
      limit: 20,
      now: "2026-09-22T10:06:00.000Z",
    });

    expect(mocks.actorScope).toHaveBeenCalledWith(
      "tenant-one",
      ["actor-one"],
      expect.any(Function),
    );
    expect(mocks.sql.mock.calls[0]?.slice(1)).toEqual([
      "tenant-one",
      "actor-one",
      "trigger-one",
      20,
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "expired",
      "consumed",
    ]);
    expect(outcomes[1]).toMatchObject({
      consumptionReceiptId: `policy_lease_receipt_${"b".repeat(48)}`,
      consumptionReceiptSha256: "c".repeat(64),
      contentIncluded: false,
      leaseGrantsAuthority: false,
    });
    expect(JSON.stringify(outcomes)).not.toMatch(
      /lease_payload|consumption_payload|principalId|inputSha256|targetSha256/i,
    );
  });
});

function row(input: {
  state: "active" | "consumed";
  expiresAt: string;
  leaseId?: string;
  consumedAt?: string;
  receiptId?: string;
  receiptSha256?: string;
}) {
  return {
    lease_id: input.leaseId || `policy_lease_${"1".repeat(48)}`,
    lease_sha256: "2".repeat(64),
    trigger_id: "trigger-one",
    occurrence_id: "occurrence-one",
    workflow_run_id: "workflow-run-one",
    execution_id: "execution-one",
    binding_index: 0,
    binding_sha256: "3".repeat(64),
    tool_contract_sha256: "4".repeat(64),
    tool_id: "calendar.create",
    mutation_policy_sha256: "5".repeat(64),
    influence_manifest_sha256: "6".repeat(64),
    state: input.state,
    issued_at: "2026-09-22T10:00:00.000Z",
    expires_at: input.expiresAt,
    consumed_at: input.consumedAt || null,
    consumption_receipt_sha256: input.receiptSha256 || null,
    consumption_receipt_id: input.receiptId || null,
    durable_consumption_receipt_sha256: input.receiptSha256 || null,
  };
}
