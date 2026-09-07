import { SalesforceProviderError } from "@/lib/customer-success/salesforce-adapter";
import { resolveSalesforceRequestAccess } from "@/lib/customer-success/salesforce-access";
import { syncSalesforceWorkspace } from "@/lib/customer-success/salesforce-sync";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 300;
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "manage.connector",
      resourceType: "salesforce_sync",
      metadata: { operation: "read_sync" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const access = await resolveSalesforceRequestAccess(security, {
      workspaceId: new URL(request.url).searchParams.get("workspaceId") || undefined,
      mode: "write",
      correlationId: crypto.randomUUID(),
    });
    const result = await syncSalesforceWorkspace({
      authority: access.mutationAuthority!,
      abortSignal: request.signal,
    });
    return Response.json(result, {
      status: result.status === "busy" ? 202 : 200,
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof SalesforceProviderError
          ? error.actionableError.message
          : "Salesforce synchronization failed and can be retried safely.",
        actionableError: error instanceof SalesforceProviderError
          ? error.actionableError
          : undefined,
      },
      { status: 502, headers: { "cache-control": "private, no-store" } },
    );
  }
}
