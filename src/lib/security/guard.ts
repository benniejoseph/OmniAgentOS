import { requirePermission, resolveSecurityContext, SecurityPolicyError, securityErrorResponse } from "@/lib/security/context";
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
  let context: SecurityContext;
  try {
    context = await resolveSecurityContext(request);
  } catch (error) {
    await recordSecurityEventSafely({
      request,
      action: "security.auth_failed",
      resourceType,
      resourceId,
      decision: "deny",
      reason: error instanceof Error ? error.message : "Authentication failed.",
      riskLevel,
      metadata,
      statusCode: error instanceof SecurityPolicyError ? error.status : 401,
    });
    throw error;
  }

  try {
    requirePermission(context, action);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Access denied.";
    await recordAuditSafely({
      context,
      action,
      resourceType,
      resourceId,
      decision: "deny",
      reason,
      riskLevel,
      metadata,
    });
    await recordSecurityEventSafely({
      request,
      context,
      action: "security.policy_blocked",
      requestedAction: action,
      resourceType,
      resourceId,
      decision: "deny",
      reason,
      riskLevel,
      metadata,
      statusCode: error instanceof SecurityPolicyError ? error.status : 403,
    });
    throw error;
  }

  await recordAuditSafely({
    context,
    action,
    resourceType,
    resourceId,
    decision: "allow",
    riskLevel,
    metadata,
  });
  return context;
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

async function recordAuditSafely(args: Parameters<typeof recordSecurityAudit>[0]) {
  try {
    await recordSecurityAudit(args);
  } catch (error) {
    console.warn("Security audit write failed.", error instanceof Error ? error.message : error);
  }
}

async function recordSecurityEventSafely({
  request,
  context,
  action,
  requestedAction,
  resourceType,
  resourceId,
  decision,
  reason,
  riskLevel,
  metadata,
  statusCode,
}: {
  request: Request;
  context?: SecurityContext;
  action: "security.auth_failed" | "security.policy_blocked";
  requestedAction?: string;
  resourceType: string;
  resourceId?: string;
  decision: "deny";
  reason: string;
  riskLevel?: number;
  metadata?: Record<string, unknown>;
  statusCode: number;
}) {
  try {
    const { createRequestTelemetry, recordRuntimeEventSafely } = await import("@/lib/observability/store");
    const telemetry = createRequestTelemetry(request, "security");
    await recordRuntimeEventSafely({
      level: "warn",
      category: "security",
      action,
      route: new URL(request.url).pathname,
      method: request.method,
      statusCode,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: context?.tenantId,
      actorId: context?.actorId,
      resourceType,
      resourceId,
      message: reason,
      metadata: {
        decision,
        failureType: action === "security.auth_failed" ? "auth_failure" : "policy_block",
        requestedAction,
        riskLevel,
        ...metadata,
      },
    });
  } catch (error) {
    console.warn("Security observability write failed.", error instanceof Error ? error.message : error);
  }
}
