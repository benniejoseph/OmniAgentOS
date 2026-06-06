import { getOperationsOverview } from "@/lib/operations/queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "operations",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  return Response.json(await getOperationsOverview());
}
