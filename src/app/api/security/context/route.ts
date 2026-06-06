import { getSecurityStats } from "@/lib/security/audit-store";
import { canPerform, getSecurityContext, rbacRules, secretVaultPolicy } from "@/lib/security/context";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const context = getSecurityContext(request);
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
