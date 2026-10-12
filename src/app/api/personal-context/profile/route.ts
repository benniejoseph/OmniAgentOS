import { withDatabaseRequestScope } from "@/lib/db/client";
import { assertCompanionOwnerBinding } from "@/lib/companion/owner-binding";
import { CompanionPreferencesError } from "@/lib/companion/state";
import { JsonBodyError, parseJsonBody } from "@/lib/http/body";
import { requiredRequestIdempotencyKey, requireIdempotencyKey } from "@/lib/http/idempotency-key";
import { personalProfileChangeSchema } from "@/lib/personal-context/contracts";
import { changePersonalProfile, PersonalProfileError, readPersonalProfile } from "@/lib/personal-context/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PUT = withDatabaseRequestScope(requireIdempotencyKey(PUTHandler));
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request) {
  let context: SecurityContext;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "personal_profile" }); }
  catch (error) { return denial(error); }
  try { return Response.json(await readPersonalProfile(owner(request, context)), { headers }); }
  catch (error) { return failure(error); }
}
async function PUTHandler(request: Request) {
  let context: SecurityContext;
  try { context = await authorizeRequest({ request, action: "manage.own_preferences", resourceType: "personal_profile", nativeMutationCapability: "personal.profile.update" }); }
  catch (error) { return denial(error); }
  try {
    const scopedOwner = owner(request, context);
    const parsed = personalProfileChangeSchema.safeParse(await parseJsonBody(request, 48_000));
    if (!parsed.success) throw new PersonalProfileError("Check the About me fields and try again.", 400, "personal_profile_invalid");
    return Response.json(await changePersonalProfile(scopedOwner, parsed.data, requiredRequestIdempotencyKey(request)), { headers });
  } catch (error) { return failure(error); }
}
function owner(request: Request, context: SecurityContext) {
  if (context.source !== "session" && context.source !== "mobile") {
    throw new PersonalProfileError("Sign in to use About me.", 403, "personal_profile_owner_required");
  }
  assertCompanionOwnerBinding(request, context);
  const binding = canonicalRequestActorBindingFromSecurityContext(context);
  if (!binding) throw new PersonalProfileError("The account could not be confirmed. Sign in again.", 403, "personal_profile_owner_required");
  return { tenantId: context.tenantId, actorId: context.actorId, requestActorBinding: binding };
}
function denial(error: unknown) {
  const response = forbiddenResponse(error);
  response.headers.set("cache-control", "private, no-store"); return response;
}
function failure(error: unknown) {
  if (error instanceof PersonalProfileError || error instanceof CompanionPreferencesError) {
    return Response.json({ error: error instanceof CompanionPreferencesError ? "The account changed. Reopen About me for the current account." : error.message,
      code: error instanceof CompanionPreferencesError ? "personal_profile_owner_conflict" : error.code,
      ...(error.status === 409 ? { reload: true } : {}) }, { status: error.status, headers });
  }
  if (error instanceof JsonBodyError) return Response.json({ error: error.message, code: "personal_profile_invalid" }, { status: error.status, headers });
  return Response.json({ error: "About me is temporarily unavailable. Please try again.", code: "personal_profile_unavailable" }, { status: 503, headers });
}
