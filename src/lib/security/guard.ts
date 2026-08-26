import { after } from "next/server";
import {
  redactSensitive,
  requirePermission,
  resolveSecurityContext,
  SecurityPolicyError,
  securityErrorResponse,
} from "@/lib/security/context";
import { recordSecurityAudit } from "@/lib/security/audit-store";
import type { SecurityContext } from "@/lib/security/types";
import { measureRequestStage } from "@/lib/observability/request-timing";
import { runWithDatabaseTenantScope } from "@/lib/db/client";

const safeRequestMethods = new Set(["GET", "HEAD", "OPTIONS"]);

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
    context = await measureRequestStage("auth", () =>
      resolveSecurityContext(request)
    );
  } catch (error) {
    if (!(error instanceof SecurityPolicyError)) {
      await measureRequestStage("audit", () =>
        recordSecuritySystemFailureSafely({
          request,
          action,
          resourceType,
          resourceId,
          reason:
            error instanceof Error ? error.message : "Security context failed.",
          riskLevel,
          metadata,
        })
      );
      throw error;
    }

    // Release security probes deliberately exercise protected routes without
    // credentials. Once their synthetic marker has been verified, the ordinary
    // "Authentication required" response is already the expected evidence;
    // synchronously persisting a redundant denial would make that 401 depend on
    // database availability. Other synthetic failures and all real-user
    // failures still take the durable observability path below.
    if (isExpectedSyntheticAuthenticationDenial(request, error)) {
      throw error;
    }

    await measureRequestStage("audit", () =>
      recordSecurityEventSafely({
        request,
        action: "security.auth_failed",
        resourceType,
        resourceId,
        decision: "deny",
        reason:
          error instanceof Error ? error.message : "Authentication failed.",
        riskLevel,
        metadata,
        statusCode: error instanceof SecurityPolicyError ? error.status : 401,
      })
    );
    throw error;
  }

  try {
    assertTrustedSessionMutation(request, context);
    requirePermission(context, action);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Access denied.";
    await measureRequestStage("audit", async () => {
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
    });
    throw error;
  }

  const allowedAudit = {
    context,
    action,
    resourceType,
    resourceId,
    decision: "allow" as const,
    riskLevel,
    metadata,
  };
  if (shouldDeferAllowedAudit(request, action, riskLevel)) {
    scheduleRoutineReadAudit(request, allowedAudit);
  } else {
    await measureRequestStage("audit", () =>
      recordAuditSafely(allowedAudit, {
        failClosed: requiresDurableAudit(action, riskLevel),
      })
    );
  }
  return context;
}

export function shouldDeferAllowedAudit(
  request: Pick<Request, "method">,
  action: string,
  riskLevel?: number,
) {
  return (
    safeRequestMethods.has(request.method.toUpperCase()) &&
    !requiresDurableAudit(action, riskLevel)
  );
}

export function assertTrustedSessionMutation(
  request: Request,
  context?: Pick<SecurityContext, "source">,
) {
  if (
    safeRequestMethods.has(request.method.toUpperCase()) ||
    (context && context.source !== "session")
  ) {
    return;
  }

  const suppliedOrigin = normalizeOrigin(request.headers.get("origin"));
  const expectedOrigin = trustedApplicationOrigin(request);
  if (!suppliedOrigin || suppliedOrigin !== expectedOrigin) {
    throw new SecurityPolicyError(
      "Cookie-authenticated mutations require the trusted application origin.",
      403,
    );
  }
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new SecurityPolicyError("Cross-site mutations are not allowed.", 403);
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

function trustedApplicationOrigin(request: Request) {
  const configured =
    process.env.NEXT_PUBLIC_APP_URL?.trim() ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : undefined);
  const origin = normalizeOrigin(configured || request.url);
  if (!origin) {
    throw new SecurityPolicyError(
      "The trusted application origin is not configured.",
      503,
    );
  }
  return origin;
}

function normalizeOrigin(value?: string | null) {
  if (!value) {
    return undefined;
  }
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function recordAuditSafely(args: Parameters<typeof recordSecurityAudit>[0], options: { failClosed?: boolean } = {}) {
  try {
    await recordSecurityAudit(args);
  } catch (error) {
    if (options.failClosed) {
      throw new SecurityPolicyError(
        "The security audit ledger is unavailable, so this consequential action was not executed.",
        503,
      );
    }
    console.warn(
      "Security audit write failed.",
      redactSensitive(error instanceof Error ? error.message : error),
    );
  }
}

function requiresDurableAudit(action: string, riskLevel?: number) {
  return (riskLevel ?? 0) >= 2 || [
    "execute.tool",
    "manage.connector",
    "manage.identity",
    "manage.security",
    "manage.workflow",
  ].includes(action);
}

function scheduleRoutineReadAudit(
  request: Request,
  args: Parameters<typeof recordSecurityAudit>[0],
) {
  // Verified synthetic probes already emit dedicated observability evidence;
  // duplicating every successful read in the security ledger can overwhelm a
  // cross-region database during release tests.
  if (
    isVerifiedSyntheticRequest(request) ||
    Math.random() >= allowedReadAuditSampleRate()
  ) {
    return;
  }
  try {
    after(() =>
      runWithDatabaseTenantScope(args.context.tenantId, () =>
        recordAuditSafely(args),
      ),
    );
  } catch {
    // Unit calls and non-Next runtimes do not expose a response lifecycle.
    // Routine reads remain fail-open; denials and consequential actions above
    // are still written synchronously.
  }
}

function isVerifiedSyntheticRequest(request: Request) {
  const expected = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
  const provided = request.headers.get("x-omni-synthetic-auth")?.trim();
  return Boolean(expected && provided && expected === provided);
}

function isExpectedSyntheticAuthenticationDenial(
  request: Request,
  error: SecurityPolicyError,
) {
  return (
    error.status === 401 &&
    error.message === "Authentication required." &&
    isVerifiedSyntheticRequest(request)
  );
}

function allowedReadAuditSampleRate() {
  const configured = Number(process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE);
  if (Number.isFinite(configured)) {
    return Math.min(Math.max(configured, 0), 1);
  }
  return process.env.NODE_ENV === "production" ? 0.05 : 0;
}

async function recordSecuritySystemFailureSafely({
  request,
  action,
  resourceType,
  resourceId,
  reason,
  riskLevel,
  metadata,
}: {
  request: Request;
  action: string;
  resourceType: string;
  resourceId?: string;
  reason: string;
  riskLevel?: number;
  metadata?: Record<string, unknown>;
}) {
  try {
    const { createRequestTelemetry, recordRuntimeEventSafely } = await import("@/lib/observability/store");
    const telemetry = createRequestTelemetry(request, "security");
    await recordRuntimeEventSafely({
      level: "error",
      category: "security",
      action: "security.context_failed",
      route: new URL(request.url).pathname,
      method: request.method,
      statusCode: 500,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      resourceType,
      resourceId,
      message: reason,
      metadata: {
        failureType: "security_context_failure",
        requestedAction: action,
        riskLevel,
        ...telemetry.syntheticMetadata,
        ...metadata,
      },
    });
  } catch (eventError) {
    console.warn("Security context observability write failed.", eventError instanceof Error ? eventError.message : eventError);
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
    const syntheticFailureMetadata = telemetry.syntheticMetadata.synthetic
      ? {
          ...telemetry.syntheticMetadata,
          expectedFailure: action === "security.auth_failed",
        }
      : {};
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
        ...syntheticFailureMetadata,
        ...metadata,
      },
    });
  } catch (error) {
    console.warn("Security observability write failed.", error instanceof Error ? error.message : error);
  }
}
