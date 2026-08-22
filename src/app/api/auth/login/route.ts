import { z } from "zod";
import {
  hashSessionToken,
  MAX_PASSWORD_LENGTH,
  PasswordWorkCapacityError,
} from "@/lib/auth/crypto";
import { sessionCookie } from "@/lib/auth/session";
import { authenticatePassword } from "@/lib/auth/store";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { getTrustedClientIp } from "@/lib/http/client-ip";
import {
  checkSharedRateLimit,
  RateLimitStoreUnavailableError,
} from "@/lib/http/rate-limit";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
}).strict();
const loginWindowMs = 15 * 60 * 1000;
const loginIpLimit = 30;
const loginGlobalFallbackLimit = 1_000;
const loginAccountLimit = 10;
const accountAttemptQueues = new Map<string, Promise<void>>();

async function POSTHandler(request: Request) {
  const startedAt = Date.now();
  const telemetry = createRequestTelemetry(request, "auth");
  const clientIp = getTrustedClientIp(request);
  let ipLimit;
  try {
    ipLimit = await checkSharedRateLimit({
      key:
        clientIp === "unavailable"
          ? "auth:login:global-fallback"
          : `auth:login:ip:${clientIp}`,
      limit:
        clientIp === "unavailable"
          ? loginGlobalFallbackLimit
          : loginIpLimit,
      windowMs: loginWindowMs,
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
  const parsed = loginSchema.safeParse(body);

  if (!parsed.success) {
    return Response.json(
      { error: "Invalid login", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  const normalizedEmail = parsed.data.email.trim().toLowerCase();
  const accountKey = hashSessionToken(normalizedEmail);
  return serializeAccountAttempt(accountKey, async () => {
    let accountLimit;
    try {
      accountLimit = await checkSharedRateLimit({
        key: `auth:login:account:${accountKey}`,
        limit: loginAccountLimit,
        windowMs: loginWindowMs,
      });
    } catch (error) {
      return rateLimitUnavailableResponse(error);
    }
    if (!accountLimit.allowed) {
      return rateLimitedResponse(accountLimit.retryAfterSeconds);
    }

    let result;
    try {
      result = await authenticatePassword({
        email: normalizedEmail,
        password: parsed.data.password,
      });
    } catch (error) {
      if (error instanceof PasswordWorkCapacityError) {
        return Response.json(
          {
            error: "Authentication temporarily unavailable",
            message: "Sign in is at capacity. Please try again shortly.",
          },
          { status: 503, headers: { "Retry-After": "5" } },
        );
      }
      throw error;
    }

    if (!result) {
      await recordRuntimeEventSafely({
        level: "warn",
        category: "security",
        action: "security.auth_failed",
        route: "/api/auth/login",
        method: "POST",
        statusCode: 401,
        durationMs: Date.now() - startedAt,
        requestId: telemetry.requestId,
        correlationId: telemetry.correlationId,
        tenantId: process.env.OMNIAGENT_DEFAULT_TENANT || "default",
        resourceType: "auth_session",
        message: "Password authentication failed.",
        metadata: {
          failureType: "auth_failure",
          authMethod: "password",
          accountHash: accountKey.slice(0, 24),
          ...telemetry.syntheticMetadata,
        },
      });
      return Response.json(
        { error: "Unauthorized", message: "Email or password is incorrect, or the user is not active." },
        { status: 401 },
      );
    }

    return Response.json(
      {
        authenticated: true,
        context: result.identity.context,
        user: result.identity.user,
        tenant: result.identity.tenant,
        membership: result.identity.membership,
      },
      {
        headers: {
          "Set-Cookie": sessionCookie(result.token, result.identity.session.expiresAt),
        },
      },
    );
  });
}

async function serializeAccountAttempt<T>(key: string, attempt: () => Promise<T>) {
  const previous = accountAttemptQueues.get(key) || Promise.resolve();
  let release = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  accountAttemptQueues.set(key, tail);

  await previous.catch(() => {});
  try {
    return await attempt();
  } finally {
    release();
    if (accountAttemptQueues.get(key) === tail) {
      accountAttemptQueues.delete(key);
    }
  }
}

function rateLimitedResponse(retryAfterSeconds: number) {
  return Response.json(
    { error: "Too Many Requests", message: "Too many login attempts. Try again later." },
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
      error: "Authentication temporarily unavailable",
      message: "Sign in cannot be safely processed right now. Please try again shortly.",
    },
    { status: 503, headers: { "Retry-After": "30" } },
  );
}
