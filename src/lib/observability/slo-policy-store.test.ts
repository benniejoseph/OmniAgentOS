import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-slo-policy-"),
  );
  delete process.env.DATABASE_URL;
});

describe("SLO policy governance (file mode)", () => {
  it("preserves the seeded approval-policy version on the first update", async () => {
    const store = await import("@/lib/observability/slo-policy-store");
    const defaults = store.getDefaultObservabilitySloApprovalPolicyConfig();

    const updated = await store.saveObservabilitySloApprovalPolicyConfig(
      {
        ...defaults,
        version: 1,
        metadata: { source: "test" },
      },
      {
        expectedVersion: 1,
        changedBy: "admin-a",
        changeReason: "Exercise first-write version history.",
      },
    );

    expect(updated.version).toBe(2);
    await expect(
      store.listObservabilitySloApprovalPolicyVersions({ limit: 10 }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ version: 1 }),
        expect.objectContaining({ version: 2 }),
      ]),
    );
  });

  it("rejects a stale bulk rollback without replacing concurrent policy edits", async () => {
    const store = await import("@/lib/observability/slo-policy-store");
    const tenantId = "tenant-bulk-cas";
    const beforePolicies = await store.listObservabilitySloPolicies({
      tenantId,
      includeDisabled: true,
    });
    const reset = await store.requestObservabilitySloPolicyChange({
      policyId: "defaults",
      action: "reset_defaults",
      tenantId,
      requestedBy: "requester",
      reason: "Reset defaults for rollback coverage.",
      metadata: { beforePolicies },
    });
    const appliedReset = await store.applyObservabilitySloPolicyChange(
      reset.id,
      {
        tenantId,
        reviewedBy: "system-reset",
        reviewedRole: "system",
        reviewReason:
          "Emergency reset approved for deterministic rollback test coverage.",
        breakGlass: true,
      },
    );
    expect(appliedReset.change.status).toBe("applied");

    const rollback = await store.rollbackObservabilitySloPolicyChange(
      reset.id,
      {
        tenantId,
        requestedBy: "requester",
        reason: "Restore the pre-reset policy collection.",
      },
    );
    const current = await store.getObservabilitySloPolicy("error_budget", {
      tenantId,
    });
    expect(current).not.toBeNull();
    await store.saveObservabilitySloPolicy({
      ...current!,
      name: "Concurrent operator edit",
    });

    const result = await store.applyObservabilitySloPolicyChange(
      rollback.change.id,
      {
        tenantId,
        reviewedBy: "system-rollback",
        reviewedRole: "system",
        reviewReason:
          "Emergency rollback attestation that is intentionally now stale.",
        breakGlass: true,
      },
    );

    expect(result.change.status).toBe("conflicted");
    await expect(
      store.getObservabilitySloPolicy("error_budget", { tenantId }),
    ).resolves.toMatchObject({ name: "Concurrent operator edit" });
  });
});
