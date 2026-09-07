import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { z } from "zod";

import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { ap2ErrorResponse, ap2PrivateHeaders } from "@/lib/payments/ap2-http";
import {
  authorizeAp2HumanPresentReview,
  Ap2HumanPresentStoreError,
  getAp2HumanPresentReview,
  listAp2PaymentSigningCredentials,
} from "@/lib/payments/ap2-store";
import {
  beginAp2MandateAuthorization,
  loadAp2WebAuthnTrustPolicy,
} from "@/lib/payments/ap2-webauthn";
import { executionScopeFromSecurityContext } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("options") }).strict(),
  z.object({ action: z.literal("authorize"), response: z.unknown() }).strict(),
]);

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "invalid_ap2_authorization_request", details: parsed.error.flatten() },
      { status: 400, headers: ap2PrivateHeaders },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "run.agent",
      resourceType: "ap2_mandate_review",
      resourceId: id,
      metadata: { operation: `trusted_surface_${parsed.data.action}` },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const policy = loadAp2WebAuthnTrustPolicy();
    if (!policy) throw new Ap2HumanPresentStoreError(
      "A reviewed AP2 WebAuthn trust policy is not configured.",
      "trust_policy_required",
    );
    if (parsed.data.action === "options") {
      const [review, credentials] = await Promise.all([
        getAp2HumanPresentReview(id, {
          tenantId: context.tenantId,
          actorId: context.actorId,
        }),
        listAp2PaymentSigningCredentials({
          tenantId: context.tenantId,
          actorId: context.actorId,
        }),
      ]);
      if (!review) return Response.json(
        { error: "not_found", message: "AP2 mandate review not found." },
        { status: 404, headers: ap2PrivateHeaders },
      );
      const authorization = await beginAp2MandateAuthorization({
        review,
        credentials,
        policy,
      });
      return Response.json(authorization, { headers: ap2PrivateHeaders });
    }
    const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
    const result = await authorizeAp2HumanPresentReview({
      reviewId: id,
      response: parsed.data.response as AuthenticationResponseJSON,
      policy,
    }, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope: executionScopeFromSecurityContext(context, {
        correlationId: requestId,
        causationId: id,
        purpose: "ap2.mandates.authorize",
      }),
    });
    return Response.json({
      ...result,
      checkoutOrPaymentExecuted: false,
    }, {
      status: result.created ? 201 : 200,
      headers: ap2PrivateHeaders,
    });
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}
