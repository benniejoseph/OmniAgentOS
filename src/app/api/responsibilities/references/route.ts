import { withDatabaseRequestScope } from "@/lib/db/client";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { readResponsibilityReferenceOptions } from "@/lib/responsibilities/reference-options";
import { authorizeRequest } from "@/lib/security/guard";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_references" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    exactQuery(request, []);
    return Response.json(await readResponsibilityReferenceOptions(context), { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
});
