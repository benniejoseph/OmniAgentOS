import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";

import { AP2_BOUNDARY_VERSION } from "@/lib/payments/ap2-contracts";
import {
  ap2CredentialGrantSchema,
  type Ap2CredentialGrant,
} from "@/lib/payments/ap2-credential-authorization";
import {
  buildAp2HumanPresentReview,
  type Ap2HumanPresentReview,
  type Ap2HumanPresentTerms,
} from "@/lib/payments/ap2-mandates";
import {
  ap2SignedReconciliationObservationSchema,
  ap2VerifiedReceiptSchema,
  buildAp2ReceiptAuthority,
  createInitialAp2PaymentProjection,
  reconcileAp2PaymentProjection,
  reconciliationSigningPayload,
  verifyAp2ReceiptJwt,
  verifyAp2ReconciliationObservation,
  type Ap2PaymentProjection,
  type Ap2ReceiptAuthority,
  type Ap2SignedReconciliationObservation,
} from "@/lib/payments/ap2-receipts";
import type { Ap2MandateAuthorization } from "@/lib/payments/ap2-webauthn";
import { loadAp2Readiness } from "@/lib/payments/ap2-readiness";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const now = new Date("2026-09-07T10:10:00.000Z");

describe("P9.18 signed AP2 receipts and payment reconciliation", () => {
  it("verifies exact checkout and payment receipt JWTs", () => {
    const fixture = paymentFixture();
    const checkoutJwt = receiptJwt({
      authority: fixture.merchant,
      privateKey: fixture.merchantPrivateKey,
      payload: {
        status: "Success",
        iss: fixture.merchant.authority.issuer,
        iat: epoch("2026-09-07T10:08:00.000Z"),
        reference: fixture.projection.checkoutReference,
        order_id: "merchant-order-confirmed",
      },
    });
    const paymentJwt = receiptJwt({
      authority: fixture.processor,
      privateKey: fixture.processorPrivateKey,
      payload: {
        status: "Success",
        iss: fixture.processor.authority.issuer,
        iat: epoch("2026-09-07T10:09:00.000Z"),
        reference: fixture.projection.paymentReference,
        payment_id: "payment-confirmed",
        psp_confirmation_id: "psp-confirmed",
        network_confirmation_id: "network-confirmed",
      },
    });
    const checkout = verifyAp2ReceiptJwt({
      jwt: checkoutJwt,
      kind: "checkout",
      authority: fixture.merchant.authority,
      ...fixture.boundary,
      now,
    });
    const payment = verifyAp2ReceiptJwt({
      jwt: paymentJwt,
      kind: "payment",
      authority: fixture.processor.authority,
      ...fixture.boundary,
      now,
    });

    expect(checkout).toMatchObject({ status: "Success", orderId: "merchant-order-confirmed" });
    expect(payment).toMatchObject({ status: "Success", paymentId: "payment-confirmed" });
    expect(ap2VerifiedReceiptSchema.parse(payment)).toEqual(payment);
  });

  it("never reports paid from receipts without signed provider reconciliation", () => {
    const fixture = paidEvidenceFixture();
    const receiptsOnly = reconcileAp2PaymentProjection({
      stored: fixture.projection,
      checkoutReceipt: fixture.checkoutReceipt,
      paymentReceipt: fixture.paymentReceipt,
      now,
    });
    expect(receiptsOnly.paid).toBe(false);
    expect(receiptsOnly.canonicalStatus).toBe("pending");

    const paid = reconcileAp2PaymentProjection({
      stored: receiptsOnly,
      processorObservation: fixture.processorObservation,
      merchantObservation: fixture.merchantObservation,
      now: new Date("2026-09-07T10:11:00.000Z"),
    });
    expect(paid).toMatchObject({
      paid: true,
      canonicalStatus: "fulfilled",
      authorizationState: "authorized",
      captureState: "captured",
      settlementState: "pending",
      fulfillmentState: "fulfilled",
      discrepancyCodes: [],
    });
  });

  it("projects conflicting receipt and provider states as a recoverable discrepancy", () => {
    const fixture = paidEvidenceFixture();
    const declined = signedObservation({
      projection: fixture.projection,
      authorityFixture: fixture.processor,
      role: "merchant_payment_processor",
      sequence: 2,
      authorizationState: "declined",
      captureState: "not_captured",
      paymentId: "payment-confirmed",
    });
    const projection = reconcileAp2PaymentProjection({
      stored: fixture.projection,
      checkoutReceipt: fixture.checkoutReceipt,
      paymentReceipt: fixture.paymentReceipt,
      processorObservation: declined,
      now,
    });

    expect(projection.paid).toBe(false);
    expect(projection.canonicalStatus).toBe("discrepancy");
    expect(projection.discrepancyCodes).toContain(
      "payment_receipt_accepted_but_provider_declined",
    );
  });

  it("fails closed on receipt reference, signature, amount, and transaction mismatches", () => {
    const fixture = paymentFixture();
    const valid = receiptJwt({
      authority: fixture.processor,
      privateKey: fixture.processorPrivateKey,
      payload: {
        status: "Success",
        iss: fixture.processor.authority.issuer,
        iat: epoch("2026-09-07T10:09:00.000Z"),
        reference: fixture.projection.paymentReference,
        payment_id: "payment-confirmed",
        psp_confirmation_id: "psp-confirmed",
        network_confirmation_id: "network-confirmed",
      },
    });
    const parts = valid.split(".");
    expect(() => verifyAp2ReceiptJwt({
      jwt: `${parts[0]}.${parts[1]}.AA`,
      kind: "payment",
      authority: fixture.processor.authority,
      ...fixture.boundary,
      now,
    })).toThrow(/signature/i);

    const wrongReference = receiptJwt({
      authority: fixture.processor,
      privateKey: fixture.processorPrivateKey,
      payload: {
        status: "Success",
        iss: fixture.processor.authority.issuer,
        iat: epoch("2026-09-07T10:09:00.000Z"),
        reference: Buffer.alloc(32, 3).toString("base64url"),
        payment_id: "payment-confirmed",
        psp_confirmation_id: "psp-confirmed",
        network_confirmation_id: "network-confirmed",
      },
    });
    expect(() => verifyAp2ReceiptJwt({
      jwt: wrongReference,
      kind: "payment",
      authority: fixture.processor.authority,
      ...fixture.boundary,
      now,
    })).toThrow(/reference/i);

    const observation = signedObservation({
      projection: fixture.projection,
      authorityFixture: fixture.processor,
      role: "merchant_payment_processor",
      sequence: 1,
      authorizationState: "authorized",
      captureState: "captured",
      paymentId: "payment-confirmed",
    });
    expect(() => verifyAp2ReconciliationObservation({
      observation: { ...observation, amountMinor: observation.amountMinor + 1 },
      authority: fixture.processor.authority,
      transaction: fixture.projection,
      now,
    })).toThrow();
  });
});

function paidEvidenceFixture() {
  const fixture = paymentFixture();
  const checkoutReceipt = verifyAp2ReceiptJwt({
    jwt: receiptJwt({
      authority: fixture.merchant,
      privateKey: fixture.merchantPrivateKey,
      payload: {
        status: "Success",
        iss: fixture.merchant.authority.issuer,
        iat: epoch("2026-09-07T10:08:00.000Z"),
        reference: fixture.projection.checkoutReference,
        order_id: "merchant-order-confirmed",
      },
    }),
    kind: "checkout",
    authority: fixture.merchant.authority,
    ...fixture.boundary,
    now,
  });
  const paymentReceipt = verifyAp2ReceiptJwt({
    jwt: receiptJwt({
      authority: fixture.processor,
      privateKey: fixture.processorPrivateKey,
      payload: {
        status: "Success",
        iss: fixture.processor.authority.issuer,
        iat: epoch("2026-09-07T10:09:00.000Z"),
        reference: fixture.projection.paymentReference,
        payment_id: "payment-confirmed",
        psp_confirmation_id: "psp-confirmed",
        network_confirmation_id: "network-confirmed",
      },
    }),
    kind: "payment",
    authority: fixture.processor.authority,
    ...fixture.boundary,
    now,
  });
  const processorObservation = signedObservation({
    projection: fixture.projection,
    authorityFixture: fixture.processor,
    role: "merchant_payment_processor",
    sequence: 1,
    authorizationState: "authorized",
    captureState: "captured",
    paymentId: "payment-confirmed",
    checkoutReceiptSha256: checkoutReceipt.receiptSha256,
    paymentReceiptSha256: paymentReceipt.receiptSha256,
  });
  const merchantObservation = signedObservation({
    projection: fixture.projection,
    authorityFixture: fixture.merchant,
    role: "merchant",
    sequence: 1,
    authorizationState: "authorized",
    captureState: "captured",
    paymentId: "payment-confirmed",
    fulfillmentState: "fulfilled",
    orderId: "merchant-order-confirmed",
    checkoutReceiptSha256: checkoutReceipt.receiptSha256,
    paymentReceiptSha256: paymentReceipt.receiptSha256,
  });
  verifyAp2ReconciliationObservation({
    observation: processorObservation,
    authority: fixture.processor.authority,
    transaction: fixture.projection,
    now,
  });
  verifyAp2ReconciliationObservation({
    observation: merchantObservation,
    authority: fixture.merchant.authority,
    transaction: fixture.projection,
    now,
  });
  return { ...fixture, checkoutReceipt, paymentReceipt, processorObservation, merchantObservation };
}

function paymentFixture() {
  const boundary = boundaryFixture();
  const merchant = authorityFixture("merchant");
  const processor = authorityFixture("merchant_payment_processor");
  return {
    boundary,
    merchant,
    processor,
    merchantPrivateKey: merchant.privateKey,
    processorPrivateKey: processor.privateKey,
    projection: createInitialAp2PaymentProjection({ ...boundary, now }),
  };
}

function authorityFixture(role: "merchant" | "merchant_payment_processor") {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ format: "der", type: "spki" });
  const reviewedAdapter = {
    contractVersion: AP2_BOUNDARY_VERSION,
    adapterContractId: `adapter:${role}:receipts-test`,
    role,
    operatorName: `Test ${role}`,
    endpointOrigin: `https://${role.replaceAll("_", "-")}.example`,
    endpointAuthenticationProfile: `mtls:${role}:test`,
    release: "receipts-test-v1",
    artifactSha256: sha256(`artifact:${role}`),
    deterministicVerifierRelease: "receipts-verifier-v1",
    supportedProtocol: loadAp2Readiness().protocol,
    credentialMaterialExportableToAsael: false as const,
    modelInVerificationPath: false as const,
  };
  const authority = buildAp2ReceiptAuthority({
    version: "p9.18-ap2-receipt-authority:1",
    authorityId: `receipt-authority:${role}`,
    role,
    issuer: `issuer:${role}`,
    adapterContract: {
      ...reviewedAdapter,
      review: {
        reviewId: `review:${role}:receipts-test`,
        reviewerPrincipalSha256: sha256("security-reviewer"),
        reviewedAt: "2026-09-01T00:00:00.000Z",
        contractSha256: canonicalJsonSha256(reviewedAdapter),
      },
      rolloutState: "enabled",
    },
    signingKey: {
      keyId: `receipt-key:${role}`,
      algorithm: "ES256",
      spkiDerBase64url: spki.toString("base64url"),
      publicKeySha256: createHash("sha256").update(spki).digest("hex"),
      validFrom: "2026-09-01T00:00:00.000Z",
      validUntil: "2027-09-01T00:00:00.000Z",
      revocation: { status: "active", effectiveAt: null },
    },
    maximumClockSkewSeconds: 60,
    reconciliationSupported: true,
  });
  return { authority, privateKey };
}

function receiptJwt(input: {
  authority: ReturnType<typeof authorityFixture>;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  payload: Record<string, unknown>;
}) {
  const header = encode({ alg: "ES256", typ: "JWT", kid: input.authority.authority.signingKey.keyId });
  const payload = encode(input.payload);
  const signingInput = `${header}.${payload}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${signingInput}.${signature}`;
}

function signedObservation(input: {
  projection: Ap2PaymentProjection;
  authorityFixture: { authority: Ap2ReceiptAuthority; privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"] };
  role: "merchant" | "merchant_payment_processor";
  sequence: number;
  authorizationState: "authorized" | "declined";
  captureState: "captured" | "not_captured";
  paymentId: string;
  fulfillmentState?: "unfulfilled" | "fulfilled";
  orderId?: string;
  checkoutReceiptSha256?: string;
  paymentReceiptSha256?: string;
}) {
  const observedAt = "2026-09-07T10:09:30.000Z";
  const amountState = (state: string, includeAmount: boolean) => ({
    state,
    amountMinor: includeAmount ? input.projection.amountMinor : null,
    currency: includeAmount ? input.projection.currency : null,
    providerEventId: `${state}-event-${input.sequence}`,
    effectiveAt: observedAt,
  });
  const body = {
    version: "p9.18-ap2-reconciliation:1" as const,
    observationId: `ap2_reconciliation:${input.sequence.toString().padStart(8, "0")}-1111-4111-8111-${input.role === "merchant" ? "111111111111" : "222222222222"}`,
    authorityId: input.authorityFixture.authority.authorityId,
    authorityRole: input.role,
    transactionId: input.projection.transactionId,
    reviewId: input.projection.reviewId,
    grantId: input.projection.grantId,
    sequence: input.sequence,
    checkoutReference: input.projection.checkoutReference,
    paymentReference: input.projection.paymentReference,
    merchantOrderId: input.orderId || null,
    providerPaymentId: input.paymentId,
    amountMinor: input.projection.amountMinor,
    currency: input.projection.currency,
    authorization: amountState(input.authorizationState, input.authorizationState === "authorized"),
    capture: amountState(input.captureState, input.captureState === "captured"),
    settlement: amountState("pending", true),
    cancellation: amountState("none", false),
    refund: amountState("none", false),
    dispute: { state: "none" as const, providerEventId: null, effectiveAt: observedAt },
    fulfillment: {
      state: input.fulfillmentState || "unfulfilled",
      providerEventId: input.role === "merchant" ? `fulfillment-${input.sequence}` : null,
      effectiveAt: input.role === "merchant" ? observedAt : null,
    },
    checkoutReceiptSha256: input.checkoutReceiptSha256 || null,
    paymentReceiptSha256: input.paymentReceiptSha256 || null,
    observedAt,
  };
  const unsigned = ap2SignedReconciliationObservationSchema.parse({
    ...body,
    observationSha256: canonicalJsonSha256(body),
    signingKeyId: input.authorityFixture.authority.signingKey.keyId,
    signatureAlgorithm: "ES256",
    signature: "AA",
  });
  return {
    ...unsigned,
    signature: sign(
      "sha256",
      reconciliationSigningPayload(unsigned),
      input.authorityFixture.privateKey,
    ).toString("base64url"),
  } satisfies Ap2SignedReconciliationObservation;
}

function boundaryFixture() {
  const pending = pendingReview();
  const authorization = authorizationFixture(pending);
  const { reviewSha256: _pendingDigest, ...pendingBody } = pending;
  const authorizedBody = {
    ...pendingBody,
    state: "authorized" as const,
    lifecycleRevision: 2,
    authorizedAt: authorization.verifiedAt,
    updatedAt: authorization.verifiedAt,
  };
  const review: Ap2HumanPresentReview = {
    ...authorizedBody,
    reviewSha256: canonicalJsonSha256(authorizedBody),
  };
  const scope = {
    purpose: "single_ap2_transaction" as const,
    credentialProviderId: "credential_provider_1",
    merchantPaymentProcessorId: "processor_1",
    merchantSha256: canonicalJsonSha256(review.terms.merchant),
    checkoutHash: review.checkoutMandateContent.checkout_hash,
    checkoutMandateContentSha256: canonicalJsonSha256(review.checkoutMandateContent),
    paymentMandateContentSha256: canonicalJsonSha256(review.paymentMandateContent),
    paymentInstrumentReference: review.terms.paymentInstrument.id,
    paymentInstrumentSha256: canonicalJsonSha256(review.terms.paymentInstrument),
    amountMinor: review.terms.totals.totalAmountMinor,
    currency: review.terms.totals.currency,
    intentSha256: review.intentSha256,
    shoppingAgentPrincipalSha256: sha256(review.shoppingAgentPrincipalId),
    authorizationSha256: authorization.authorizationSha256,
    mandateVerificationReceiptSha256: sha256("mandate-verification"),
    audience: "processor_1",
    nonce: createHash("sha256").update("nonce").digest().toString("base64url"),
    issuedAt: "2026-09-07T10:05:00.000Z",
    notBefore: "2026-09-07T10:05:00.000Z",
    expiresAt: "2026-09-07T10:15:00.000Z",
    singleUse: true as const,
    redirectAllowed: false as const,
  };
  const grantBody = {
    version: "p9.17-ap2-credential-grant:1" as const,
    grantId: "ap2_credential_grant:33333333-3333-4333-8333-333333333333",
    tenantId: review.tenantId,
    ownerActorId: review.ownerActorId,
    reviewId: review.reviewId,
    authorizationId: authorization.authorizationId,
    requestId: "ap2_credential_request:44444444-4444-4444-8444-444444444444",
    requestSha256: sha256("request"),
    providerId: "credential_provider_1",
    providerConfigurationSha256: sha256("provider-config"),
    providerAuthorizationIdSha256: sha256("provider-auth"),
    providerAuthorizationSha256: sha256("provider-auth-proof"),
    scopedTokenSha256: sha256("scoped-token"),
    scope,
    scopeSha256: canonicalJsonSha256(scope),
    state: "consumed" as const,
    lifecycleRevision: 2,
    createdAt: "2026-09-07T10:05:00.000Z",
    consumedAt: "2026-09-07T10:06:00.000Z",
    revokedAt: null,
    expiredAt: null,
  };
  const grant: Ap2CredentialGrant = ap2CredentialGrantSchema.parse({
    ...grantBody,
    grantSha256: canonicalJsonSha256(grantBody),
  });
  return { review, authorization, grant };
}

function authorizationFixture(review: ReturnType<typeof pendingReview>) {
  const assertion = {
    id: "credential_1",
    rawId: "credential_1",
    response: {
      clientDataJSON: encode("client"),
      authenticatorData: encode("authenticator"),
      signature: encode("signature"),
    },
    clientExtensionResults: {},
    type: "public-key" as const,
  };
  const body = {
    version: "p9.16-ap2-webauthn-authorization:1" as const,
    authorizationId: "ap2_authorization:22222222-2222-4222-8222-222222222222",
    tenantId: review.tenantId,
    ownerActorId: review.ownerActorId,
    reviewId: review.reviewId,
    reviewSha256: review.reviewSha256,
    authorizationDigest: review.authorizationDigest,
    challenge: encode("challenge"),
    credentialId: "credential_1",
    credentialSha256: sha256("credential"),
    trustPolicyId: "trust-policy-1",
    trustPolicySha256: sha256("trust-policy"),
    previousCounter: 1,
    newCounter: 2,
    assertion,
    assertionSha256: canonicalJsonSha256(assertion),
    userPresent: true as const,
    userVerified: true as const,
    deviceType: "singleDevice" as const,
    backedUp: false as const,
    checkoutMandateContentSha256: canonicalJsonSha256(review.checkoutMandateContent),
    paymentMandateContentSha256: canonicalJsonSha256(review.paymentMandateContent),
    externalEffectAuthority: "none" as const,
    verifiedAt: "2026-09-07T10:05:00.000Z",
  };
  return {
    ...body,
    authorizationSha256: canonicalJsonSha256(body),
  } satisfies Ap2MandateAuthorization;
}

function pendingReview() {
  const terms = termsFixture();
  const jwt = "merchant.signed.checkout";
  const verification = {
    version: "p9.16-merchant-checkout-verification:1" as const,
    adapterContractId: "merchant_adapter_1",
    adapterRelease: "1.0.0",
    adapterArtifactSha256: sha256("merchant-adapter"),
    merchantKeyId: "merchant_key_1",
    checkoutJwtSha256: sha256(jwt),
    verifiedTermsSha256: canonicalJsonSha256(terms),
    verifiedAt: "2026-09-07T10:00:00.000Z",
  };
  return buildAp2HumanPresentReview({
    reviewId: "ap2_review:11111111-1111-4111-8111-111111111111",
    tenantId: "tenant_1",
    ownerActorId: "actor_1",
    shoppingAgentPrincipalId: "agent_1",
    intentSha256: sha256("intent"),
    merchantCheckoutJwt: jwt,
    merchantCheckoutVerification: {
      ...verification,
      verificationSha256: canonicalJsonSha256(verification),
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

function encode(value: unknown) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function epoch(value: string) {
  return Math.floor(Date.parse(value) / 1_000);
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
