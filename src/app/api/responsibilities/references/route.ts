import { withDatabaseRequestScope } from "@/lib/db/client";
import { exactQuery, responsibilityDenial, responsibilityFailure, responsibilityHeaders } from "@/lib/responsibilities/http";
import { readResponsibilityReferenceOptions } from "@/lib/responsibilities/reference-options";
import { authorizeRequest } from "@/lib/security/guard";
import { needsLegacyResponsibilityContract } from "@/lib/mobile/responsibility-compatibility";
export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(async (request: Request) => {
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "responsibility_references" }); }
  catch (error) { return responsibilityDenial(error); }
  try {
    exactQuery(request, []);
    const result = await readResponsibilityReferenceOptions(context);
    if (needsLegacyResponsibilityContract(context)) {
      if (result.groups.sources.state === "available") result.groups.sources.items = result.groups.sources.items.filter(({ source }) => source.kind !== "work_item");
      if (result.groups.procedures.state === "available") result.groups.procedures.items = result.groups.procedures.items.filter(({ id }) => id !== "responsibility.work_item.followthrough.v1");
    }
    return Response.json(result, { headers: responsibilityHeaders });
  } catch (error) { return responsibilityFailure(error); }
});
