import type { OpenApiConnectorRecord, OpenApiOperationRecord } from "@/lib/connectors/openapi-types";

type OpenApiToolInput = {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, unknown>;
  body?: unknown;
};

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);
const MAX_RESPONSE_TEXT = 20_000;

export async function callOpenApiOperation({
  connector,
  operation,
  input,
}: {
  connector: OpenApiConnectorRecord;
  operation: OpenApiOperationRecord;
  input: Record<string, unknown>;
}) {
  const normalizedInput = normalizeInput(input);
  const url = buildOperationUrl(connector.baseUrl, operation.path, normalizedInput);
  const headers = buildHeaders({ connector, operation, input: normalizedInput });
  const body = buildBody(operation, normalizedInput);

  const response = await fetch(url, {
    method: operation.method,
    headers,
    body,
    signal: AbortSignal.timeout(30_000),
  });

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const outputBody = parseResponseBody(text, contentType);

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
      truncated: typeof outputBody === "string" && text.length > MAX_RESPONSE_TEXT,
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

function buildOperationUrl(baseUrl: string, path: string, input: OpenApiToolInput) {
  const base = new URL(baseUrl);
  const resolvedPath = path.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.replace(/^\+/, "");
    const value = input.path?.[name];
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required path parameter: ${name}`);
    }
    return encodeURIComponent(String(value));
  });
  const url = new URL(joinPaths(base.pathname, resolvedPath), base.origin);

  for (const [key, value] of Object.entries(input.query || {})) {
    appendSearchParam(url, key, value);
  }

  return url.toString();
}

function buildHeaders({
  connector,
  operation,
  input,
}: {
  connector: OpenApiConnectorRecord;
  operation: OpenApiOperationRecord;
  input: OpenApiToolInput;
}) {
  const headers: Record<string, string> = {};

  for (const [key, value] of Object.entries(input.headers || {})) {
    if (value !== undefined && value !== null) {
      headers[key] = String(value);
    }
  }

  if (!METHODS_WITHOUT_BODY.has(operation.method) && input.body !== undefined) {
    headers["content-type"] = headers["content-type"] || operation.requestContentType || "application/json";
  }

  if (connector.authType === "bearer_env") {
    const token = connector.authTokenEnv ? process.env[connector.authTokenEnv] : undefined;
    if (!token) {
      throw new Error(`Missing bearer token env var: ${connector.authTokenEnv || "unknown"}`);
    }
    headers.authorization = `Bearer ${token}`;
  }

  if (connector.authType === "api_key_header_env") {
    const token = connector.authTokenEnv ? process.env[connector.authTokenEnv] : undefined;
    if (!token) {
      throw new Error(`Missing API key env var: ${connector.authTokenEnv || "unknown"}`);
    }
    headers[connector.authHeaderName || "x-api-key"] = token;
  }

  return headers;
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

function parseResponseBody(text: string, contentType: string) {
  const boundedText = text.length > MAX_RESPONSE_TEXT ? `${text.slice(0, MAX_RESPONSE_TEXT)}...` : text;
  if (contentType.includes("json")) {
    try {
      return JSON.parse(boundedText);
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
