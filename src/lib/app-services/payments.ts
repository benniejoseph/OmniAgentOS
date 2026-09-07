import { z } from "zod";

import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { loadAp2Readiness } from "@/lib/payments/ap2-readiness";
import { ap2HumanPresentTermsSchema } from "@/lib/payments/ap2-mandates";
import {
  createAp2HumanPresentReview,
  listAp2HumanPresentReviews,
  requireConfiguredMerchantCheckoutVerifier,
} from "@/lib/payments/ap2-store";

const emptySchema = z.object({}).strict();

export async function showAp2ReadinessService(
  caller: AppServiceCaller,
  input: z.input<typeof emptySchema>,
) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.payments.ap2.readiness"),
  );
  return completeAppServiceCall(
    authorized,
    { readiness: loadAp2Readiness() },
    { resourceCount: 1 },
  );
}

export async function listAp2MandateReviewsService(
  caller: AppServiceCaller,
  input: z.input<typeof emptySchema>,
) {
  emptySchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.payments.ap2.mandates.list"),
  );
  const reviews = await listAp2HumanPresentReviews({
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
  });
  const mandates = reviews.map((review) => ({
    reviewId: review.reviewId,
    merchant: review.terms.merchant,
    total: review.paymentMandateContent.payment_amount,
    itemCount: review.terms.items.length,
    state: review.state,
    expiresAt: review.terms.expiresAt,
    intentSha256: review.intentSha256,
    exactTermsSha256: review.exactTermsSha256,
    authorizationDigest: review.authorizationDigest,
  }));
  return completeAppServiceCall(
    authorized,
    { mandates },
    { resourceCount: mandates.length },
  );
}

const prepareMandateSchema = z.object({
  shoppingAgentPrincipalId: z.string().trim().min(1).max(240),
  intentSha256: z.string().regex(/^[a-f0-9]{64}$/),
  merchantCheckoutJwt: z.string().trim().min(1).max(200_000),
  terms: ap2HumanPresentTermsSchema,
}).strict();

export async function prepareAp2MandateReviewService(
  caller: AppServiceCaller,
  input: z.input<typeof prepareMandateSchema>,
) {
  const parsed = prepareMandateSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.payments.ap2.mandates.prepare"),
  );
  if (!caller.executionScope || !caller.idempotencyKey) {
    throw new Error("AP2 mandate preparation requires exact mutation authority.");
  }
  const result = await createAp2HumanPresentReview({
    ...parsed,
    idempotencyKey: caller.idempotencyKey,
  }, {
    tenantId: caller.context.tenantId,
    actorId: caller.context.actorId,
    executionScope: caller.executionScope,
  }, requireConfiguredMerchantCheckoutVerifier);
  return completeAppServiceCall(
    authorized,
    {
      reviewId: result.review.reviewId,
      state: result.review.state,
      exactTermsSha256: result.review.exactTermsSha256,
      authorizationDigest: result.review.authorizationDigest,
      expiresAt: result.review.terms.expiresAt,
      trustedSurfacePath: `/app/payments?review=${encodeURIComponent(result.review.reviewId)}`,
      created: result.created,
      transactionPermitted: false,
    },
    { resourceCount: 1 },
  );
}
