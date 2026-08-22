import type { OpenApiConnectorRecord, OpenApiOperationRecord } from "@/lib/connectors/openapi-types";
import { assertSafeOpenApiOperationPath } from "@/lib/connectors/openapi-importer";
import { assertConnectorSecretBinding } from "@/lib/connectors/secret-binding";
import { readResponseTextLimited } from "@/lib/http/body";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { fetchPublicHttpUrl } from "@/lib/security/network";
import { redactExactSecrets } from "@/lib/security/secret-redaction";
import type { SecurityRole } from "@/lib/security/types";

type OpenApiToolInput = {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
};

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
const MAX_RESPONSE_BYTES = 20_000;
const MAX_REQUEST_BODY_BYTES = 256_000;
const MAX_OPERATION_URL_CHARS = 8_192;

export async function callOpenApiOperation({
  connector,
  operation,
  input,
  idempotencyKey,
  abortSignal,
  actorRole,
}: {
  connector: OpenApiConnectorRecord;
  operation: OpenApiOperationRecord;
  input: Record<string, unknown>;
  idempotencyKey?: string;
  abortSignal?: AbortSignal;
  actorRole?: SecurityRole;
}) {
  assertBoundedJson(input, MAX_REQUEST_BODY_BYTES, "OpenAPI operation arguments");
  const normalizedInput = normalizeInput(input);
  const url = buildOperationUrl(connector.baseUrl, operation.path, normalizedInput);
  assertExactConnectorOrigin(connector.baseUrl, url);
  const { headers, secretValues } = buildHeaders({
    connector,
    operation,
    input: normalizedInput,
    targetUrl: url,
    idempotencyKey,
    actorRole,
  });
  const body = buildBody(operation, normalizedInput);
  if (body && new TextEncoder().encode(body).byteLength > MAX_REQUEST_BODY_BYTES) {
    throw new Error("OpenAPI request body exceeds the configured byte limit.");
  }

  const response = await fetchPublicHttpUrl(url, {
    method: operation.method,
    headers,
    body,
    signal: combineSignals(abortSignal, AbortSignal.timeout(30_000)),
  }, "OpenAPI operation URL");

  const contentType = response.headers.get("content-type") || "";
  const responseBody = await readResponseTextLimited(response, MAX_RESPONSE_BYTES);
  const outputBody = redactExactSecrets(
    parseResponseBody(responseBody.text, contentType, responseBody.truncated),
    secretValues,
  );
  if (!response.ok) {
    await recordRuntimeEventSafely({
      level: "error",
      category: "connector",
      action: "connector.openapi.call_failed",
      statusCode: response.status,
      tenantId: connector.tenantId,
      resourceType: "openapi_connector",
      resourceId: connector.id,
      message: `OpenAPI operation returned HTTP ${response.status}.`,
      metadata: {
        failureType: "connector_failure",
        connectorName: connector.name,
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        url: redactUrl(url),
      },
    });
  }

  return {
    request: {
      method: operation.method,
      url: redactUrl(url),
      headers: Object.keys(headers).filter((header) => !isSecretHeader(header)),
      bodySent: Boolean(body),
    },
    response: {
      status: response.status,
      ok: response.ok,
      contentType,
      body: outputBody,
      truncated: responseBody.truncated,
    },
  };
}

function normalizeInput(input: Record<string, unknown>): OpenApiToolInput {
  return {
    path: isRecord(input.path) ? input.path : {},
    query: isRecord(input.query) ? input.query : {},
    headers: isRecord(input.headers) ? input.headers : {},
    body: "body" in input ? input.body : undefined,
  };
}

export function buildOperationUrl(baseUrl: string, path: string, input: OpenApiToolInput) {
  assertSafeOpenApiOperationPath(path);
  const base = new URL(baseUrl);
  const resolvedPath = path.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.replace(/^\+/, "");
    const value = input.path?.[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    const stringValue = String(value);
    assertSafePathParameterValue(name, stringValue);
    return encodeURIComponent(stringValue);
  });
  const url = new URL(joinPaths(base.pathname, resolvedPath), base.origin);
  assertWithinConnectorBasePath(base, url);

  for (const [key, value] of Object.entries(input.query || {})) {
    appendSearchParam(url, key, value);
  }

  if (url.toString().length > MAX_OPERATION_URL_CHARS) {
    throw new Error("OpenAPI operation URL exceeds the configured length limit.");
  }
  return url.toString();
}

function buildHeaders({
  connector,
  operation,
  input,
  targetUrl,
  idempotencyKey,
  actorRole,
}: {
  connector: OpenApiConnectorRecord;
  operation: OpenApiOperationRecord;
  input: OpenApiToolInput;
  targetUrl: string;
  idempotencyKey?: string;
  actorRole?: SecurityRole;
}) {
  const headers: Record<string, string> = {};
  const secretValues: string[] = [];

  for (const [key, value] of Object.entries(input.headers || {})) {
    if (value !== undefined && value !== null) {
      assertSafeCallerHeader(key);
      headers[key] = String(value);
    }
  }

  if (!METHODS_WITHOUT_BODY.has(operation.method) && input.body !== undefined) {
    headers["content-type"] = headers["content-type"] || operation.requestContentType || "application/json";
  }

  if (connector.authType === "bearer_env") {
    const envName = connector.authTokenEnv?.trim().toUpperCase();
    assertConnectorSecretBinding({
      envName,
      tenantId: connector.tenantId,
      targetUrl,
      role: actorRole,
    });
    const token = envName ? process.env[envName] : undefined;
    if (!token) {
      throw new Error(`Missing bearer token env var: ${connector.authTokenEnv || "unknown"}`);
    }
    headers.authorization = `Bearer ${token}`;
    secretValues.push(token);
  }

  if (connector.authType === "api_key_header_env") {
    const envName = connector.authTokenEnv?.trim().toUpperCase();
    assertConnectorSecretBinding({
      envName,
      tenantId: connector.tenantId,
      targetUrl,
      role: actorRole,
    });
    const token = envName ? process.env[envName] : undefined;
    if (!token) {
      throw new Error(`Missing API key env var: ${connector.authTokenEnv || "unknown"}`);
    }
    const headerName = connector.authHeaderName || "x-api-key";
    assertSafeCallerHeader(headerName);
    headers[headerName] = token;
    secretValues.push(token);
  }

  if (idempotencyKey) {
    headers["idempotency-key"] = normalizeIdempotencyKey(idempotencyKey);
  }

  return { headers, secretValues };
}

function buildBody(operation: OpenApiOperationRecord, input: OpenApiToolInput) {
  if (METHODS_WITHOUT_BODY.has(operation.method) || input.body === undefined) {
    return undefined;
  }

  if (typeof input.body === "string") {
    return input.body;
  }

  const contentType = operation.requestContentType || "";
  if (contentType.includes("application/x-www-form-urlencoded") && isRecord(input.body)) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input.body)) {
      appendFormParam(params, key, value);
    }
    return params.toString();
  }

  return JSON.stringify(input.body);
}

function appendSearchParam(url: URL, key: string, value: unknown) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendSearchParam(url, key, item);
    }
    return;
  }

  url.searchParams.append(key, String(value));
}

function appendFormParam(params: URLSearchParams, key: string, value: unknown) {
  if (value === undefined || value === null) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      appendFormParam(params, key, item);
    }
    return;
  }

  params.append(key, String(value));
}

function parseResponseBody(text: string, contentType: string, truncated: boolean) {
  const boundedText = truncated ? `${text}… [truncated]` : text;
  if (contentType.includes("json") && !truncated) {
    try {
      return JSON.parse(text);
    } catch {
      return boundedText;
    }
  }

  return boundedText;
}

function joinPaths(basePath: string, operationPath: string) {
  const base = basePath === "/" ? "" : basePath.replace(/\/$/, "");
  const operation = operationPath.startsWith("/") ? operationPath : `/${operationPath}`;
  return `${base}${operation}` || "/";
}

function redactUrl(value: string) {
  const url = new URL(value);
  for (const key of url.searchParams.keys()) {
    if (/token|key|secret|password|auth/i.test(key)) {
      url.searchParams.set(key, "[redacted]");
    }
  }
  return url.toString();
}

function isSecretHeader(header: string) {
  return /authorization|token|key|secret|password|cookie/i.test(header);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function assertExactConnectorOrigin(baseUrl: string, operationUrl: string) {
  const connectorOrigin = new URL(baseUrl).origin;
  const resolvedOrigin = new URL(operationUrl).origin;
  if (resolvedOrigin !== connectorOrigin) {
    throw new Error(
      `OpenAPI operation resolved outside the connector origin (${resolvedOrigin} !== ${connectorOrigin}).`,
    );
  }
}

function assertWithinConnectorBasePath(baseUrl: URL, operationUrl: URL) {
  const basePath = baseUrl.pathname.replace(/\/+$/, "");
  if (
    basePath &&
    basePath !== "/" &&
    operationUrl.pathname !== basePath &&
    !operationUrl.pathname.startsWith(`${basePath}/`)
  ) {
    throw new Error(
      `OpenAPI operation resolved outside the connector base path (${operationUrl.pathname} is not under ${basePath}).`,
    );
  }
}

function assertSafePathParameterValue(name: string, value: string) {
  let decoded = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      break;
    }
  }
  if (
    /[\u0000-\u001f\u007f]/.test(decoded) ||
    decoded.split(/[\\/]/).some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(`Path parameter ${name} contains a traversal segment.`);
  }
}

export function assertSafeCallerHeader(name: string) {
  const normalized = name.trim().toLowerCase();
  if (
    !normalized ||
    /[\r\n]/.test(name) ||
    /^(authorization|cookie|host|connection|content-length|transfer-encoding|forwarded|proxy-|sec-|cf-connecting-ip|true-client-ip|x-(?:forwarded-|original-|rewrite-|http-method-override$|method-override$|real-ip$|client-ip$|vercel-))/i.test(normalized)
  ) {
    throw new Error(`OpenAPI caller header is not allowed: ${name}`);
  }
}

function assertBoundedJson(value: unknown, maxBytes: number, label: string) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(`${label} must be JSON serializable.`);
  }
  if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
    throw new Error(`${label} exceed the configured byte limit.`);
  }
}

function normalizeIdempotencyKey(value: string) {
  const normalized = value.trim().replace(/[\r\n]/g, "").slice(0, 200);
  if (!normalized) {
    throw new Error("Idempotency key must not be empty.");
  }
  return normalized;
}

function combineSignals(signal: AbortSignal | undefined, timeoutSignal: AbortSignal) {
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}
