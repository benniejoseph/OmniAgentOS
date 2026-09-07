import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  ap2AuthorizationChallenge,
  buildAp2HumanPresentReview,
  type Ap2HumanPresentTerms,
} from "@/lib/payments/ap2-mandates";
import {
  ap2MandateAuthorizationSchema,
  beginAp2MandateAuthorization,
  verifyAp2MandateAuthorization,
  type Ap2PaymentSigningCredential,
  type Ap2WebAuthnTrustPolicy,
} from "@/lib/payments/ap2-webauthn";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const now = new Date("2026-09-07T10:00:00.000Z");

describe("P9.16 payment WebAuthn authorization", () => {
  it("generates a user-verifying request for the exact mandate digest", async () => {
    const review = fixtureReview();
    const result = await beginAp2MandateAuthorization({
      review,
      credentials: [fixtureCredential()],
      policy: fixturePolicy(),
      now,
    });

    expect(result.options).toMatchObject({
      challenge: ap2AuthorizationChallenge(review),
      rpId: "asael.example",
      userVerification: "required",
      allowCredentials: [{ id: "credential_1" }],
    });
  });

  it("persists a digest-bound proof only after deterministic verification", async () => {
    const review = fixtureReview();
    const credential = fixtureCredential();
    const response = fixtureAssertion();
    const authorization = await verifyAp2MandateAuthorization({
      authorizationId: "ap2_authorization:22222222-2222-4222-8222-222222222222",
      review,
      credential,
      policy: fixturePolicy(),
      response,
      now,
      verify: vi.fn().mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: "credential_1",
          newCounter: 8,
          userVerified: true,
          credentialDeviceType: "singleDevice",
          credentialBackedUp: false,
          origin: "https://asael.example",
          rpID: "asael.example",
        },
      }),
    });

    expect(authorization).toMatchObject({
      reviewSha256: review.reviewSha256,
      authorizationDigest: review.authorizationDigest,
      credentialId: "credential_1",
      previousCounter: 7,
      newCounter: 8,
      externalEffectAuthority: "none",
    });
    expect(ap2MandateAuthorizationSchema.parse(authorization)).toEqual(authorization);
  });

  it("rejects backup-eligible authenticator assertions", async () => {
    await expect(verifyAp2MandateAuthorization({
      authorizationId: "ap2_authorization:22222222-2222-4222-8222-222222222222",
      review: fixtureReview(),
      credential: fixtureCredential(),
      policy: fixturePolicy(),
      response: fixtureAssertion(),
      now,
      verify: vi.fn().mockResolvedValue({
        verified: true,
        authenticationInfo: {
          credentialID: "credential_1",
          newCounter: 8,
          userVerified: true,
          credentialDeviceType: "multiDevice",
          credentialBackedUp: true,
          origin: "https://asael.example",
          rpID: "asael.example",
        },
      }),
    })).rejects.toThrow(/could not be verified/i);
  });

  it("rejects expired reviews before invoking the verifier", async () => {
    const verify = vi.fn();
    await expect(verifyAp2MandateAuthorization({
      authorizationId: "ap2_authorization:22222222-2222-4222-8222-222222222222",
      review: fixtureReview(),
      credential: fixtureCredential(),
      policy: fixturePolicy(),
      response: fixtureAssertion(),
      now: new Date("2026-09-07T11:00:00.000Z"),
      verify,
    })).rejects.toThrow(/expired/i);
    expect(verify).not.toHaveBeenCalled();
  });
});

function fixturePolicy(): Ap2WebAuthnTrustPolicy {
  const body = {
    version: "p9.16-ap2-webauthn-trust-policy:1" as const,
    policyId: "payment-hardware-policy-1",
    rpId: "asael.example",
    expectedOrigin: "https://asael.example",
    allowedAaguids: ["11111111-1111-4111-8111-111111111111"],
    acceptedAttestationFormats: ["apple"] as const,
    assurance: {
      hardwareBacked: true as const,
      privateKeyNonExportable: true as const,
      singleDeviceRequired: true as const,
      backupEligible: false as const,
      userVerificationRequired: true as const,
    },
    reviewerPrincipalSha256: "9".repeat(64),
    reviewedAt: "2026-09-01T00:00:00.000Z",
    validFrom: "2026-09-01T00:00:00.000Z",
    validUntil: "2027-09-01T00:00:00.000Z",
  };
  return { ...body, policySha256: canonicalJsonSha256(body) };
}

function fixtureCredential(): Ap2PaymentSigningCredential {
  const body = {
    version: "p9.16-ap2-webauthn-credential:1" as const,
    credentialId: "credential_1",
    tenantId: "tenant_1",
    ownerActorId: "actor_1",
    publicKey: Buffer.from("public-key").toString("base64url"),
    counter: 7,
    transports: ["internal"],
    aaguid: "11111111-1111-4111-8111-111111111111",
    attestationFormat: "apple" as const,
    deviceType: "singleDevice" as const,
    backedUp: false as const,
    signerProfile: "direct_hardware_webauthn_key:1" as const,
    trustPolicyId: "payment-hardware-policy-1",
    trustPolicySha256: fixturePolicy().policySha256,
    state: "active" as const,
    lifecycleRevision: 1,
    createdAt: now.toISOString(),
    lastUsedAt: null,
    revokedAt: null,
  };
  return { ...body, credentialSha256: canonicalJsonSha256(body) };
}

function fixtureAssertion() {
  return {
    id: "credential_1",
    rawId: "credential_1",
    response: {
      clientDataJSON: Buffer.from("client-data").toString("base64url"),
      authenticatorData: Buffer.from("auth-data").toString("base64url"),
      signature: Buffer.from("signature").toString("base64url"),
    },
    authenticatorAttachment: "platform" as const,
    clientExtensionResults: {},
    type: "public-key" as const,
  };
}

function fixtureReview() {
  const terms = fixtureTerms();
  const checkoutJwt = "merchant.signed.checkout";
  const verificationBody = {
    version: "p9.16-merchant-checkout-verification:1" as const,
    adapterContractId: "merchant_adapter_1",
    adapterRelease: "1.0.0",
    adapterArtifactSha256: "b".repeat(64),
    merchantKeyId: "merchant_key_1",
    checkoutJwtSha256: sha256Utf8(checkoutJwt),
    verifiedTermsSha256: canonicalJsonSha256(terms),
    verifiedAt: now.toISOString(),
  };
  return buildAp2HumanPresentReview({
    reviewId: "ap2_review:11111111-1111-4111-8111-111111111111",
    tenantId: "tenant_1",
    ownerActorId: "actor_1",
    shoppingAgentPrincipalId: "agent_1",
    intentSha256: "a".repeat(64),
    merchantCheckoutJwt: checkoutJwt,
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
    merchant: { id: "merchant_1", name: "Merchant", website: "https://merchant.example" },
    merchantOrderId: "order_1",
    items: [{ id: "item_1", title: "Item", quantity: 1, unitAmountMinor: 100, totalAmountMinor: 100 }],
    totals: { currency: "USD", subtotalAmountMinor: 100, taxAmountMinor: 0, shippingAmountMinor: 0, discountAmountMinor: 0, totalAmountMinor: 100 },
    shipping: { recipientName: "User", addressLines: ["1 Main St"], city: "City", region: "CA", postalCode: "94105", country: "US", serviceLevel: "Standard" },
    paymentInstrument: { id: "instrument_1", type: "card", description: "Visa ···· 4242" },
    paymentConstraints: { credentialProviderId: "cp_1", merchantPaymentProcessorId: "mpp_1", allowedInstrumentTypes: ["card"], maximumAmountMinor: 100, currency: "USD", immediateExecutionOnly: true },
    expiresAt: "2026-09-07T10:30:00.000Z",
  };
}

function sha256Utf8(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
