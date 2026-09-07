import { ZodError } from "zod";

import {
  A2AAccessError,
  a2aBearerChallenge,
  assertTrustedA2ANetworkBoundary,
  authenticateA2ARequest,
  type AuthorizedA2APrincipal,
} from "@/lib/a2a/auth";
import {
  A2A_MEDIA_TYPE,
  A2A_PROTOCOL_VERSION,
  A2AProtocolError,
  assertA2AProtocolVersion,
} from "@/lib/a2a/v1-contracts";
import { A2ATaskStoreError } from "@/lib/a2a/task-store";
import { A2ADelegatedToolError } from "@/lib/a2a/delegated-tools";
import { checkSharedRateLimit } from "@/lib/http/rate-limit";
import { JsonBodyError } from "@/lib/http/body";
import type { ServiceApiScope } from "@/lib/settings/service-api-keys";
import { runWithDatabaseTenantScope } from "@/lib/db/client";

export async function authorizeA2AHttpRequest(
  request: Request,
  scopes: readonly ServiceApiScope[],
) {
  const allowedOrigin = assertTrustedA2ANetworkBoundary(request);
  assertA2AProtocolVersion(request);
  const principal = await authenticateA2ARequest(request, scopes);
  const rateLimit = await runWithDatabaseTenantScope(principal.tenantId, () =>
    checkSharedRateLimit({
      key: `a2a:${principal.tenantId}:${principal.keyId}`,
      limit: 120,
      windowMs: 60_000,
    })
  );
  if (!rateLimit.allowed) {
    throw new A2AProtocolError(
      "A2A request limit reached. Try again shortly.",
      429,
      "resource_exhausted",
    );
  }
  return { allowedOrigin, principal } as const;
}

export function assertA2AJsonContentType(request: Request) {
  const value = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (value !== A2A_MEDIA_TYPE && value !== "application/json") {
    throw new A2AProtocolError(
      "A2A requests require application/a2a+json or application/json.",
      415,
      "unsupported_media_type",
    );
  }
}

export function a2aJsonResponse(
  value: unknown,
  init: ResponseInit = {},
  allowedOrigin?: string,
) {
  return secureA2AResponse(Response.json(value, init), allowedOrigin);
}

export function a2aErrorResponse(error: unknown, allowedOrigin?: string) {
  const access = error instanceof A2AAccessError ? error : undefined;
  const protocol = error instanceof A2AProtocolError ? error : undefined;
  const task = error instanceof A2ATaskStoreError ? error : undefined;
  const delegatedTool = error instanceof A2ADelegatedToolError ? error : undefined;
  const jsonBody = error instanceof JsonBodyError ? error : undefined;
  const validation = error instanceof ZodError;
  const status = access?.status || protocol?.status || task?.status || delegatedTool?.status || jsonBody?.status ||
    (validation ? 400 : 500);
  const code = protocol?.code || delegatedTool?.code ||
    (jsonBody?.status === 413
      ? "payload_too_large"
      : jsonBody?.status === 415
        ? "unsupported_media_type"
        : jsonBody
          ? "invalid_request"
          : undefined) ||
    (validation ? "invalid_request" : status === 401 ? "unauthenticated" : status === 403 ? "forbidden" : "internal_error");
  const message = access?.message || protocol?.message || task?.message || delegatedTool?.message || jsonBody?.message ||
    (validation ? "The A2A request payload is invalid." : "The A2A request could not be completed.");
  const headers = new Headers();
  if (status === 401) {
    headers.set(
      "WWW-Authenticate",
      delegatedTool
        ? 'Bearer realm="Asael A2A delegated tools"'
        : a2aBearerChallenge(access?.requiredScope),
    );
  }
  return a2aJsonResponse({
    error: { code, message, details: [] },
  }, { status, headers }, allowedOrigin);
}

export function a2aEventStreamResponse(
  stream: ReadableStream<Uint8Array>,
  allowedOrigin?: string,
) {
  return secureA2AResponse(new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  }), allowedOrigin, true);
}

export function encodeA2AEvent(value: unknown) {
  return new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`);
}

export function runInA2APrincipalScope<T>(
  principal: AuthorizedA2APrincipal,
  operation: () => T | Promise<T>,
) {
  return runWithDatabaseTenantScope(principal.tenantId, operation);
}

export function a2aOptionsResponse(request: Request) {
  try {
    const allowedOrigin = assertTrustedA2ANetworkBoundary(request);
    return secureA2AResponse(new Response(null, { status: 204 }), allowedOrigin);
  } catch (error) {
    return a2aErrorResponse(error);
  }
}

function secureA2AResponse(
  response: Response,
  allowedOrigin?: string,
  eventStream = false,
) {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("Pragma", "no-cache");
  if (!eventStream) headers.set("Content-Type", `${A2A_MEDIA_TYPE}; charset=utf-8`);
  headers.set("A2A-Version", A2A_PROTOCOL_VERSION);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Vary", "Authorization, Origin, A2A-Version");
  if (allowedOrigin) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set(
      "Access-Control-Allow-Headers",
      "Authorization, Content-Type, A2A-Version, A2A-Extensions, Idempotency-Key",
    );
    headers.set("Access-Control-Expose-Headers", "A2A-Version");
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
