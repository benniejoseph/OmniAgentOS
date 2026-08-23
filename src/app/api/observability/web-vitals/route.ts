import { after } from "next/server";
import { z } from "zod";
import { getSessionToken } from "@/lib/auth/session";
import { getSessionIdentity } from "@/lib/auth/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getTrustedClientIp } from "@/lib/http/client-ip";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import {
  createRequestTelemetry,
  recordRuntimeEventSafely,
} from "@/lib/observability/store";

export const runtime = "nodejs";

const metricSchema = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.enum(["CLS", "FCP", "INP", "LCP"]),
  value: z.number().finite().nonnegative().max(3_600_000),
  rating: z.enum(["good", "needs-improvement", "poor"]),
});

const payloadSchema = z.object({
  path: z.string().trim().min(1).max(300).startsWith("/"),
  metrics: z.array(metricSchema).min(1).max(4),
});

export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request) {
  const clientIp = getTrustedClientIp(request);
  let rateLimit;
  try {
    rateLimit = await checkSharedRateLimit({
      key: `observability:web-vitals:${clientIp}`,
      limit: clientIp === "unavailable" ? 2_000 : 120,
      windowMs: 15 * 60 * 1_000,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof RateLimitStoreUnavailableError
            ? "Web Vitals ingestion is temporarily unavailable."
            : "Web Vitals rate limiting failed.",
      },
      { status: 503 },
    );
  }
  if (!rateLimit.allowed) {
    return Response.json(
      { error: "Too many Web Vitals samples." },
      {
        status: 429,
        headers: { "retry-after": String(rateLimit.retryAfterSeconds) },
      },
    );
  }

  const parsed = payloadSchema.safeParse(
    await request.json().catch(() => undefined),
  );
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid Web Vitals payload." },
      { status: 400 },
    );
  }

  const telemetry = createRequestTelemetry(request, "web-vitals");
  const sessionToken = getSessionToken(request);
  after(async () => {
    const identity = sessionToken
      ? await getSessionIdentity(sessionToken).catch(() => undefined)
      : undefined;
    await recordRuntimeEventSafely({
      category: "api",
      action: "web_vitals.sample",
      route: parsed.data.path,
      method: "CLIENT",
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      tenantId: identity?.context.tenantId || "public",
      actorId: identity?.context.actorId,
      message: "Sampled browser performance metrics.",
      metadata: {
        metrics: parsed.data.metrics,
        sampled: true,
        sloExcluded: true,
      },
    });
  });

  return new Response(null, {
    status: 202,
    headers: { "cache-control": "private, no-store" },
  });
}
