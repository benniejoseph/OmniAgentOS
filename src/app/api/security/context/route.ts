import { getSecurityStats } from "@/lib/security/audit-store";
import { canPerform, resolveSecurityContext, rbacRules, secretVaultPolicy, securityErrorResponse } from "@/lib/security/context";

export const runtime = "nodejs";

export async function GET(request: Request) {
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
