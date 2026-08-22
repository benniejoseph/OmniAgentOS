import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  AccessRequestStoreUnavailableError,
  getAccessRequestStore,
  type AccessRequestRecord,
  type AccessRequestReceipt,
} from "@/lib/onboarding/access-request-store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { getTrustedClientIp } from "@/lib/http/client-ip";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { redactSensitive } from "@/lib/security/context";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const accessRequestSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254).transform((value) => value.toLowerCase()),
  company: z.string().trim().min(2).max(160),
  role: z.enum(["founder", "engineering", "product", "operations", "security", "other"]),
  useCase: z.string().trim().min(12).max(800),
  timeline: z.enum(["now", "30_days", "quarter", "research"]),
}).strict();
const accessRequestWindowMs = 24 * 60 * 60 * 1_000;

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "onboarding");
  const clientIp = getTrustedClientIp(request);
  let ipLimit;
  try {
    ipLimit = await checkSharedRateLimit({
      key:
        clientIp === "unavailable"
          ? "onboarding:access:global-fallback"
          : `onboarding:access:ip:${clientIp}`,
      limit: clientIp === "unavailable" ? 250 : 10,
      windowMs: accessRequestWindowMs,
    });
  } catch (error) {
    return rateLimitUnavailableResponse(error);
  }
  if (!ipLimit.allowed) {
    return rateLimitedResponse(ipLimit.retryAfterSeconds);
  }

  let body: unknown;
  try {
    body = await parseJsonBody(request, 16_384);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = accessRequestSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid access request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  let emailLimit;
  try {
    emailLimit = await checkSharedRateLimit({
      key: `onboarding:access:email:${createHash("sha256").update(parsed.data.email).digest("hex")}`,
      limit: 3,
      windowMs: accessRequestWindowMs,
    });
  } catch (error) {
    return rateLimitUnavailableResponse(error);
  }
  if (!emailLimit.allowed) {
    return rateLimitedResponse(emailLimit.retryAfterSeconds);
  }

  const accessRequestId = randomUUID();
  const createdAt = new Date().toISOString();
  const record: AccessRequestRecord = {
    id: accessRequestId,
    tenantId: accessRequestTenantId(),
    ...parsed.data,
    useCase: String(redactSensitive(parsed.data.useCase)),
    status: "pending_review",
    createdAt,
    updatedAt: createdAt,
  };

  let receipt: AccessRequestReceipt;
  try {
    receipt = await getAccessRequestStore().save(record);
  } catch (error) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "system",
      action: "onboarding.access_request_persistence_failed",
      route: "/api/onboarding/request-access",
      method: "POST",
      statusCode: 503,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: record.tenantId,
      resourceType: "access_request",
      resourceId: accessRequestId,
      message: "Access request could not be persisted.",
      metadata: {
        accessRequestId,
        failureType:
          error instanceof AccessRequestStoreUnavailableError
            ? "store_unavailable"
            : "persistence_failure",
        ...telemetry.syntheticMetadata,
      },
    });
    return Response.json(
      {
        error: "Access request not saved",
        message: "Your request was not stored. Please try again later or contact the workspace administrator.",
      },
      { status: 503 },
    );
  }

  await recordRuntimeEventSafely({
    category: "system",
    action: "onboarding.access_requested",
    route: "/api/onboarding/request-access",
    method: "POST",
    statusCode: 201,
    durationMs: Date.now() - startedAt,
    requestId: telemetry.requestId,
    correlationId: telemetry.correlationId,
    tenantId: record.tenantId,
    resourceType: "access_request",
    resourceId: accessRequestId,
    message: "Public workspace access request persisted.",
    metadata: {
      accessRequestId,
      role: parsed.data.role,
      timeline: parsed.data.timeline,
      useCaseLength: parsed.data.useCase.length,
      storage: receipt.storage,
      ...telemetry.syntheticMetadata,
    },
  });

  return Response.json(
    {
      id: accessRequestId,
      status: "pending_review",
      persistedAt: receipt.persistedAt,
      next: [
        "Keep the reference below while an administrator reviews the request.",
        "Try the sample workspace without connecting production systems.",
        "Use sign in when an administrator has created your account.",
      ],
    },
    { status: 201 },
  );
}

function rateLimitedResponse(retryAfterSeconds: number) {
  return Response.json(
    {
      error: "Too Many Requests",
      message: "Too many access requests were submitted. Please try again later.",
    },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSeconds) },
    },
  );
}

function rateLimitUnavailableResponse(error: unknown) {
  if (!(error instanceof RateLimitStoreUnavailableError)) {
    throw error;
  }
  return Response.json(
    {
      error: "Access requests temporarily unavailable",
      message: "Your request cannot be safely accepted right now. Please try again shortly.",
    },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}

function accessRequestTenantId() {
  return (
    process.env.OMNIAGENT_ACCESS_REQUEST_TENANT_ID ||
    process.env.OMNIAGENT_DEFAULT_TENANT ||
    "default"
  )
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}
