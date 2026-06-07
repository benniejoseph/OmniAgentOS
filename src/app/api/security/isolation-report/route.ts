import { getTenantIsolationReport } from "@/lib/security/isolation-report";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "tenant_isolation_report",
    });
    return Response.json({ report: await getTenantIsolationReport(context.tenantId) });
  } catch (error) {
    return forbiddenResponse(error);
  }
}
