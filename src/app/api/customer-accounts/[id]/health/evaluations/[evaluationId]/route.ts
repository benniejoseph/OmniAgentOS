import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { customerHealthEvaluationReadServiceInputSchema, readCustomerHealthEvaluationService } from "@/lib/app-services/customer-health";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
type RouteContext = { params: Promise<{ id: string; evaluationId: string }> };

async function GETHandler(request: Request, routeContext: RouteContext) {
  const params = await routeContext.params, query = [...new URL(request.url).searchParams];
  let accountId: string, evaluationId: string;
  try { accountId = decodeURIComponent(params.id); evaluationId = decodeURIComponent(params.evaluationId); }
  catch { return invalidRequest(); }
  if (query.length !== 1 || query[0][0] !== "workspaceId") return invalidRequest();
  const parsed = customerHealthEvaluationReadServiceInputSchema.safeParse({ accountId, evaluationId, workspaceId: query[0][1] });
  if (!parsed.success) return invalidRequest();
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "customer_health_score", resourceId: accountId });
  } catch (error) {
    try {
      const response = forbiddenResponse(error);
      response.headers.set("cache-control", headers["cache-control"]);
      return response;
    } catch {
      return Response.json({ error: "Customer health authorization is temporarily unavailable.", code: "customer_health_unavailable" }, { status: 503, headers });
    }
  }
  try {
    const result = await readCustomerHealthEvaluationService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) {
    // A missing/denied lookup never establishes that an earlier write did not
    // commit. Exact nullable acceptance is the only successful read contract.
    return customerAccountFailureResponse(error, "health evaluation receipt read");
  }
}
function invalidRequest() {
  return Response.json({ error: "Invalid exact health evaluation query.", code: "customer_health_query_invalid" }, { status: 400, headers });
}
