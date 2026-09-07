import { describe, expect, it } from "vitest";

import { ap2ReadinessSchema, loadAp2Readiness } from "@/lib/payments/ap2-readiness";

describe("AP2 payment readiness", () => {
  it("publishes every role and responsibility while keeping payment disabled", () => {
    const readiness = loadAp2Readiness();
    expect(readiness.roleContracts.map((contract) => contract.role)).toEqual([
      "shopping_agent",
      "trusted_surface",
      "credential_provider",
      "merchant",
      "merchant_payment_processor",
    ]);
    expect(readiness.capability).toEqual({
      state: "disabled_configuration_only",
      transactionsPermitted: false,
      registeredPaymentEffectToolCount: 0,
      acceptedAdapterReleaseCount: 0,
      humanPresentMandateFlowImplemented: true,
      credentialIsolationImplemented: true,
      humanPresentFlowEnabled: false,
      humanNotPresentFlowEnabled: false,
      missingGates: [
        "p9.18_signed_receipts_and_reconciliation",
      ],
      activationBlockers: [
        "reviewed_merchant_adapter",
        "reviewed_webauthn_attestation_policy",
        "isolated_credential_provider",
        "reviewed_merchant_payment_processor",
        "signed_receipt_reconciliation",
      ],
    });
    expect(readiness.humanPresentMandates).toMatchObject({
      schemaMigrationVersion: 125,
      trustedSurfacePath: "/app/payments",
      agentCanRegisterOrSign: false,
      authorizationConfersPaymentEffectAuthority: false,
    });
    expect(readiness.credentialAuthorization).toMatchObject({
      schemaMigrationVersion: 126,
      rawCredentialOrSigningMaterialRepresentable: false,
      scopedProviderTokenReturnedByApiOrTool: false,
      oneTimeClaimDestroysSealedToken: true,
      authorizationConfersPaymentEffectAuthority: false,
    });
    expect(readiness.acceptedAdapterContracts).toEqual([]);
    expect(readiness.configuredKeyAuthorities).toEqual([]);
  });

  it("rejects a readiness projection with a changed capability or digest", () => {
    const readiness = loadAp2Readiness();
    expect(ap2ReadinessSchema.safeParse({
      ...readiness,
      capability: { ...readiness.capability, transactionsPermitted: true },
    }).success).toBe(false);
    expect(ap2ReadinessSchema.safeParse({
      ...readiness,
      readinessSha256: "0".repeat(64),
    }).success).toBe(false);
  });
});
