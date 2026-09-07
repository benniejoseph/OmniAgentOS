import { withDatabaseRequestScope } from "@/lib/db/client";
import { ap2ErrorResponse, ap2PrivateHeaders } from "@/lib/payments/ap2-http";
import { listAp2HumanPresentReviews } from "@/lib/payments/ap2-store";
import { loadAp2WebAuthnTrustPolicy, publicTrustPolicy } from "@/lib/payments/ap2-webauthn";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "ap2_mandate_review",
      metadata: { operation: "trusted_surface_review" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const policy = loadAp2WebAuthnTrustPolicy();
    const reviews = await listAp2HumanPresentReviews({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    return Response.json({
      trustedSurface: "deterministic_non_agentic",
      trustPolicy: policy ? publicTrustPolicy(policy) : null,
      reviews,
      transactionsPermitted: false,
    }, { headers: ap2PrivateHeaders });
  } catch (error) {
    return ap2ErrorResponse(error);
  }
}
