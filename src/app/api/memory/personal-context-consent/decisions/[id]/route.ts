import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { inspectPersonalContextConsentService } from "@/lib/app-services/personal-context-consent";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { PersonalContextConsentNativeError } from "@/lib/memory/personal-context-consent-native-contracts";
import { nativePersonalContextConsentDecisionIdSchema } from "@/lib/mobile/personal-context-consent-contracts";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  if (!nativePersonalContextConsentDecisionIdSchema.safeParse(id).success || [...new URL(request.url).searchParams].length) {
    return Response.json({ error: "Invalid personal recall decision identifier." }, { status: 400, headers });
  }
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "personal_context_consent", resourceId: id });
  } catch (error) {
    const response = forbiddenResponse(error);
    response.headers.set("cache-control", headers["cache-control"]);
    return response;
  }
  try {
    const result = await inspectPersonalContextConsentService(createAppServiceCaller({ context }), id);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) {
    return error instanceof PersonalContextConsentNativeError
      ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers })
      : Response.json({ error: "Personal recall consent is temporarily unavailable.", code: "personal_context_consent_unavailable" }, { status: 503, headers });
  }
}
