import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  AP2_HUMAN_PRESENT_IMPLEMENTATION_MANIFEST,
  ap2AuthorizationChallenge,
  ap2HumanPresentReviewSchema,
  buildAp2HumanPresentReview,
  type Ap2HumanPresentTerms,
} from "@/lib/payments/ap2-mandates";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const now = new Date("2026-09-07T10:00:00.000Z");

describe("P9.16 AP2 human-present mandate contracts", () => {
  it("pins every consumed AP2 document and schema", () => {
    expect(AP2_HUMAN_PRESENT_IMPLEMENTATION_MANIFEST).toMatchObject({
      protocolRelease: "v0.2.0",
      reviewedCommit: "b4587ac1d055888a73b4b21750973cffba961793",
    });
    expect(AP2_HUMAN_PRESENT_IMPLEMENTATION_MANIFEST.normativeDocuments)
      .toEqual(expect.arrayContaining([
        "docs/ap2/checkout_mandate.md",
        "docs/ap2/payment_mandate.md",
        "docs/ap2/agent_authorization.md",
        "code/sdk/schemas/ap2/checkout_mandate.json",
        "code/sdk/schemas/ap2/payment_mandate.json",
      ]));
  });

  it("binds exact displayed terms into closed Checkout and Payment Mandates", () => {
    const review = fixtureReview();

    expect(review.checkoutMandateContent).toMatchObject({
      vct: "mandate.checkout.1",
      checkout_jwt: "merchant.signed.checkout",
    });
    expect(review.paymentMandateContent).toMatchObject({
      vct: "mandate.payment.1",
      transaction_id: review.checkoutMandateContent.checkout_hash,
      payment_amount: { amount: 11_300, currency: "USD" },
      payment_instrument: {
        id: "instrument_ref_1",
        type: "card",
        description: "Visa ···· 4242",
      },
    });
    expect(review.paymentMandateContent.risk_data).toMatchObject({
      intent_sha256: "a".repeat(64),
      exact_terms_sha256: review.exactTermsSha256,
    });
    expect(ap2AuthorizationChallenge(review)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("rejects a material cart change without fresh merchant verification and authorization", () => {
    const review = fixtureReview();
    const changed = structuredClone(review);
    changed.terms.items[0].quantity = 2;
    changed.terms.items[0].totalAmountMinor = 20_000;
    changed.terms.totals.subtotalAmountMinor = 20_000;
    changed.terms.totals.totalAmountMinor = 21_300;
    changed.terms.paymentConstraints.maximumAmountMinor = 21_300;

    expect(() => ap2HumanPresentReviewSchema.parse(changed)).toThrow(
      /Displayed terms digest does not match/i,
    );
  });

  it("rejects inconsistent line-item arithmetic", () => {
    const terms = fixtureTerms();
    terms.items[0].totalAmountMinor = 9_999;

    expect(() => fixtureReview(terms)).toThrow(/unit amount times quantity/i);
  });
});

function fixtureReview(terms = fixtureTerms()) {
  const merchantCheckoutJwt = "merchant.signed.checkout";
  const verifiedAt = now.toISOString();
  const verificationBody = {
    version: "p9.16-merchant-checkout-verification:1" as const,
    adapterContractId: "merchant_adapter_1",
    adapterRelease: "1.0.0",
    adapterArtifactSha256: "b".repeat(64),
    merchantKeyId: "merchant_key_1",
    checkoutJwtSha256: sha256Hex(merchantCheckoutJwt),
    verifiedTermsSha256: canonicalJsonSha256(terms),
    verifiedAt,
  };
  return buildAp2HumanPresentReview({
    reviewId: "ap2_review:11111111-1111-4111-8111-111111111111",
    tenantId: "tenant_1",
    ownerActorId: "actor_1",
    shoppingAgentPrincipalId: "agent_1",
    intentSha256: "a".repeat(64),
    merchantCheckoutJwt,
    merchantCheckoutVerification: {
      ...verificationBody,
      verificationSha256: canonicalJsonSha256(verificationBody),
    },
    terms,
    now,
  });
}

function fixtureTerms(): Ap2HumanPresentTerms {
  return {
    merchant: {
      id: "merchant_1",
      name: "Demo Merchant",
      website: "https://merchant.example",
    },
    merchantOrderId: "order_1",
    items: [{
      id: "item_1",
      title: "Example item",
      quantity: 1,
      unitAmountMinor: 10_000,
      totalAmountMinor: 10_000,
    }],
    totals: {
      currency: "USD",
      subtotalAmountMinor: 10_000,
      taxAmountMinor: 800,
      shippingAmountMinor: 500,
      discountAmountMinor: 0,
      totalAmountMinor: 11_300,
    },
    shipping: {
      recipientName: "Test User",
      addressLines: ["1 Test Street"],
      city: "Test City",
      region: "CA",
      postalCode: "94105",
      country: "US",
      serviceLevel: "Standard",
    },
    paymentInstrument: {
      id: "instrument_ref_1",
      type: "card",
      description: "Visa ···· 4242",
    },
    paymentConstraints: {
      credentialProviderId: "credential_provider_1",
      merchantPaymentProcessorId: "processor_1",
      allowedInstrumentTypes: ["card"],
      maximumAmountMinor: 11_300,
      currency: "USD",
      immediateExecutionOnly: true,
    },
    expiresAt: "2026-09-07T10:30:00.000Z",
  };
}

function sha256Hex(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
