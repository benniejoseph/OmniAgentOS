import { createAppServiceCaller } from "@/lib/app-services/contracts";
import { readSalesforceNativeActionService } from "@/lib/app-services/salesforce-native";
import { salesforceNativeFailureResponse } from "@/lib/customer-success/salesforce-native-http";
import { nativeSalesforceActionReadInputSchema } from "@/lib/mobile/salesforce-native-contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 30;
export const GET = withDatabaseRequestScope(GETHandler);
const headers = { "cache-control": "private, no-store" };
async function GETHandler(request: Request, route: { params: Promise<{ keySha256: string }> }) {
  const { keySha256 } = await route.params, entries = [...new URL(request.url).searchParams];
  const parsed = nativeSalesforceActionReadInputSchema.safeParse({ ...Object.fromEntries(entries), keySha256 });
  if (!parsed.success || entries.length !== 1 || entries[0][0] !== "workspaceId") return Response.json({ error: "An exact Salesforce key and workspace are required." }, { status: 400, headers });
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "salesforce_connection" }); }
  catch (error) { const response = forbiddenResponse(error); response.headers.set("cache-control", headers["cache-control"]); return response; }
  try { const result = await readSalesforceNativeActionService(createAppServiceCaller({ context }), parsed.data);
    return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers }); }
  catch (error) { return salesforceNativeFailureResponse(error); }
}
