import { withDatabaseRequestScope } from "@/lib/db/client";
import { getCompanionPreferences, saveCompanionPreferences } from "@/lib/companion/service";
import { CompanionPreferencesError } from "@/lib/companion/state";
import { JsonBodyError, parseJsonBody } from "@/lib/http/body";
import { requiredRequestIdempotencyKey, requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(requireIdempotencyKey(PATCHHandler));
const privateHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "companion_preferences" }); }
  catch (error) { return denial(error); }
  try { return Response.json(await getCompanionPreferences(context), { headers: privateHeaders }); }
  catch (error) { return failure(error); }
}

async function PATCHHandler(request: Request) {
  let context;
  try {
    // Native mutation enrollment is intentionally absent; this adds no mobile write authority.
    context = await authorizeRequest({ request, action: "manage.own_preferences", resourceType: "companion_preferences" });
  } catch (error) { return denial(error); }
  try {
    const body = await parseJsonBody(request, 4_096);
    return Response.json(await saveCompanionPreferences(context, body, requiredRequestIdempotencyKey(request)), { headers: privateHeaders });
  } catch (error) { return failure(error); }
}

function denial(error: unknown) {
  const response = forbiddenResponse(error);
  response.headers.set("cache-control", "private, no-store");
  return response;
}
function failure(error: unknown) {
  if (error instanceof CompanionPreferencesError) return Response.json({
    error: error.message, code: error.code, ...(error.status === 409 ? { reload: true } : {}),
  }, { status: error.status, headers: privateHeaders });
  if (error instanceof JsonBodyError) return Response.json({ error: error.message, code: "companion_request_invalid" }, { status: error.status, headers: privateHeaders });
  return Response.json({ error: "Companion preferences could not be loaded or saved.", code: "companion_unavailable" }, { status: 503, headers: privateHeaders });
}
