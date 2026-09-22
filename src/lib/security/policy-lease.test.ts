import { describe, expect, it } from "vitest";

import {
  buildPolicyLeaseV1,
  consumePolicyLeaseV1,
  PolicyLeaseValidationError,
  policyLeaseV1Schema,
} from "@/lib/security/policy-lease";

const principal = {
  kind: "agent" as const,
  id: "agent:asael",
  generation: 3,
};

function lease() {
  return buildPolicyLeaseV1({
    executionId: "execution-one",
    toolId: "google.gmail.send",
    inputSha256: "1".repeat(64),
    targetSha256: "2".repeat(64),
    principal,
    policySha256: "3".repeat(64),
    influenceManifestSha256: "4".repeat(64),
    issuedAt: "2026-09-22T09:00:00.000Z",
    expiresAt: "2026-09-22T09:05:00.000Z",
  });
}

function attempt(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "execution-one",
    toolId: "google.gmail.send",
    inputSha256: "1".repeat(64),
    targetSha256: "2".repeat(64),
    principal,
    policySha256: "3".repeat(64),
    influenceManifestSha256: "4".repeat(64),
    consumedAt: "2026-09-22T09:01:00.000Z",
    ...overrides,
  };
}

describe("PolicyLeaseV1", () => {
  it("binds one short-lived lease to the exact execution boundary", () => {
    const issued = lease();
    const receipt = consumePolicyLeaseV1({
      lease: issued,
      attempt: attempt(),
    });

    expect(issued).toMatchObject({
      maximumUses: 1,
      leaseGrantsAuthority: false,
    });
    expect(receipt).toMatchObject({
      leaseId: issued.leaseId,
      singleUseConsumed: true,
      receiptGrantsAuthority: false,
    });
    expect(receipt).not.toHaveProperty("toolId");
    expect(receipt).not.toHaveProperty("target");
  });

  it.each([
    ["execution", { executionId: "execution-two" }],
    ["tool", { toolId: "google.drive.delete" }],
    ["input", { inputSha256: "9".repeat(64) }],
    ["target", { targetSha256: "8".repeat(64) }],
    ["principal", {
      principal: { kind: "agent", id: "agent:other", generation: 3 },
    }],
    ["policy", { policySha256: "7".repeat(64) }],
    ["influence", { influenceManifestSha256: "6".repeat(64) }],
  ])("rejects a changed %s binding", (_label, changed) => {
    expect(() => consumePolicyLeaseV1({
      lease: lease(),
      attempt: attempt(changed),
    })).toThrowError(expect.objectContaining({ code: "binding_mismatch" }));
  });

  it("fails before issue, at expiry, and after one consumption", () => {
    const issued = lease();
    expect(() => consumePolicyLeaseV1({
      lease: issued,
      attempt: attempt({ consumedAt: "2026-09-22T08:59:59.999Z" }),
    })).toThrowError(expect.objectContaining({ code: "not_yet_valid" }));
    expect(() => consumePolicyLeaseV1({
      lease: issued,
      attempt: attempt({ consumedAt: issued.expiresAt }),
    })).toThrowError(expect.objectContaining({ code: "expired" }));

    const priorConsumption = consumePolicyLeaseV1({
      lease: issued,
      attempt: attempt(),
    });
    expect(() => consumePolicyLeaseV1({
      lease: issued,
      attempt: attempt({ consumedAt: "2026-09-22T09:02:00.000Z" }),
      priorConsumption,
    })).toThrowError(expect.objectContaining({ code: "already_consumed" }));
  });

  it("rejects lease tampering and overlong authority windows", () => {
    const issued = lease();
    expect(policyLeaseV1Schema.safeParse({
      ...issued,
      toolId: "google.drive.delete",
    }).success).toBe(false);
    expect(() => buildPolicyLeaseV1({
      executionId: "execution-one",
      toolId: "google.gmail.send",
      inputSha256: "1".repeat(64),
      targetSha256: "2".repeat(64),
      principal,
      policySha256: "3".repeat(64),
      influenceManifestSha256: "4".repeat(64),
      issuedAt: "2026-09-22T09:00:00.000Z",
      expiresAt: "2026-09-22T10:00:00.000Z",
    })).toThrow();
  });

  it("surfaces bounded machine-readable validation failures", () => {
    try {
      consumePolicyLeaseV1({
        lease: lease(),
        attempt: attempt({ toolId: "google.drive.delete" }),
      });
      expect.unreachable("expected a binding failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyLeaseValidationError);
      expect((error as PolicyLeaseValidationError).code).toBe("binding_mismatch");
    }
  });
});
