import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { customerFactNativeAcceptanceReadServiceInputSchema, readCustomerFactNativeAcceptanceService } from "@/lib/app-services/customer-facts";
import { customerAccountFailureResponse } from "@/lib/customer-success/http";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ id: string; keySha256: string }> }) {
  const { id, keySha256 } = await route.params, entries = [...new URL(request.url).searchParams];
  const parsed = customerFactNativeAcceptanceReadServiceInputSchema.safeParse({ ...Object.fromEntries(entries), accountId: id, keySha256 });
  if (!parsed.success || entries.length !== 1 || entries[0][0] !== "workspaceId") return Response.json({ error: "Exact Account, fact key and workspace are required." }, { status: 400, headers });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "customer_account_fact", resourceId: id }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  try {
    const result = await readCustomerFactNativeAcceptanceService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers });
  } catch (error) { return customerAccountFailureResponse(error, "exact manual fact acceptance read"); }
}
