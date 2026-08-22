import { withDatabaseRequestScope } from "@/lib/db/client";
import { getSecurityStats } from "@/lib/security/audit-store";
import { canPerform, resolveSecurityContext, rbacRules, secretVaultPolicy, securityErrorResponse } from "@/lib/security/context";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(request: Request) {
  let context;
  try {
    context = await resolveSecurityContext(request);
  } catch (error) {
    return securityErrorResponse(error);
  }
  const canReadSecurity = canPerform(context.role, "read.security");

  return Response.json({
    context,
    stats: canReadSecurity ? await getSecurityStats(context.tenantId) : undefined,
    policy: {
      rbacRules,
      secretVault: secretVaultPolicy(),
    },
  });
}
