import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { customerSuccessWorkflowNativeAcceptanceReadServiceInputSchema, readCustomerSuccessWorkflowNativeAcceptanceService } from "@/lib/app-services/customer-success-workflows";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string; runId: string; keySha256: string }> }) {
  const { id, runId, keySha256 } = await route.params;
  const entries = [...new URL(request.url).searchParams];
  const parsed = customerSuccessWorkflowNativeAcceptanceReadServiceInputSchema.safeParse({ ...Object.fromEntries(entries), accountId: id, runId, keySha256 });
  if (!parsed.success || entries.length !== 1 || entries[0][0] !== "workspaceId") {
    return Response.json({ error: "An exact Account, workflow acceptance and workspace are required." }, { status: 400, headers });
  }
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "customer_success_workflow", resourceId: runId }); }
  catch (error) {
    try { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
    catch { return Response.json({ error: "Workflow authorization is temporarily unavailable." }, { status: 503, headers }); }
  }
  try {
    const result = await readCustomerSuccessWorkflowNativeAcceptanceService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return customerAccountFailureResponse(error, "exact workflow acceptance read"); }
}
