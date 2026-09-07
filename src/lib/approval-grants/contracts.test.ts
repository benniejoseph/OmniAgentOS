import { describe, expect, it } from "vitest";

import {
  buildApprovalGrantClaimV1,
  buildApprovalGrantV1,
  evaluateApprovalGrant,
  approvalGrantClaimV1Schema,
  approvalGrantV1Schema,
  type ApprovalGrantRequest,
} from "@/lib/approval-grants/contracts";

const issuedAt = "2026-09-07T04:00:00.000Z";
const expiresAt = "2026-09-07T05:00:00.000Z";

function request(
  overrides: Partial<ApprovalGrantRequest> = {},
): ApprovalGrantRequest {
  return {
    tenantId: "tenant-one",
    ownerActorId: "actor-one",
    executingPrincipalType: "system",
    executingPrincipalId: "workflow:run-one",
    planId: "plan-one",
    planSha256: "a".repeat(64),
    domain: "connector",
    actionClass: "connector.demo.create",
    toolId: "connector.demo.create",
    toolContractSha256: "b".repeat(64),
    targetSha256: "c".repeat(64),
    riskLevel: 2,
    reversible: true,
    ...overrides,
  };
}

function grant(overrides: Parameters<typeof buildApprovalGrantV1>[0] extends infer T
  ? Partial<T>
  : never = {}) {
  const binding = request();
  return buildApprovalGrantV1({
    version: "p9.4-approval-grant:1",
    grantId: "grant:11111111-1111-4111-8111-111111111111",
    ...binding,
    approvedByActorId: "approver-one",
    sourceApprovalId: "workflow-event-one",
    issuedAt,
    expiresAt,
    maxUses: 3,
    usedUses: 0,
    state: "active",
    lifecycleRevision: 1,
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  });
}

describe("P9.4 bounded approval grant contracts", () => {
  it("accepts only the exact actor, principal, plan, contract, action, and target", () => {
    const value = grant();
    expect(evaluateApprovalGrant(value, request(), new Date(issuedAt))).toEqual({
      allowed: true,
      reason: "exact_grant",
    });
    for (const changed of [
      request({ ownerActorId: "actor-two" }),
      request({ executingPrincipalId: "workflow:run-two" }),
      request({ planSha256: "d".repeat(64) }),
      request({ actionClass: "connector.demo.delete" }),
      request({ toolContractSha256: "e".repeat(64) }),
      request({ targetSha256: "f".repeat(64) }),
    ]) {
      expect(evaluateApprovalGrant(value, changed, new Date(issuedAt))).toEqual({
        allowed: false,
        reason: "binding_changed",
      });
    }
  });

  it("fails closed after expiry, revocation, or budget exhaustion", () => {
    expect(evaluateApprovalGrant(
      grant(),
      request(),
      new Date(expiresAt),
    )).toEqual({ allowed: false, reason: "expired" });
    expect(evaluateApprovalGrant(
      grant({ state: "revoked", revokedAt: issuedAt }),
      request(),
      new Date(issuedAt),
    )).toEqual({ allowed: false, reason: "inactive" });
    expect(evaluateApprovalGrant(
      grant({ state: "exhausted", usedUses: 3 }),
      request(),
      new Date(issuedAt),
    )).toEqual({ allowed: false, reason: "budget_exhausted" });
  });

  it("rejects irreversible, risk-three, oversized, and long-lived grants", () => {
    expect(() => grant({ reversible: false as true })).toThrow();
    expect(() => grant({ riskLevel: 3 as 2 })).toThrow();
    expect(() => grant({ maxUses: 101 })).toThrow();
    expect(() => grant({ expiresAt: "2026-09-08T04:00:00.001Z" })).toThrow(
      "within 24 hours",
    );
  });

  it("digest-binds immutable grants and append-only claims", () => {
    const value = grant();
    expect(() => approvalGrantV1Schema.parse({
      ...value,
      targetSha256: "d".repeat(64),
    })).toThrow("binding digest does not match");
    const claim = buildApprovalGrantClaimV1({
      version: "p9.4-approval-grant-claim:1",
      claimId: "claim:22222222-2222-4222-8222-222222222222",
      grantId: value.grantId,
      grantBindingSha256: value.bindingSha256,
      tenantId: value.tenantId,
      ownerActorId: value.ownerActorId,
      executionKeySha256: "d".repeat(64),
      useOrdinal: 1,
      claimedAt: issuedAt,
    });
    expect(claim.claimSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => approvalGrantClaimV1Schema.parse({
      ...claim,
      useOrdinal: 2,
    })).toThrow("claim digest does not match");
  });
});
