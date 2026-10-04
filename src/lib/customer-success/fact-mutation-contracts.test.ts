import { describe, expect, it } from "vitest";
import { buildCustomerFactRevision } from "@/lib/customer-success/contracts";
import { buildCustomerFactNativeAcceptance, buildCustomerFactNativeIntent, buildCustomerFactNativeSource,
  customerFactNativeAcceptanceSchema, customerFactNativeRequestSchema } from "@/lib/customer-success/fact-mutation-contracts";
import { factFixture, manualFactValues } from "@/lib/customer-success/fact-mutation.test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

describe("exact manual fact mutation contracts", () => {
  it("binds every existing fact kind to manual operator provenance and a stable authored intent", () => {
    expect(new Set(manualFactValues.map((value) => value.kind)).size).toBe(12);
    for (const value of manualFactValues) {
      const f = factFixture(value);
      expect(customerFactNativeAcceptanceSchema.parse(f.acceptance)).toEqual(f.acceptance);
      expect(f.acceptance.requestSha256).toBe(canonicalJsonSha256(f.intent));
      expect(f.fact.source).toMatchObject({ sourceKind: "manual", permissionBasis: "operator_assertion", providerId: null });
      expect(buildCustomerFactNativeIntent({ ...f, idempotencyKey: f.key, request: f.request })).toEqual(f.intent);
    }
  });
  it("rejects incomplete pins, invented provenance, duplicate purposes, imprecise dates and unsafe money", () => {
    const { request } = factFixture();
    for (const invalid of [
      { ...request, source: { sourceKind: "crm" } }, { ...request, manualSource: { ...request.manualSource, providerId: "salesforce" } },
      { ...request, operation: "revise" }, { ...request, expectedFactRevision: 1 },
      { ...request, allowedPurposeIds: ["customer_success.account.read", "customer_success.account.read"] },
      { ...request, validFrom: "2026-10-05T12:00:00Z" },
      { ...request, value: { ...manualFactValues[4], amountMinor: Number.MAX_SAFE_INTEGER + 1 } },
    ]) expect(customerFactNativeRequestSchema.safeParse(invalid).success).toBe(false);
  });
  it("binds revise and retract to the exact previous fact hash and semantic revision", () => {
    const f = factFixture();
    for (const operation of ["revise", "retract"] as const) {
      const request = customerFactNativeRequestSchema.parse({ ...f.request, operation, factId: f.fact.factId,
        expectedFactRevision: 1, expectedFactSha256: f.fact.factSha256 });
      const intent = buildCustomerFactNativeIntent({ ...f, idempotencyKey: operation, request });
      const fact = buildCustomerFactRevision({ ...f.fact, revision: 2, mutationId: intent.mutationId,
        state: operation === "retract" ? "retracted" : "active", source: buildCustomerFactNativeSource(intent, f.fact.recordedAt) });
      const accepted = buildCustomerFactNativeAcceptance(intent, fact);
      expect(accepted).toMatchObject({ operation, factRevision: 2, expectedFactSha256: f.fact.factSha256 });
      expect(() => buildCustomerFactNativeAcceptance(intent, f.fact)).toThrow();
    }
  });
  it("cannot transplant or relabel an acceptance even after recomputing its outer digest", () => {
    const f = factFixture(), { acceptanceSha256: _digest, ...body } = f.acceptance;
    for (const changed of [{ ...body, sourceKind: "crm" }, { ...body, sourceRevisionSha256: "f".repeat(64) },
      { ...body, canonicalActorId: "actor:22222222-2222-4222-8222-222222222222" }, { ...body, factRevision: 2 }]) {
      expect(customerFactNativeAcceptanceSchema.safeParse({ ...changed, acceptanceSha256: canonicalJsonSha256(changed) }).success).toBe(false);
    }
  });
});
