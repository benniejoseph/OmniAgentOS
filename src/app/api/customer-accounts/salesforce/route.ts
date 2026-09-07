import { oauthConfigured } from "@/lib/connectors/oauth-providers";
import {
  publicSalesforceWorkspaceContext,
  resolveSalesforceRequestAccess,
} from "@/lib/customer-success/salesforce-access";
import {
  getSalesforceSyncHealth,
  listSalesforceReconciliationFindings,
} from "@/lib/customer-success/salesforce-store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let security;
  try {
    security = await authorizeRequest({
      request,
      action: "read",
      resourceType: "salesforce_connection",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const access = await resolveSalesforceRequestAccess(security, {
      workspaceId: new URL(request.url).searchParams.get("workspaceId") || undefined,
      mode: "read",
      correlationId: crypto.randomUUID(),
    });
    const [health, findings] = await Promise.all([
      getSalesforceSyncHealth(
        access.readAuthority,
        oauthConfigured("salesforce"),
      ),
      listSalesforceReconciliationFindings(access.readAuthority, 50),
    ]);
    return Response.json({
      context: publicSalesforceWorkspaceContext(access.access),
      health,
      findings,
      authorizeUrl: `/api/oauth/salesforce/authorize?returnTo=${encodeURIComponent("/app/accounts")}&workspaceId=${encodeURIComponent(access.readAuthority.workspaceId)}`,
      webhook: {
        endpoint: "/api/webhooks/salesforce",
        signature: "hmac-sha256-v1",
        configured: Boolean(process.env.SALESFORCE_WEBHOOK_SECRET?.trim()),
      },
    }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return Response.json(
      { error: "Salesforce connection health is temporarily unavailable." },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}
