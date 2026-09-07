import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { describe, expect, it } from "vitest";

import { AP2_BOUNDARY_VERSION } from "@/lib/payments/ap2-contracts";
import {
  ap2CredentialAuthorizationRequestSchema,
  ap2CredentialProviderAuthorizationSchema,
  buildAp2CredentialAuthorizationRequest,
  buildAp2CredentialGrant,
  buildAp2CredentialProviderConfiguration,
  credentialProviderSigningPayload,
  providerAuthorizationPublicProof,
  verifyAp2CredentialProviderAuthorization,
  type Ap2CredentialAuthorizationRequest,
  type Ap2CredentialProviderAuthorization,
} from "@/lib/payments/ap2-credential-authorization";
import {
  buildAp2HumanPresentReview,
  type Ap2HumanPresentReview,
  type Ap2HumanPresentTerms,
} from "@/lib/payments/ap2-mandates";
import type {
  Ap2MandateAuthorization,
  Ap2MandateVerificationReceipt,
} from "@/lib/payments/ap2-webauthn";
import { loadAp2Readiness } from "@/lib/payments/ap2-readiness";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const now = new Date("2026-09-07T10:05:00.000Z");

describe("P9.17 deterministic AP2 credential authorization", () => {
  it("derives a short-lived single-use scope from exact verified mandates", () => {
    const fixture = mandateFixture();
    const configuration = providerFixture().configuration;
    const request = buildAp2CredentialAuthorizationRequest({
      ...fixture,
      mandateVerification: fixture.verification,
      configuration,
      now,
      nonce: nonce("scope-one"),
    });

    expect(request.scope).toMatchObject({
      credentialProviderId: "credential_provider_1",
      merchantPaymentProcessorId: "processor_1",
      paymentInstrumentReference: "instrument_ref_1",
      amountMinor: 11_300,
      currency: "USD",
      audience: "processor_1",
      singleUse: true,
      redirectAllowed: false,
    });
    expect(request.scope.expiresAt).toBe("2026-09-07T10:08:00.000Z");
    expect(ap2CredentialAuthorizationRequestSchema.parse(request)).toEqual(request);
  });

  it("verifies the provider signature and removes the scoped token from durable metadata", () => {
    const fixture = completeFixture();
    const verified = verifyAp2CredentialProviderAuthorization(fixture);
    const grant = buildAp2CredentialGrant({
      tenantId: "tenant_1",
      ownerActorId: "actor_1",
      ...fixture,
    });

    expect(verified.scopedToken).toBe("provider-scoped-token-material-0000000001");
    expect(grant).toMatchObject({
      state: "active",
      scopedTokenSha256: sha256("provider-scoped-token-material-0000000001"),
      scope: { singleUse: true, redirectAllowed: false },
    });
    expect(JSON.stringify(grant)).not.toContain("provider-scoped-token-material");
    expect(JSON.stringify(providerAuthorizationPublicProof(verified)))
      .not.toContain("provider-scoped-token-material");
  });

  it.each([
    ["scope", (request: Ap2CredentialAuthorizationRequest) => ({
      ...request,
      scope: { ...request.scope, amountMinor: request.scope.amountMinor + 1 },
    })],
    ["merchant", (request: Ap2CredentialAuthorizationRequest) => ({
      ...request,
      scope: { ...request.scope, merchantSha256: "f".repeat(64) },
    })],
    ["currency", (request: Ap2CredentialAuthorizationRequest) => ({
      ...request,
      scope: { ...request.scope, currency: "EUR" },
    })],
    ["expiry", (request: Ap2CredentialAuthorizationRequest) => ({
      ...request,
      scope: { ...request.scope, expiresAt: "2026-09-07T10:07:00.000Z" },
    })],
    ["nonce", (request: Ap2CredentialAuthorizationRequest) => ({
      ...request,
      scope: { ...request.scope, nonce: nonce("redirected") },
    })],
  ])("rejects an authorization redirected by changed %s", (_name, mutate) => {
    const fixture = completeFixture();
    const changedBody = mutate(fixture.request);
    const { requestSha256: _priorDigest, ...body } = changedBody;
    const changedRequest = ap2CredentialAuthorizationRequestSchema.parse({
      ...body,
      requestSha256: canonicalJsonSha256(body),
    });

    expect(() => verifyAp2CredentialProviderAuthorization({
      ...fixture,
      request: changedRequest,
    })).toThrow(/exact AP2 scope/i);
  });

  it("rejects replay after scope expiry and rejects a changed signature", () => {
    const fixture = completeFixture();
    expect(() => verifyAp2CredentialProviderAuthorization({
      ...fixture,
      now: new Date("2026-09-07T10:08:00.000Z"),
    })).toThrow(/validity interval/i);
    expect(() => verifyAp2CredentialProviderAuthorization({
      ...fixture,
      authorization: { ...fixture.authorization, signature: "AA" },
    })).toThrow(/signature/i);
  });

  it("makes raw credential and redirect fields unrepresentable", () => {
    const fixture = completeFixture();
    expect(ap2CredentialProviderAuthorizationSchema.safeParse({
      ...fixture.authorization,
      cardNumber: "4111111111111111",
    }).success).toBe(false);
    expect(ap2CredentialAuthorizationRequestSchema.safeParse({
      ...fixture.request,
      scope: { ...fixture.request.scope, redirectAllowed: true },
    }).success).toBe(false);
  });
});

function completeFixture() {
  const mandate = mandateFixture();
  const provider = providerFixture();
  const request = buildAp2CredentialAuthorizationRequest({
    review: mandate.review,
    authorization: mandate.authorization,
    mandateVerification: mandate.verification,
    configuration: provider.configuration,
    now,
    nonce: nonce("scope-one"),
  });
  const authorization = signedProviderAuthorization(request, provider.privateKey);
  return {
    request,
    authorization,
    configuration: provider.configuration,
    now: new Date("2026-09-07T10:06:00.000Z"),
  };
}

function providerFixture() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const reviewedAdapter = {
    contractVersion: AP2_BOUNDARY_VERSION,
    adapterContractId: "adapter:credential-provider:test-v1",
    role: "credential_provider" as const,
    operatorName: "Test credential provider",
    endpointOrigin: "https://credential-provider.example",
    endpointAuthenticationProfile: "mtls:credential-provider:test-v1",
    release: "test-v1",
    artifactSha256: sha256("credential-provider-artifact"),
    deterministicVerifierRelease: "verifier-test-v1",
    supportedProtocol: loadAp2Readiness().protocol,
    credentialMaterialExportableToAsael: false as const,
    modelInVerificationPath: false as const,
  };
  const configuration = buildAp2CredentialProviderConfiguration({
    version: "p9.17-ap2-credential-provider:1",
    providerId: "credential_provider_1",
    participantId: "participant:credential-provider:test",
    adapterContract: {
      ...reviewedAdapter,
      review: {
        reviewId: "review:credential-provider:test-v1",
        reviewerPrincipalSha256: sha256("security-reviewer"),
        reviewedAt: "2026-09-01T00:00:00.000Z",
        contractSha256: canonicalJsonSha256(reviewedAdapter),
      },
      rolloutState: "enabled",
    },
    signingKey: {
      keyId: "credential-provider-signing-key:test-v1",
      algorithm: "ES256",
      spkiDerBase64url: spki.toString("base64url"),
      publicKeySha256: createHash("sha256").update(spki).digest("hex"),
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      revocation: { status: "active", effectiveAt: null },
    },
    acceptedMerchantPaymentProcessorIds: ["processor_1"],
    maximumScopeTtlSeconds: 180,
    credentialBoundary: {
      rawCredentialExportableToAsael: false,
      privateSigningKeyExportableToAsael: false,
      providerTokenVisibleToModelOrBrowser: false,
      providerTokenStorage: "encrypted_payment_boundary_only",
      oneTimeScopeRequired: true,
      redirectAllowed: false,
    },
  });
  return { configuration, privateKey };
}

function signedProviderAuthorization(
  request: Ap2CredentialAuthorizationRequest,
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
) {
  const scopedToken = "provider-scoped-token-material-0000000001";
  const unsigned = ap2CredentialProviderAuthorizationSchema.parse({
    version: "p9.17-ap2-provider-authorization:1",
    providerId: "credential_provider_1",
    providerAuthorizationId: "provider-authorization-1",
    requestId: request.requestId,
    requestSha256: request.requestSha256,
    scopeSha256: canonicalJsonSha256(request.scope),
    scopedToken,
    scopedTokenSha256: sha256(scopedToken),
    issuedAt: request.scope.issuedAt,
    expiresAt: request.scope.expiresAt,
    nonce: request.scope.nonce,
    singleUse: true,
    redirectAllowed: false,
    signingKeyId: "credential-provider-signing-key:test-v1",
    signatureAlgorithm: "ES256",
    signature: "AA",
  });
  return {
    ...unsigned,
    signature: sign(
      "sha256",
      credentialProviderSigningPayload(unsigned),
      privateKey,
    ).toString("base64url"),
  } satisfies Ap2CredentialProviderAuthorization;
}

function mandateFixture() {
  const pending = pendingReview();
  const verifiedAt = "2026-09-07T10:00:00.000Z";
  const assertion = {
    id: "credential_1",
    rawId: "credential_1",
    response: {
      clientDataJSON: Buffer.from("client-data").toString("base64url"),
      authenticatorData: Buffer.from("authenticator-data").toString("base64url"),
      signature: Buffer.from("signature").toString("base64url"),
    },
    clientExtensionResults: {},
    type: "public-key" as const,
  };
  const authorizationBody = {
    version: "p9.16-ap2-webauthn-authorization:1" as const,
    authorizationId: "ap2_authorization:22222222-2222-4222-8222-222222222222",
    tenantId: pending.tenantId,
    ownerActorId: pending.ownerActorId,
    reviewId: pending.reviewId,
    reviewSha256: pending.reviewSha256,
    authorizationDigest: pending.authorizationDigest,
    challenge: Buffer.from("challenge").toString("base64url"),
    credentialId: "credential_1",
    credentialSha256: "c".repeat(64),
    trustPolicyId: "hardware-policy-1",
    trustPolicySha256: "d".repeat(64),
    previousCounter: 7,
    newCounter: 8,
    assertion,
    assertionSha256: canonicalJsonSha256(assertion),
    userPresent: true as const,
    userVerified: true as const,
    deviceType: "singleDevice" as const,
    backedUp: false as const,
    checkoutMandateContentSha256: canonicalJsonSha256(pending.checkoutMandateContent),
    paymentMandateContentSha256: canonicalJsonSha256(pending.paymentMandateContent),
    externalEffectAuthority: "none" as const,
    verifiedAt,
  };
  const authorization: Ap2MandateAuthorization = {
    ...authorizationBody,
    authorizationSha256: canonicalJsonSha256(authorizationBody),
  };
  const { reviewSha256: _pendingDigest, ...pendingBody } = pending;
  const authorizedBody = {
    ...pendingBody,
    state: "authorized" as const,
    lifecycleRevision: 2,
    authorizedAt: verifiedAt,
    updatedAt: verifiedAt,
  };
  const review: Ap2HumanPresentReview = {
    ...authorizedBody,
    reviewSha256: canonicalJsonSha256(authorizedBody),
  };
  const receiptBody = {
    version: "p9.16-ap2-mandate-verification:1" as const,
    reviewId: review.reviewId,
    authorizationId: authorization.authorizationId,
    authorizationSha256: authorization.authorizationSha256,
    authorizationDigest: review.authorizationDigest,
    credentialIdSha256: sha256("credential_1"),
    trustPolicySha256: authorization.trustPolicySha256,
    accepted: true as const,
    checks: [
      "exact_review_digest",
      "exact_checkout_mandate_content",
      "exact_payment_mandate_content",
      "credential_and_trust_anchor",
      "webauthn_signature",
      "counter_progression",
      "user_verification_and_backup_state",
      "authorization_time_and_expiry",
    ] as const,
    verifiedAt,
  };
  const verification: Ap2MandateVerificationReceipt = {
    ...receiptBody,
    receiptSha256: canonicalJsonSha256(receiptBody),
  };
  return { review, authorization, verification };
}

function pendingReview() {
  const terms = termsFixture();
  const merchantCheckoutJwt = "merchant.signed.checkout";
  const verificationBody = {
    version: "p9.16-merchant-checkout-verification:1" as const,
    adapterContractId: "merchant_adapter_1",
    adapterRelease: "1.0.0",
    adapterArtifactSha256: "b".repeat(64),
    merchantKeyId: "merchant_key_1",
    checkoutJwtSha256: sha256(merchantCheckoutJwt),
    verifiedTermsSha256: canonicalJsonSha256(terms),
    verifiedAt: "2026-09-07T10:00:00.000Z",
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
    now: new Date("2026-09-07T10:00:00.000Z"),
  });
}

function termsFixture(): Ap2HumanPresentTerms {
  return {
    merchant: { id: "merchant_1", name: "Merchant", website: "https://merchant.example" },
    merchantOrderId: "order_1",
    items: [{ id: "item_1", title: "Item", quantity: 1, unitAmountMinor: 10_000, totalAmountMinor: 10_000 }],
    totals: { currency: "USD", subtotalAmountMinor: 10_000, taxAmountMinor: 800, shippingAmountMinor: 500, discountAmountMinor: 0, totalAmountMinor: 11_300 },
    shipping: { recipientName: "User", addressLines: ["1 Main St"], city: "City", region: "CA", postalCode: "94105", country: "US", serviceLevel: "Standard" },
    paymentInstrument: { id: "instrument_ref_1", type: "card", description: "Visa ···· 4242" },
    paymentConstraints: { credentialProviderId: "credential_provider_1", merchantPaymentProcessorId: "processor_1", allowedInstrumentTypes: ["card"], maximumAmountMinor: 11_300, currency: "USD", immediateExecutionOnly: true },
    expiresAt: "2026-09-07T10:30:00.000Z",
  };
}

function nonce(value: string) {
  return createHash("sha256").update(value).digest().toString("base64url");
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
