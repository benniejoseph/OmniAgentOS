import { withDatabaseRequestScope } from "@/lib/db/client";
import { parseJsonBody } from "@/lib/http/body";
import { requireIdempotencyKey, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { createResponsibilityDraft, listResponsibilityDrafts } from "@/lib/responsibilities/service";
import { ResponsibilityError } from "@/lib/responsibilities/state";
import { authorizeRequest } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(requireIdempotencyKey(POSTHandler));
async function GETHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_draft" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    const query = exactQuery(request, ["limit"]);
    const value = query.get("limit");
    if (value !== null && !/^(?:[1-9][0-9]?|100)$/.test(value)) throw new ResponsibilityError("The list limit must be 1–100.", 400, "responsibility_limit_invalid");
    return Response.json(await listResponsibilityDrafts(context, value === null ? 40 : Number(value)), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "manage.workflow", resourceType: "responsibility_draft", nativeMutationCapability: "responsibilities.drafts.manage" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    exactQuery(request, []);
    const result = await createResponsibilityDraft(context, await parseJsonBody(request, 32_768), requiredRequestIdempotencyKey(request));
    return Response.json(result, { status: result.replayed ? 200 : 201, headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
}
