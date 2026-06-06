import { getSecurityStats, listSecurityAudits } from "@/lib/security/audit-store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") || 50), 1), 100);

  try {
    const context = await authorizeRequest({
      request,
      action: "read.security",
      resourceType: "security_audit",
      metadata: { limit },
    });

    const [records, stats] = await Promise.all([
      listSecurityAudits({ tenantId: context.tenantId, limit }),
      getSecurityStats(context.tenantId),
    ]);

    return Response.json({ records, stats });
  } catch (error) {
    return forbiddenResponse(error);
  }
}
