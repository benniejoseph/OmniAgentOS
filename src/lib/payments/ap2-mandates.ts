import { createHash } from "node:crypto";
import { z } from "zod";

import {
  AP2_MANDATE_VCT,
  AP2_PROTOCOL_COMMIT,
  AP2_PROTOCOL_RELEASE,
} from "@/lib/payments/ap2-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const AP2_HUMAN_PRESENT_VERSION =
  "p9.16-ap2-human-present:1" as const;
export const AP2_DIRECT_SIGNER_PROFILE =
  "direct_hardware_webauthn_key:1" as const;

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const base64UrlSchema = z.string().regex(/^[A-Za-z0-9_-]+$/).max(16_384);
const opaqueIdSchema = z.string().trim().min(1).max(240);
const timestampSchema = z.string().datetime({ offset: true });
const currencySchema = z.string().regex(/^[A-Z]{3}$/);
const countrySchema = z.string().regex(/^[A-Z]{2}$/);
const minorAmountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const AP2_HUMAN_PRESENT_IMPLEMENTATION_MANIFEST = Object.freeze({
  version: AP2_HUMAN_PRESENT_VERSION,
  protocolRelease: AP2_PROTOCOL_RELEASE,
  reviewedCommit: AP2_PROTOCOL_COMMIT,
  normativeDocuments: Object.freeze([
    "docs/ap2/specification.md",
    "docs/ap2/checkout_mandate.md",
    "docs/ap2/payment_mandate.md",
    "docs/ap2/agent_authorization.md",
    "code/sdk/schemas/ap2/checkout_mandate.json",
    "code/sdk/schemas/ap2/payment_mandate.json",
    "code/sdk/schemas/ap2/types/amount.json",
    "code/sdk/schemas/ap2/types/merchant.json",
    "code/sdk/schemas/ap2/types/payment_instrument.json",
  ]),
} as const);

export const ap2MerchantSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().trim().min(1).max(240),
  website: z.string().url().refine((value) => value.startsWith("https://"), {
    message: "Merchant website must use HTTPS.",
  }),
}).strict();

export const ap2PaymentInstrumentSummarySchema = z.object({
  id: opaqueIdSchema,
  type: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(240),
}).strict();

export const ap2CheckoutItemSchema = z.object({
  id: opaqueIdSchema,
  title: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(10_000),
  unitAmountMinor: minorAmountSchema,
  totalAmountMinor: minorAmountSchema,
}).strict().superRefine((item, context) => {
  if (item.totalAmountMinor !== item.unitAmountMinor * item.quantity) {
    issue(context, ["totalAmountMinor"], "Item total must equal unit amount times quantity.");
  }
});

export const ap2CheckoutTotalsSchema = z.object({
  currency: currencySchema,
  subtotalAmountMinor: minorAmountSchema,
  taxAmountMinor: minorAmountSchema,
  shippingAmountMinor: minorAmountSchema,
  discountAmountMinor: minorAmountSchema,
  totalAmountMinor: minorAmountSchema,
}).strict().superRefine((totals, context) => {
  const expected = totals.subtotalAmountMinor + totals.taxAmountMinor +
    totals.shippingAmountMinor - totals.discountAmountMinor;
  if (expected < 0 || totals.totalAmountMinor !== expected) {
    issue(context, ["totalAmountMinor"], "Checkout total arithmetic does not balance.");
  }
});

export const ap2ShippingTermsSchema = z.object({
  recipientName: z.string().trim().min(1).max(240),
  addressLines: z.array(z.string().trim().min(1).max(240)).min(1).max(4),
  city: z.string().trim().min(1).max(160),
  region: z.string().trim().min(1).max(160),
  postalCode: z.string().trim().min(1).max(40),
  country: countrySchema,
  serviceLevel: z.string().trim().min(1).max(160),
}).strict();

export const ap2PaymentConstraintsSchema = z.object({
  credentialProviderId: opaqueIdSchema,
  merchantPaymentProcessorId: opaqueIdSchema,
  allowedInstrumentTypes: z.array(z.string().trim().min(1).max(80))
    .min(1).max(20),
  maximumAmountMinor: minorAmountSchema,
  currency: currencySchema,
  immediateExecutionOnly: z.literal(true),
}).strict();

export const ap2HumanPresentTermsSchema = z.object({
  merchant: ap2MerchantSchema,
  merchantOrderId: opaqueIdSchema,
  items: z.array(ap2CheckoutItemSchema).min(1).max(500),
  totals: ap2CheckoutTotalsSchema,
  shipping: ap2ShippingTermsSchema,
  paymentInstrument: ap2PaymentInstrumentSummarySchema,
  paymentConstraints: ap2PaymentConstraintsSchema,
  expiresAt: timestampSchema,
}).strict().superRefine((terms, context) => {
  const subtotal = terms.items.reduce(
    (sum, item) => sum + item.totalAmountMinor,
    0,
  );
  if (subtotal !== terms.totals.subtotalAmountMinor) {
    issue(context, ["totals", "subtotalAmountMinor"], "Item totals do not match checkout subtotal.");
  }
  if (terms.paymentConstraints.currency !== terms.totals.currency) {
    issue(context, ["paymentConstraints", "currency"], "Payment constraint currency must match checkout currency.");
  }
  if (terms.paymentConstraints.maximumAmountMinor !== terms.totals.totalAmountMinor) {
    issue(context, ["paymentConstraints", "maximumAmountMinor"], "Human-present payment limit must equal the exact checkout total.");
  }
  if (!terms.paymentConstraints.allowedInstrumentTypes.includes(terms.paymentInstrument.type)) {
    issue(context, ["paymentInstrument", "type"], "Selected instrument type is outside the reviewed payment constraints.");
  }
});

export const merchantCheckoutVerificationSchema = z.object({
  version: z.literal("p9.16-merchant-checkout-verification:1"),
  adapterContractId: opaqueIdSchema,
  adapterRelease: opaqueIdSchema,
  adapterArtifactSha256: sha256Schema,
  merchantKeyId: opaqueIdSchema,
  checkoutJwtSha256: sha256Schema,
  verifiedTermsSha256: sha256Schema,
  verifiedAt: timestampSchema,
  verificationSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { verificationSha256, ...body } = value;
  if (verificationSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["verificationSha256"], "Merchant checkout verification digest does not match.");
  }
});

export const ap2CheckoutMandateContentSchema = z.object({
  vct: z.literal(AP2_MANDATE_VCT.checkoutClosed),
  checkout_jwt: z.string().trim().min(1).max(200_000),
  checkout_hash: base64UrlSchema,
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

export const ap2PaymentMandateContentSchema = z.object({
  vct: z.literal(AP2_MANDATE_VCT.paymentClosed),
  transaction_id: base64UrlSchema,
  payee: ap2MerchantSchema,
  payment_amount: z.object({
    amount: minorAmountSchema,
    currency: currencySchema,
  }).strict(),
  payment_instrument: ap2PaymentInstrumentSummarySchema,
  execution_date: timestampSchema,
  risk_data: z.object({
    asael_human_present_version: z.literal(AP2_HUMAN_PRESENT_VERSION),
    owner_actor_sha256: sha256Schema,
    shopping_agent_sha256: sha256Schema,
    intent_sha256: sha256Schema,
    exact_terms_sha256: sha256Schema,
  }).strict(),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
}).strict();

export const ap2MandateOutcomeContractSchema = z.object({
  version: z.literal("p9.16-mandate-outcome-contract:1"),
  expectedTerminalState: z.literal("signed_mandates_verified"),
  externalEffectLimit: z.literal("no_checkout_or_payment_effect"),
  acceptanceConditions: z.tuple([
    z.literal("displayed_terms_digest_matches"),
    z.literal("merchant_checkout_signature_verified"),
    z.literal("hardware_user_assertion_verified"),
    z.literal("checkout_mandate_content_matches"),
    z.literal("payment_mandate_content_matches"),
    z.literal("mandate_not_expired_or_superseded"),
  ]),
  contractSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { contractSha256, ...body } = value;
  if (contractSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["contractSha256"], "Mandate outcome contract digest does not match.");
  }
});

const reviewBodySchema = z.object({
  version: z.literal(AP2_HUMAN_PRESENT_VERSION),
  reviewId: z.string().regex(/^ap2_review:[0-9a-f-]{36}$/),
  tenantId: opaqueIdSchema,
  ownerActorId: opaqueIdSchema,
  shoppingAgentPrincipalId: opaqueIdSchema,
  intentSha256: sha256Schema,
  merchantCheckoutJwt: z.string().trim().min(1).max(200_000),
  merchantCheckoutVerification: merchantCheckoutVerificationSchema,
  terms: ap2HumanPresentTermsSchema,
  exactTermsSha256: sha256Schema,
  checkoutMandateContent: ap2CheckoutMandateContentSchema,
  paymentMandateContent: ap2PaymentMandateContentSchema,
  outcomeContract: ap2MandateOutcomeContractSchema,
  trustedSurface: z.object({
    surface: z.literal("asael_web"),
    processingMode: z.literal("deterministic_non_agentic"),
    signerProfile: z.literal(AP2_DIRECT_SIGNER_PROFILE),
    displaysEveryBoundField: z.literal(true),
  }).strict(),
  state: z.enum(["pending", "authorized", "expired", "superseded"]),
  lifecycleRevision: z.number().int().min(1),
  authorizedAt: timestampSchema.nullable(),
  supersededAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict();

export const ap2HumanPresentReviewSchema = reviewBodySchema.extend({
  authorizationDigest: sha256Schema,
  reviewSha256: sha256Schema,
}).strict().superRefine((review, context) => {
  const expectedTermsSha256 = canonicalJsonSha256(review.terms);
  if (review.exactTermsSha256 !== expectedTermsSha256) {
    issue(context, ["exactTermsSha256"], "Displayed terms digest does not match the exact terms.");
  }
  if (review.merchantCheckoutVerification.checkoutJwtSha256 !== sha256(review.merchantCheckoutJwt)) {
    issue(context, ["merchantCheckoutVerification", "checkoutJwtSha256"], "Merchant verification belongs to a different checkout JWT.");
  }
  if (review.merchantCheckoutVerification.verifiedTermsSha256 !== expectedTermsSha256) {
    issue(context, ["merchantCheckoutVerification", "verifiedTermsSha256"], "Merchant checkout verification belongs to different displayed terms.");
  }
  if (review.checkoutMandateContent.checkout_jwt !== review.merchantCheckoutJwt) {
    issue(context, ["checkoutMandateContent", "checkout_jwt"], "Checkout Mandate does not contain the verified merchant checkout JWT.");
  }
  const checkoutHash = sha256Base64Url(review.merchantCheckoutJwt);
  if (
    review.checkoutMandateContent.checkout_hash !== checkoutHash ||
    review.paymentMandateContent.transaction_id !== checkoutHash
  ) {
    issue(context, ["checkoutMandateContent", "checkout_hash"], "Checkout and Payment Mandates do not share the exact checkout binding.");
  }
  const expectedAuthorizationDigest = authorizationDigest(review);
  if (review.authorizationDigest !== expectedAuthorizationDigest) {
    issue(context, ["authorizationDigest"], "User authorization digest does not match the displayed mandate bundle.");
  }
  const { reviewSha256, ...body } = review;
  if (reviewSha256 !== canonicalJsonSha256(body)) {
    issue(context, ["reviewSha256"], "Mandate review digest does not match its body.");
  }
});

export type Ap2HumanPresentTerms = z.infer<typeof ap2HumanPresentTermsSchema>;
export type MerchantCheckoutVerification = z.infer<typeof merchantCheckoutVerificationSchema>;
export type Ap2HumanPresentReview = z.infer<typeof ap2HumanPresentReviewSchema>;

export function buildAp2HumanPresentReview(input: {
  reviewId: string;
  tenantId: string;
  ownerActorId: string;
  shoppingAgentPrincipalId: string;
  intentSha256: string;
  merchantCheckoutJwt: string;
  merchantCheckoutVerification: MerchantCheckoutVerification;
  terms: Ap2HumanPresentTerms;
  now?: Date;
}): Ap2HumanPresentReview {
  const now = input.now || new Date();
  const terms = ap2HumanPresentTermsSchema.parse(input.terms);
  const expiresAt = Date.parse(terms.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw new Error("The reviewed checkout must expire in the future.");
  }
  const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
  const expiresAtSeconds = Math.floor(expiresAt / 1_000);
  const exactTermsSha256 = canonicalJsonSha256(terms);
  const checkoutHash = sha256Base64Url(input.merchantCheckoutJwt);
  const outcomeBody = {
    version: "p9.16-mandate-outcome-contract:1" as const,
    expectedTerminalState: "signed_mandates_verified" as const,
    externalEffectLimit: "no_checkout_or_payment_effect" as const,
    acceptanceConditions: [
      "displayed_terms_digest_matches",
      "merchant_checkout_signature_verified",
      "hardware_user_assertion_verified",
      "checkout_mandate_content_matches",
      "payment_mandate_content_matches",
      "mandate_not_expired_or_superseded",
    ] as const,
  };
  const outcomeContract = ap2MandateOutcomeContractSchema.parse({
    ...outcomeBody,
    contractSha256: canonicalJsonSha256(outcomeBody),
  });
  const createdAt = now.toISOString();
  const body = reviewBodySchema.parse({
    version: AP2_HUMAN_PRESENT_VERSION,
    reviewId: input.reviewId,
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    shoppingAgentPrincipalId: input.shoppingAgentPrincipalId,
    intentSha256: input.intentSha256,
    merchantCheckoutJwt: input.merchantCheckoutJwt,
    merchantCheckoutVerification: input.merchantCheckoutVerification,
    terms,
    exactTermsSha256,
    checkoutMandateContent: {
      vct: AP2_MANDATE_VCT.checkoutClosed,
      checkout_jwt: input.merchantCheckoutJwt,
      checkout_hash: checkoutHash,
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
    },
    paymentMandateContent: {
      vct: AP2_MANDATE_VCT.paymentClosed,
      transaction_id: checkoutHash,
      payee: terms.merchant,
      payment_amount: {
        amount: terms.totals.totalAmountMinor,
        currency: terms.totals.currency,
      },
      payment_instrument: terms.paymentInstrument,
      execution_date: createdAt,
      risk_data: {
        asael_human_present_version: AP2_HUMAN_PRESENT_VERSION,
        owner_actor_sha256: sha256(input.ownerActorId),
        shopping_agent_sha256: sha256(input.shoppingAgentPrincipalId),
        intent_sha256: input.intentSha256,
        exact_terms_sha256: exactTermsSha256,
      },
      iat: issuedAtSeconds,
      exp: expiresAtSeconds,
    },
    outcomeContract,
    trustedSurface: {
      surface: "asael_web",
      processingMode: "deterministic_non_agentic",
      signerProfile: AP2_DIRECT_SIGNER_PROFILE,
      displaysEveryBoundField: true,
    },
    state: "pending",
    lifecycleRevision: 1,
    authorizedAt: null,
    supersededAt: null,
    createdAt,
    updatedAt: createdAt,
  });
  const withAuthorizationDigest = {
    ...body,
    authorizationDigest: authorizationDigest(body),
  };
  return ap2HumanPresentReviewSchema.parse({
    ...withAuthorizationDigest,
    reviewSha256: canonicalJsonSha256(withAuthorizationDigest),
  });
}

export function ap2AuthorizationChallenge(review: Ap2HumanPresentReview) {
  const parsed = ap2HumanPresentReviewSchema.parse(review);
  return Buffer.from(
    createHash("sha256").update(canonicalJsonSha256({
      domain: "asael:ap2:human-present:authorize:v1",
      reviewId: parsed.reviewId,
      authorizationDigest: parsed.authorizationDigest,
    }), "hex").digest(),
  ).toString("base64url");
}

export function sha256Base64Url(value: string) {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

function authorizationDigest(review: z.infer<typeof reviewBodySchema>) {
  return canonicalJsonSha256({
    version: review.version,
    reviewId: review.reviewId,
    tenantId: review.tenantId,
    ownerActorId: review.ownerActorId,
    shoppingAgentPrincipalId: review.shoppingAgentPrincipalId,
    intentSha256: review.intentSha256,
    exactTermsSha256: review.exactTermsSha256,
    merchantCheckoutVerificationSha256:
      review.merchantCheckoutVerification.verificationSha256,
    checkoutMandateContent: review.checkoutMandateContent,
    paymentMandateContent: review.paymentMandateContent,
    outcomeContractSha256: review.outcomeContract.contractSha256,
    trustedSurface: review.trustedSurface,
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function issue(
  context: z.RefinementCtx,
  path: PropertyKey[],
  message: string,
) {
  context.addIssue({ code: "custom", path, message });
}
