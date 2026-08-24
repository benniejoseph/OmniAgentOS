import { withDatabaseRequestScope } from "@/lib/db/client";
import { loadWorkspaceReadiness } from "@/lib/workspace/readiness";
import {
  resolveSecurityContext,
  securityErrorResponse,
} from "@/lib/security/context";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  try {
    const context = await resolveSecurityContext(request);
    const readiness = await loadWorkspaceReadiness({
      tenantId: context.tenantId,
      identityReady: true,
    });
    return Response.json(readiness, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) {
    return securityErrorResponse(error);
  }
}
