import { requirePermission, resolveSecurityContext, securityErrorResponse } from "@/lib/security/context";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import type { SecurityContext } from "@/lib/security/types";

export async function authorizeRequest({
  request,
  action,
  resourceType,
  resourceId,
  riskLevel,
  metadata,
}: {
  request: Request;
  action: string;
  resourceType: string;
  resourceId?: string;
  riskLevel?: number;
  metadata?: Record<string, unknown>;
}) {
  const context = await resolveSecurityContext(request);

  try {
    requirePermission(context, action);
    await recordSecurityAudit({
      context,
      action,
      resourceType,
      resourceId,
      decision: "allow",
      riskLevel,
      metadata,
    });
    return context;
  } catch (error) {
    await recordSecurityAudit({
      context,
      action,
      resourceType,
      resourceId,
      decision: "deny",
      reason: error instanceof Error ? error.message : "Access denied.",
      riskLevel,
      metadata,
    });
    throw error;
  }
}

export function forbiddenResponse(error: unknown) {
  return securityErrorResponse(error);
}

export function securityHeaders(context: SecurityContext) {
  return {
    "x-omni-tenant-id": context.tenantId,
    "x-omni-actor-role": context.role,
  };
}
