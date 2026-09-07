import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { z } from "zod";

import {
  ap2AdapterContractSchema,
  type Ap2AdapterContract,
} from "@/lib/payments/ap2-contracts";
import {
  ap2CredentialGrantSchema,
  type Ap2CredentialGrant,
} from "@/lib/payments/ap2-credential-authorization";
import {
  ap2HumanPresentReviewSchema,
  type Ap2HumanPresentReview,
} from "@/lib/payments/ap2-mandates";
import {
  ap2MandateAuthorizationSchema,
  type Ap2MandateAuthorization,
} from "@/lib/payments/ap2-webauthn";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AP2_RECEIPT_LEDGER_VERSION =
  "p9.18-ap2-receipt-ledger:1" as const;
export const AP2_RECONCILIATION_VERSION =
  "p9.18-ap2-reconciliation:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const opaqueIdSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(300_000);
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const amountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const uuidId = (prefix: string) => z.string().regex(
  new RegExp(`^${prefix}:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`),
);

const receiptPublicKeySchema = z.object({
  keyId: opaqueIdSchema,
  algorithm: z.literal("ES256"),
  spkiDerBase64url: base64UrlSchema.refine(
    (value) => decodedLength(value) >= 64 && decodedLength(value) <= 2_048,
  ),
  publicKeySha256: sha256Schema,
  validFrom: timestampSchema,
  validUntil: timestampSchema,
  revocation: z.object({
    status: z.enum(["active", "revoked"]),
    effectiveAt: timestampSchema.nullable(),
  }).strict(),
}).strict().superRefine((key, context) => {
  if (key.publicKeySha256 !== sha256Bytes(Buffer.from(key.spkiDerBase64url, "base64url"))) {
    issue(context, ["publicKeySha256"], "Receipt key digest does not match.");
  }
  if (Date.parse(key.validFrom) >= Date.parse(key.validUntil)) {
    issue(context, ["validUntil"], "Receipt key validity interval is invalid.");
  }
  if ((key.revocation.status === "active") !== (key.revocation.effectiveAt === null)) {
    issue(context, ["revocation"], "Receipt key revocation metadata is inconsistent.");
  }
});

const receiptAuthorityBodySchema = z.object({
  version: z.literal("p9.18-ap2-receipt-authority:1"),
  authorityId: opaqueIdSchema,
  role: z.enum(["merchant", "merchant_payment_processor"]),
  issuer: opaqueIdSchema,
  adapterContract: ap2AdapterContractSchema,
  signingKey: receiptPublicKeySchema,
  maximumClockSkewSeconds: z.number().int().min(0).max(300),
  reconciliationSupported: z.literal(true),
}).strict().superRefine((authority, context) => {
  if (authority.adapterContract.role !== authority.role) {
    issue(context, ["adapterContract", "role"], "Receipt authority role and adapter role must match.");
  }
  if (authority.adapterContract.rolloutState !== "enabled") {
    issue(context, ["adapterContract", "rolloutState"], "Receipt verification requires an enabled reviewed adapter.");
  }
});

export const ap2ReceiptAuthoritySchema = receiptAuthorityBodySchema.extend({
  authoritySha256: sha256Schema,
}).strict().superRefine((authority, context) => {
  const { authoritySha256, ...body } = authority;
  if (authoritySha256 !== canonicalJsonSha256(body)) {
    issue(context, ["authoritySha256"], "Receipt authority digest does not match.");
  }
});

const receiptCommon = {
  iss: opaqueIdSchema,
  iat: z.number().int().positive(),
  reference: base64UrlSchema,
};

export const ap2CheckoutReceiptPayloadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("Success"),
    ...receiptCommon,
    order_id: opaqueIdSchema,
  }).strict(),
  z.object({
    status: z.literal("Error"),
    ...receiptCommon,
    error: opaqueIdSchema,
    error_description: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

export const ap2PaymentReceiptPayloadSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("Success"),
    ...receiptCommon,
    payment_id: opaqueIdSchema,
    psp_confirmation_id: opaqueIdSchema,
    network_confirmation_id: opaqueIdSchema,
  }).strict(),
  z.object({
    status: z.literal("Error"),
    ...receiptCommon,
    payment_id: opaqueIdSchema,
    error: opaqueIdSchema,
    error_description: z.string().trim().min(1).max(2_000),
  }).strict(),
]);

const verifiedReceiptBodySchema = z.object({
  version: z.literal("p9.18-ap2-verified-receipt:1"),
  receiptId: uuidId("ap2_receipt"),
  kind: z.enum(["checkout", "payment"]),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  reviewId: uuidId("ap2_review"),
  grantId: uuidId("ap2_credential_grant"),
  authorityId: opaqueIdSchema,
  authoritySha256: sha256Schema,
  signingKeyId: opaqueIdSchema,
  jwtSha256: sha256Schema,
  mandateReference: base64UrlSchema,
  mandateContentSha256: sha256Schema,
  authorizationSha256: sha256Schema,
  status: z.enum(["Success", "Error"]),
  issuer: opaqueIdSchema,
  issuedAt: timestampSchema,
  orderId: opaqueIdSchema.nullable(),
  paymentId: opaqueIdSchema.nullable(),
  confirmationSha256: sha256Schema.nullable(),
  errorCode: opaqueIdSchema.nullable(),
  errorDescriptionSha256: sha256Schema.nullable(),
  verifiedAt: timestampSchema,
}).strict();

export const ap2VerifiedReceiptSchema = verifiedReceiptBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((receipt, context) => {
  const { receiptSha256, ...body } = receipt;
  if (receiptSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["receiptSha256"], "Verified receipt digest does not match.");
  }
  if (receipt.kind === "checkout" && receipt.paymentId !== null) {
    issue(context, ["paymentId"], "Checkout receipt cannot claim a payment ID.");
  }
  if (receipt.kind === "payment" && receipt.orderId !== null) {
    issue(context, ["orderId"], "Payment receipt cannot claim an order ID.");
  }
});

const lifecycleAmountSchema = z.object({
  state: z.string().trim().min(1).max(80),
  amountMinor: amountSchema.nullable(),
  currency: currencySchema.nullable(),
  providerEventId: opaqueIdSchema.nullable(),
  effectiveAt: timestampSchema.nullable(),
}).strict();

const reconciliationBodySchema = z.object({
  version: z.literal(AP2_RECONCILIATION_VERSION),
  observationId: uuidId("ap2_reconciliation"),
  authorityId: opaqueIdSchema,
  authorityRole: z.enum(["merchant", "merchant_payment_processor"]),
  transactionId: uuidId("ap2_payment"),
  reviewId: uuidId("ap2_review"),
  grantId: uuidId("ap2_credential_grant"),
  sequence: z.number().int().min(1),
  checkoutReference: base64UrlSchema,
  paymentReference: base64UrlSchema,
  merchantOrderId: opaqueIdSchema.nullable(),
  providerPaymentId: opaqueIdSchema.nullable(),
  amountMinor: amountSchema,
  currency: currencySchema,
  authorization: lifecycleAmountSchema.extend({
    state: z.enum(["unknown", "pending", "authorized", "declined", "canceled"]),
  }).strict(),
  capture: lifecycleAmountSchema.extend({
    state: z.enum(["unknown", "not_captured", "partial", "captured", "reversed"]),
  }).strict(),
  settlement: lifecycleAmountSchema.extend({
    state: z.enum(["unknown", "pending", "settled", "failed", "reversed"]),
  }).strict(),
  cancellation: lifecycleAmountSchema.extend({
    state: z.enum(["unknown", "none", "requested", "completed", "failed"]),
  }).strict(),
  refund: lifecycleAmountSchema.extend({
    state: z.enum(["unknown", "none", "partial", "full", "failed"]),
  }).strict(),
  dispute: z.object({
    state: z.enum(["unknown", "none", "open", "won", "lost"]),
    providerEventId: opaqueIdSchema.nullable(),
    effectiveAt: timestampSchema.nullable(),
  }).strict(),
  fulfillment: z.object({
    state: z.enum(["unknown", "unfulfilled", "processing", "fulfilled", "canceled", "returned"]),
    providerEventId: opaqueIdSchema.nullable(),
    effectiveAt: timestampSchema.nullable(),
  }).strict(),
  checkoutReceiptSha256: sha256Schema.nullable(),
  paymentReceiptSha256: sha256Schema.nullable(),
  observedAt: timestampSchema,
}).strict();

export const ap2SignedReconciliationObservationSchema =
  reconciliationBodySchema.extend({
    observationSha256: sha256Schema,
    signingKeyId: opaqueIdSchema,
    signatureAlgorithm: z.literal("ES256"),
    signature: base64UrlSchema,
  }).strict().superRefine((observation, context) => {
    const { observationSha256, signingKeyId: _keyId, signatureAlgorithm: _algorithm,
      signature: _signature, ...body } = observation;
    if (observationSha256 !== canonicalJsonSha256(body)) {
      issue(context, ["observationSha256"], "Reconciliation observation digest does not match.");
    }
  });

const paymentProjectionBodySchema = z.object({
  version: z.literal(AP2_RECEIPT_LEDGER_VERSION),
  transactionId: uuidId("ap2_payment"),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  reviewId: uuidId("ap2_review"),
  grantId: uuidId("ap2_credential_grant"),
  merchantSha256: sha256Schema,
  amountMinor: amountSchema,
  currency: currencySchema,
  checkoutReference: base64UrlSchema,
  paymentReference: base64UrlSchema,
  checkoutReceiptSha256: sha256Schema.nullable(),
  paymentReceiptSha256: sha256Schema.nullable(),
  latestMerchantObservationSha256: sha256Schema.nullable(),
  latestProcessorObservationSha256: sha256Schema.nullable(),
  checkoutState: z.enum(["awaiting_receipt", "accepted", "rejected"]),
  paymentState: z.enum(["awaiting_receipt", "accepted", "rejected"]),
  authorizationState: z.enum(["unknown", "pending", "authorized", "declined", "canceled"]),
  captureState: z.enum(["unknown", "not_captured", "partial", "captured", "reversed"]),
  settlementState: z.enum(["unknown", "pending", "settled", "failed", "reversed"]),
  cancellationState: z.enum(["unknown", "none", "requested", "completed", "failed"]),
  refundState: z.enum(["unknown", "none", "partial", "full", "failed"]),
  disputeState: z.enum(["unknown", "none", "open", "won", "lost"]),
  fulfillmentState: z.enum(["unknown", "unfulfilled", "processing", "fulfilled", "canceled", "returned"]),
  canonicalStatus: z.enum([
    "pending",
    "checkout_rejected",
    "payment_rejected",
    "authorized",
    "paid",
    "settled",
    "canceled",
    "partially_refunded",
    "refunded",
    "disputed",
    "fulfilled",
    "discrepancy",
  ]),
  paid: z.boolean(),
  discrepancyCodes: z.array(opaqueIdSchema).max(50),
  lifecycleRevision: z.number().int().min(1),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const ap2PaymentProjectionSchema = paymentProjectionBodySchema.extend({
  projectionSha256: sha256Schema,
}).strict().superRefine((projection, context) => {
  const { projectionSha256, ...body } = projection;
  if (projectionSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["projectionSha256"], "Payment projection digest does not match.");
  }
  if (projection.paid !== ["paid", "settled", "partially_refunded", "fulfilled"]
    .includes(projection.canonicalStatus)) {
    issue(context, ["paid"], "Paid flag does not match evidence-derived canonical status.");
  }
});

export type Ap2ReceiptAuthority = z.infer<typeof ap2ReceiptAuthoritySchema>;
export type Ap2VerifiedReceipt = z.infer<typeof ap2VerifiedReceiptSchema>;
export type Ap2SignedReconciliationObservation = z.infer<
  typeof ap2SignedReconciliationObservationSchema
>;
export type Ap2PaymentProjection = z.infer<typeof ap2PaymentProjectionSchema>;

export function buildAp2ReceiptAuthority(
  input: z.input<typeof receiptAuthorityBodySchema>,
) {
  const body = receiptAuthorityBodySchema.parse(input);
  return ap2ReceiptAuthoritySchema.parse({
    ...body,
    authoritySha256: canonicalJsonSha256(body),
  });
}

export function ap2MandateReceiptReference(input: {
  kind: "checkout" | "payment";
  review: Ap2HumanPresentReview;
  authorization: Ap2MandateAuthorization;
}) {
  const review = ap2HumanPresentReviewSchema.parse(input.review);
  const authorization = ap2MandateAuthorizationSchema.parse(input.authorization);
  if (
    authorization.reviewId !== review.reviewId ||
    authorization.authorizationDigest !== review.authorizationDigest
  ) {
    throw new Error("AP2 receipt reference requires the exact signed mandate bundle.");
  }
  const content = input.kind === "checkout"
    ? review.checkoutMandateContent
    : review.paymentMandateContent;
  return createHash("sha256").update(JSON.stringify({
    version: "p9.18-ap2-closed-mandate-reference:1",
    kind: input.kind,
    content,
    authorizationSha256: authorization.authorizationSha256,
    authorizationDigest: authorization.authorizationDigest,
  }), "utf8").digest("base64url");
}

export function verifyAp2ReceiptJwt(input: {
  jwt: string;
  kind: "checkout" | "payment";
  review: Ap2HumanPresentReview;
  authorization: Ap2MandateAuthorization;
  grant: Ap2CredentialGrant;
  authority: Ap2ReceiptAuthority;
  now?: Date;
}) {
  const authority = ap2ReceiptAuthoritySchema.parse(input.authority);
  const review = ap2HumanPresentReviewSchema.parse(input.review);
  const authorization = ap2MandateAuthorizationSchema.parse(input.authorization);
  const grant = ap2CredentialGrantSchema.parse(input.grant);
  const now = input.now || new Date();
  if (
    review.reviewId !== grant.reviewId ||
    authorization.authorizationId !== grant.authorizationId ||
    grant.tenantId !== review.tenantId ||
    grant.ownerActorId !== review.ownerActorId
  ) {
    throw new Error("AP2 receipt belongs to a different transaction boundary.");
  }
  if (
    (input.kind === "checkout" && authority.role !== "merchant") ||
    (input.kind === "payment" && authority.role !== "merchant_payment_processor")
  ) {
    throw new Error("AP2 receipt was issued by the wrong protocol role.");
  }
  const compact = parseCompactJwt(input.jwt);
  if (
    compact.header.alg !== "ES256" ||
    compact.header.typ !== "JWT" ||
    compact.header.kid !== authority.signingKey.keyId ||
    Object.keys(compact.header).length !== 3
  ) {
    throw new Error("AP2 receipt JWT header is not accepted.");
  }
  const key = requireLiveReceiptKey(authority, now);
  if (!verifySignature(
    "sha256",
    Buffer.from(compact.signingInput, "utf8"),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(compact.signature, "base64url"),
  )) {
    throw new Error("AP2 receipt JWT signature is invalid.");
  }
  const payload = input.kind === "checkout"
    ? ap2CheckoutReceiptPayloadSchema.parse(compact.payload)
    : ap2PaymentReceiptPayloadSchema.parse(compact.payload);
  const expectedReference = ap2MandateReceiptReference({
    kind: input.kind,
    review,
    authorization,
  });
  if (payload.iss !== authority.issuer || payload.reference !== expectedReference) {
    throw new Error("AP2 receipt issuer or closed-mandate reference does not match.");
  }
  const issuedAtMs = payload.iat * 1_000;
  if (
    issuedAtMs > now.getTime() + authority.maximumClockSkewSeconds * 1_000 ||
    issuedAtMs < Date.parse(authorization.verifiedAt) - authority.maximumClockSkewSeconds * 1_000
  ) {
    throw new Error("AP2 receipt issuance time is outside the accepted transaction interval.");
  }
  const normalized = normalizeReceiptPayload(input.kind, payload);
  const body = verifiedReceiptBodySchema.parse({
    version: "p9.18-ap2-verified-receipt:1",
    receiptId: `ap2_receipt:${deterministicUuid(`${input.kind}\0${sha256Text(input.jwt)}`)}`,
    kind: input.kind,
    tenantId: review.tenantId,
    ownerActorId: review.ownerActorId,
    reviewId: review.reviewId,
    grantId: grant.grantId,
    authorityId: authority.authorityId,
    authoritySha256: authority.authoritySha256,
    signingKeyId: authority.signingKey.keyId,
    jwtSha256: sha256Text(input.jwt),
    mandateReference: expectedReference,
    mandateContentSha256: canonicalJsonSha256(
      input.kind === "checkout"
        ? review.checkoutMandateContent
        : review.paymentMandateContent,
    ),
    authorizationSha256: authorization.authorizationSha256,
    status: payload.status,
    issuer: payload.iss,
    issuedAt: new Date(issuedAtMs).toISOString(),
    ...normalized,
    verifiedAt: now.toISOString(),
  });
  return ap2VerifiedReceiptSchema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  });
}

export function verifyAp2ReconciliationObservation(input: {
  observation: Ap2SignedReconciliationObservation;
  authority: Ap2ReceiptAuthority;
  transaction: Pick<Ap2PaymentProjection,
    "transactionId" | "reviewId" | "grantId" | "checkoutReference" |
    "paymentReference" | "amountMinor" | "currency">;
  now?: Date;
}) {
  const observation = ap2SignedReconciliationObservationSchema.parse(input.observation);
  const authority = ap2ReceiptAuthoritySchema.parse(input.authority);
  const now = input.now || new Date();
  const expected = input.transaction;
  if (
    observation.authorityId !== authority.authorityId ||
    observation.authorityRole !== authority.role ||
    observation.signingKeyId !== authority.signingKey.keyId ||
    observation.transactionId !== expected.transactionId ||
    observation.reviewId !== expected.reviewId ||
    observation.grantId !== expected.grantId ||
    observation.checkoutReference !== expected.checkoutReference ||
    observation.paymentReference !== expected.paymentReference ||
    observation.amountMinor !== expected.amountMinor ||
    observation.currency !== expected.currency
  ) {
    throw new Error("AP2 reconciliation observation does not match the exact transaction.");
  }
  const key = requireLiveReceiptKey(authority, now);
  if (!verifySignature(
    "sha256",
    reconciliationSigningPayload(observation),
    key,
    Buffer.from(observation.signature, "base64url"),
  )) {
    throw new Error("AP2 reconciliation observation signature is invalid.");
  }
  if (Date.parse(observation.observedAt) > now.getTime() + authority.maximumClockSkewSeconds * 1_000) {
    throw new Error("AP2 reconciliation observation is from the future.");
  }
  return observation;
}

export function reconciliationSigningPayload(
  input: Ap2SignedReconciliationObservation,
) {
  const observation = ap2SignedReconciliationObservationSchema.parse(input);
  const { signingKeyId: _keyId, signatureAlgorithm: _algorithm,
    signature: _signature, ...signed } = observation;
  return Buffer.from(JSON.stringify(signed), "utf8");
}

export function createInitialAp2PaymentProjection(input: {
  review: Ap2HumanPresentReview;
  authorization: Ap2MandateAuthorization;
  grant: Ap2CredentialGrant;
  now?: Date;
}) {
  const review = ap2HumanPresentReviewSchema.parse(input.review);
  const authorization = ap2MandateAuthorizationSchema.parse(input.authorization);
  const grant = ap2CredentialGrantSchema.parse(input.grant);
  if (
    grant.reviewId !== review.reviewId ||
    grant.authorizationId !== authorization.authorizationId
  ) {
    throw new Error("AP2 payment projection requires the exact mandate and grant.");
  }
  const now = (input.now || new Date()).toISOString();
  const body = paymentProjectionBodySchema.parse({
    version: AP2_RECEIPT_LEDGER_VERSION,
    transactionId: `ap2_payment:${deterministicUuid(`${grant.grantId}\0payment`)}`,
    tenantId: review.tenantId,
    ownerActorId: review.ownerActorId,
    reviewId: review.reviewId,
    grantId: grant.grantId,
    merchantSha256: canonicalJsonSha256(review.terms.merchant),
    amountMinor: review.terms.totals.totalAmountMinor,
    currency: review.terms.totals.currency,
    checkoutReference: ap2MandateReceiptReference({ kind: "checkout", review, authorization }),
    paymentReference: ap2MandateReceiptReference({ kind: "payment", review, authorization }),
    checkoutReceiptSha256: null,
    paymentReceiptSha256: null,
    latestMerchantObservationSha256: null,
    latestProcessorObservationSha256: null,
    checkoutState: "awaiting_receipt",
    paymentState: "awaiting_receipt",
    authorizationState: "unknown",
    captureState: "unknown",
    settlementState: "unknown",
    cancellationState: "unknown",
    refundState: "unknown",
    disputeState: "unknown",
    fulfillmentState: "unknown",
    canonicalStatus: "pending",
    paid: false,
    discrepancyCodes: [],
    lifecycleRevision: 1,
    createdAt: now,
    updatedAt: now,
  });
  return withProjectionDigest(body);
}

export function reconcileAp2PaymentProjection(input: {
  stored: Ap2PaymentProjection;
  checkoutReceipt?: Ap2VerifiedReceipt;
  paymentReceipt?: Ap2VerifiedReceipt;
  merchantObservation?: Ap2SignedReconciliationObservation;
  processorObservation?: Ap2SignedReconciliationObservation;
  now?: Date;
}) {
  const stored = ap2PaymentProjectionSchema.parse(input.stored);
  const checkoutReceipt = input.checkoutReceipt
    ? ap2VerifiedReceiptSchema.parse(input.checkoutReceipt)
    : undefined;
  const paymentReceipt = input.paymentReceipt
    ? ap2VerifiedReceiptSchema.parse(input.paymentReceipt)
    : undefined;
  const merchant = input.merchantObservation
    ? ap2SignedReconciliationObservationSchema.parse(input.merchantObservation)
    : undefined;
  const processor = input.processorObservation
    ? ap2SignedReconciliationObservationSchema.parse(input.processorObservation)
    : undefined;
  assertProjectionEvidenceOwnership(stored, checkoutReceipt, paymentReceipt, merchant, processor);

  const discrepancies = new Set<string>();
  validateObservationAmounts(stored, merchant, discrepancies);
  validateObservationAmounts(stored, processor, discrepancies);
  if (
    checkoutReceipt?.status === "Success" && merchant?.merchantOrderId &&
    checkoutReceipt.orderId !== merchant.merchantOrderId
  ) discrepancies.add("checkout_order_id_mismatch");
  if (
    paymentReceipt?.status === "Success" && processor?.providerPaymentId &&
    paymentReceipt.paymentId !== processor.providerPaymentId
  ) discrepancies.add("provider_payment_id_mismatch");
  if (paymentReceipt?.status === "Error" && processor?.authorization.state === "authorized") {
    discrepancies.add("payment_receipt_rejected_but_provider_authorized");
  }
  if (paymentReceipt?.status === "Success" && processor?.authorization.state === "declined") {
    discrepancies.add("payment_receipt_accepted_but_provider_declined");
  }
  if (checkoutReceipt?.status === "Error" && merchant?.fulfillment.state === "fulfilled") {
    discrepancies.add("rejected_checkout_fulfilled");
  }

  const states = processor || merchant;
  const checkoutState = checkoutReceipt
    ? checkoutReceipt.status === "Success" ? "accepted" : "rejected"
    : stored.checkoutState;
  const paymentState = paymentReceipt
    ? paymentReceipt.status === "Success" ? "accepted" : "rejected"
    : stored.paymentState;
  const { projectionSha256: _storedDigest, ...storedBody } = stored;
  const next = {
    ...storedBody,
    checkoutReceiptSha256: checkoutReceipt?.receiptSha256 || stored.checkoutReceiptSha256,
    paymentReceiptSha256: paymentReceipt?.receiptSha256 || stored.paymentReceiptSha256,
    latestMerchantObservationSha256:
      merchant?.observationSha256 || stored.latestMerchantObservationSha256,
    latestProcessorObservationSha256:
      processor?.observationSha256 || stored.latestProcessorObservationSha256,
    checkoutState,
    paymentState,
    authorizationState: states?.authorization.state || stored.authorizationState,
    captureState: states?.capture.state || stored.captureState,
    settlementState: states?.settlement.state || stored.settlementState,
    cancellationState: states?.cancellation.state || stored.cancellationState,
    refundState: states?.refund.state || stored.refundState,
    disputeState: states?.dispute.state || stored.disputeState,
    fulfillmentState: merchant?.fulfillment.state || states?.fulfillment.state || stored.fulfillmentState,
    discrepancyCodes: [...discrepancies].sort(),
    lifecycleRevision: stored.lifecycleRevision + 1,
    updatedAt: (input.now || new Date()).toISOString(),
  };
  const canonicalStatus = deriveCanonicalStatus(next);
  const body = paymentProjectionBodySchema.parse({
    ...next,
    canonicalStatus,
    paid: ["paid", "settled", "partially_refunded", "fulfilled"].includes(canonicalStatus),
  });
  return withProjectionDigest(body);
}

function deriveCanonicalStatus(value: z.input<typeof paymentProjectionBodySchema>) {
  if (value.discrepancyCodes.length) return "discrepancy" as const;
  if (value.checkoutState === "rejected") return "checkout_rejected" as const;
  if (value.paymentState === "rejected") return "payment_rejected" as const;
  if (value.cancellationState === "completed" || value.authorizationState === "canceled") {
    return "canceled" as const;
  }
  if (value.disputeState === "open") return "disputed" as const;
  if (value.refundState === "full") return "refunded" as const;
  const paidEvidence = value.checkoutState === "accepted" &&
    value.paymentState === "accepted" &&
    value.authorizationState === "authorized" &&
    value.captureState === "captured" &&
    Boolean(value.latestProcessorObservationSha256);
  if (!paidEvidence) {
    return value.authorizationState === "authorized" ? "authorized" as const : "pending" as const;
  }
  if (value.refundState === "partial") return "partially_refunded" as const;
  if (value.fulfillmentState === "fulfilled") return "fulfilled" as const;
  if (value.settlementState === "settled") return "settled" as const;
  return "paid" as const;
}

function validateObservationAmounts(
  stored: Ap2PaymentProjection,
  observation: Ap2SignedReconciliationObservation | undefined,
  discrepancies: Set<string>,
) {
  if (!observation) return;
  if (observation.amountMinor !== stored.amountMinor || observation.currency !== stored.currency) {
    discrepancies.add("transaction_amount_or_currency_mismatch");
  }
  for (const [name, state] of [
    ["authorization", observation.authorization],
    ["capture", observation.capture],
    ["settlement", observation.settlement],
    ["refund", observation.refund],
  ] as const) {
    if (
      state.amountMinor !== null &&
      (state.amountMinor > stored.amountMinor || state.currency !== stored.currency)
    ) discrepancies.add(`${name}_amount_or_currency_mismatch`);
  }
}

function assertProjectionEvidenceOwnership(
  stored: Ap2PaymentProjection,
  ...evidence: Array<Ap2VerifiedReceipt | Ap2SignedReconciliationObservation | undefined>
) {
  for (const item of evidence) {
    if (!item) continue;
    if (item.reviewId !== stored.reviewId || item.grantId !== stored.grantId) {
      throw new Error("AP2 receipt or reconciliation evidence belongs to a different payment.");
    }
    if ("transactionId" in item && item.transactionId !== stored.transactionId) {
      throw new Error("AP2 reconciliation evidence belongs to a different transaction.");
    }
    if ("kind" in item && item.mandateReference !==
      (item.kind === "checkout" ? stored.checkoutReference : stored.paymentReference)) {
      throw new Error("AP2 receipt references a different closed mandate.");
    }
  }
}

function normalizeReceiptPayload(
  kind: "checkout" | "payment",
  payload: z.infer<typeof ap2CheckoutReceiptPayloadSchema> |
    z.infer<typeof ap2PaymentReceiptPayloadSchema>,
) {
  if (kind === "checkout") {
    const receipt = ap2CheckoutReceiptPayloadSchema.parse(payload);
    return receipt.status === "Success"
      ? {
          orderId: receipt.order_id,
          paymentId: null,
          confirmationSha256: null,
          errorCode: null,
          errorDescriptionSha256: null,
        }
      : {
          orderId: null,
          paymentId: null,
          confirmationSha256: null,
          errorCode: receipt.error,
          errorDescriptionSha256: sha256Text(receipt.error_description),
        };
  }
  const receipt = ap2PaymentReceiptPayloadSchema.parse(payload);
  return receipt.status === "Success"
    ? {
        orderId: null,
        paymentId: receipt.payment_id,
        confirmationSha256: canonicalJsonSha256({
          psp: receipt.psp_confirmation_id,
          network: receipt.network_confirmation_id,
        }),
        errorCode: null,
        errorDescriptionSha256: null,
      }
    : {
        orderId: null,
        paymentId: receipt.payment_id,
        confirmationSha256: null,
        errorCode: receipt.error,
        errorDescriptionSha256: sha256Text(receipt.error_description),
      };
}

function parseCompactJwt(jwt: string) {
  const normalized = jwt.trim();
  if (!normalized || normalized.length > 300_000) throw new Error("AP2 receipt JWT is invalid.");
  const parts = normalized.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error("AP2 receipt JWT is invalid.");
  }
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as Record<string, unknown>;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
    if (!header || typeof header !== "object" || Array.isArray(header)) throw new Error();
    return {
      header,
      payload,
      signature: parts[2],
      signingInput: `${parts[0]}.${parts[1]}`,
    };
  } catch {
    throw new Error("AP2 receipt JWT encoding is invalid.");
  }
}

function requireLiveReceiptKey(authority: Ap2ReceiptAuthority, now: Date) {
  const key = authority.signingKey;
  if (
    key.revocation.status !== "active" ||
    Date.parse(key.validFrom) > now.getTime() ||
    Date.parse(key.validUntil) <= now.getTime()
  ) throw new Error("AP2 receipt verification key is not currently trusted.");
  return createPublicKey({
    key: Buffer.from(key.spkiDerBase64url, "base64url"),
    format: "der",
    type: "spki",
  });
}

function withProjectionDigest(bodyInput: z.input<typeof paymentProjectionBodySchema>) {
  const body = paymentProjectionBodySchema.parse(bodyInput);
  return ap2PaymentProjectionSchema.parse({
    ...body,
    projectionSha256: canonicalJsonSha256(body),
  });
}

function deterministicUuid(value: string) {
  const hex = sha256Text(value).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function decodedLength(value: string) {
  return Buffer.from(value, "base64url").length;
}

function sha256Text(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sha256Bytes(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function issue(context: z.RefinementCtx, path: PropertyKey[], message: string) {
  context.addIssue({ code: "custom", path, message });
}

export type { Ap2AdapterContract };
