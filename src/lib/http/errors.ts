import { randomUUID } from "node:crypto";
import { PRIVATE_NO_STORE_CACHE_CONTROL } from "@/lib/http/response";
import { redactSensitive } from "@/lib/security/context";

/** Statuses for failures the caller neither caused nor can correct. */
export type ServerErrorStatus = 500 | 502 | 503 | 504;

const DEFAULT_CODES: Record<ServerErrorStatus, string> = {
  500: "internal_error",
  502: "upstream_failed",
  503: "unavailable",
  504: "timeout",
};

/** postgres.js raises these, with no SQLSTATE, when a connection fails. */
const CONNECTION_FAILURE_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
]);

const PLATFORM_REQUEST_ID = /^[A-Za-z0-9:._-]{1,128}$/;

/**
 * Answers a server failure without its internal detail. The caller gets a
 * fixed message, a stable code and a request id, and the detail is logged
 * under that id.
 */
export function serverErrorResponse(
  error: unknown,
  options: {
    message: string;
    status?: ServerErrorStatus;
    code?: string;
    request?: Request;
    body?: Record<string, unknown>;
    headers?: HeadersInit;
  },
) {
  const status = options.status ?? 500;
  const code = options.code ?? DEFAULT_CODES[status];
  const requestId = randomUUID();
  console.error(JSON.stringify({
    level: "error",
    event: "api.server_error",
    requestId,
    status,
    code,
    ...requestFields(options.request),
    error: redactSensitive(errorDetail(error)),
  }));
  const headers = new Headers(options.headers);
  headers.set("cache-control", PRIVATE_NO_STORE_CACHE_CONTROL);
  headers.set("x-request-id", requestId);
  return Response.json(
    { ...options.body, error: options.message, code, requestId },
    { status, headers },
  );
}

/**
 * Whether a failure came from the database or the host rather than from the
 * request, so that no request-level status or message describes it.
 */
export function isServerFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const { code, syscall } = error as { code?: unknown; syscall?: unknown };
  return error.name === "PostgresError" ||
    typeof syscall === "string" ||
    (typeof code === "string" && CONNECTION_FAILURE_CODES.has(code));
}

function requestFields(request: Request | undefined) {
  if (!request) return {};
  const platformRequestId = request.headers.get("x-vercel-id");
  let route: string | undefined;
  try {
    route = new URL(request.url).pathname.slice(0, 512);
  } catch {
    route = undefined;
  }
  return {
    method: request.method,
    route,
    ...(platformRequestId && PLATFORM_REQUEST_ID.test(platformRequestId)
      ? { platformRequestId }
      : {}),
  };
}

function errorDetail(error: unknown) {
  if (!(error instanceof Error)) {
    return { thrown: String(error).slice(0, 2_000) };
  }
  const code = (error as { code?: unknown }).code;
  return {
    name: error.name,
    message: error.message.slice(0, 2_000),
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
    stack: error.stack?.slice(0, 4_000),
  };
}
