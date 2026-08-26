import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import { pipeline, Transform } from "node:stream";

const MEBIBYTE = 1024 * 1024;
const DEFAULT_PORT = 8080;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_SHUTDOWN_GRACE_MS = 280_000;
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;
const MODEL_PATH_PATTERN = /^\/v1\/models\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const upstreamAgent = new Agent({
  keepAlive: true,
  maxFreeSockets: 4,
  maxSockets: 12,
  scheduling: "lifo",
});

const routeDefinitions = [
  {
    id: "responses",
    method: "POST",
    path: "/v1/responses",
    maxBodyBytes: 8 * MEBIBYTE,
    timeoutMs: 290_000,
    contentType: "application/json",
  },
  {
    id: "embeddings",
    method: "POST",
    path: "/v1/embeddings",
    maxBodyBytes: 2 * MEBIBYTE,
    timeoutMs: 60_000,
    contentType: "application/json",
  },
  {
    id: "audio_transcriptions",
    method: "POST",
    path: "/v1/audio/transcriptions",
    maxBodyBytes: 12 * MEBIBYTE,
    timeoutMs: 120_000,
    contentType: "multipart/form-data",
  },
];

class BodyLimitError extends Error {
  constructor() {
    super("Request body exceeded its route limit.");
    this.name = "BodyLimitError";
  }
}

class GatewayTimeoutError extends Error {
  constructor() {
    super("OpenAI upstream request timed out.");
    this.name = "GatewayTimeoutError";
  }
}

class ClientClosedError extends Error {
  constructor() {
    super("Gateway client disconnected.");
    this.name = "ClientClosedError";
  }
}

/**
 * Starts the authenticated OpenAI egress transport. Production always uses the
 * fixed api.openai.com origin; upstreamRequest is injectable only so tests can
 * exercise byte-for-byte streaming without external network calls.
 */
export async function startOpenAIEgressGateway(options = {}) {
  const token = String(
    options.token ?? process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN ?? "",
  ).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error(
      "OMNIAGENT_OPENAI_GATEWAY_TOKEN must be 32-256 URL-safe characters.",
    );
  }
  const previousToken = String(
    options.previousToken ??
      process.env.OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN ??
      "",
  ).trim();
  if (previousToken && !TOKEN_PATTERN.test(previousToken)) {
    throw new Error(
      "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN must be 32-256 URL-safe characters when configured.",
    );
  }
  if (previousToken && tokensEqual(previousToken, token)) {
    throw new Error(
      "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN must differ from OMNIAGENT_OPENAI_GATEWAY_TOKEN.",
    );
  }
  const acceptedTokenDigests = [
    digestToken(token),
    ...(previousToken ? [digestToken(previousToken)] : []),
  ];

  const host = options.host || "0.0.0.0";
  const port = boundedInteger(
    options.port ?? process.env.OMNIAGENT_OPENAI_GATEWAY_PORT,
    DEFAULT_PORT,
    0,
    65_535,
  );
  const maxConcurrency = boundedInteger(
    options.maxConcurrency ??
      process.env.OMNIAGENT_OPENAI_GATEWAY_MAX_CONCURRENCY,
    DEFAULT_CONCURRENCY,
    1,
    16,
  );
  const requestUpstream = options.upstreamRequest || httpsRequest;
  const agent = options.upstreamAgent === undefined
    ? upstreamAgent
    : options.upstreamAgent;
  const logger = options.logger || console;
  const routeOverrides = options.routeOverrides || {};
  const liveUpstreams = new Set();
  const sockets = new Set();
  let activeRequests = 0;
  let closing = false;
  let closePromise;

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch(() => {
      if (!response.headersSent && !response.destroyed) {
        writeJson(response, 500, { error: "Gateway request failed." });
      } else if (!response.destroyed) {
        response.destroy();
      }
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 130_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 50;
  server.maxRequestsPerSocket = 100;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  async function handleRequest(request, response) {
    const parsed = parseGatewayRoute(request.method, request.url);
    if (parsed.kind === "health") {
      writeJson(response, 200, healthPayload());
      return;
    }

    const requestId = randomUUID();
    response.setHeader("x-asael-gateway-request-id", requestId);
    if (closing) {
      rejectRequest(response, logger, requestId, parsed.routeId, 503, "closing");
      return;
    }
    if (parsed.kind === "invalid") {
      const headers = parsed.allow ? { allow: parsed.allow } : undefined;
      rejectRequest(
        response,
        logger,
        requestId,
        parsed.routeId,
        parsed.status,
        parsed.reason,
        headers,
      );
      request.resume();
      return;
    }

    const providedToken = singleHeader(request.headers["x-asael-gateway-token"]);
    if (!providedToken || !tokenMatchesAny(providedToken, acceptedTokenDigests)) {
      rejectRequest(response, logger, requestId, parsed.route.id, 401, "authentication");
      request.resume();
      return;
    }
    const authorization = singleHeader(request.headers.authorization);
    if (!isBearerAuthorization(authorization)) {
      rejectRequest(response, logger, requestId, parsed.route.id, 400, "authorization");
      request.resume();
      return;
    }
    if (!contentTypeAllowed(request, parsed.route)) {
      rejectRequest(response, logger, requestId, parsed.route.id, 415, "content_type");
      request.resume();
      return;
    }
    const declaredLength = declaredContentLength(request);
    if (declaredLength === null) {
      rejectRequest(response, logger, requestId, parsed.route.id, 400, "content_length");
      request.resume();
      return;
    }
    if (declaredLength > parsed.route.maxBodyBytes) {
      rejectRequest(response, logger, requestId, parsed.route.id, 413, "body_limit");
      request.resume();
      return;
    }
    if (activeRequests >= maxConcurrency) {
      rejectRequest(
        response,
        logger,
        requestId,
        parsed.route.id,
        503,
        "concurrency",
        { "retry-after": "1" },
      );
      request.resume();
      return;
    }

    activeRequests += 1;
    try {
      await proxyToOpenAI({
        request,
        response,
        route: applyRouteOverrides(parsed.route, routeOverrides),
        authorization,
        requestId,
        requestUpstream,
        agent,
        logger,
        liveUpstreams,
      });
    } finally {
      activeRequests -= 1;
      if (closing && activeRequests === 0) {
        setImmediate(() => server.closeIdleConnections?.());
      }
    }
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  emitLog(logger, "info", "openai_egress.started", {
    host,
    port: address && typeof address === "object" ? address.port : port,
    maxConcurrency,
    region: safeRuntimeValue(process.env.FLY_REGION),
    revision: safeRuntimeValue(process.env.OMNIAGENT_RELEASE_SHA),
  });

  return {
    server,
    address,
    health: healthPayload,
    close({ graceMs = DEFAULT_SHUTDOWN_GRACE_MS } = {}) {
      if (closePromise) return closePromise;
      closing = true;
      const boundedGraceMs = boundedInteger(graceMs, DEFAULT_SHUTDOWN_GRACE_MS, 0, 300_000);
      closePromise = new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(forceTimer);
          emitLog(logger, "info", "openai_egress.stopped", {
            activeRequests,
            forced: false,
          });
          resolve();
        };
        const forceTimer = setTimeout(() => {
          if (settled) return;
          for (const upstream of liveUpstreams) {
            upstream.destroy(new Error("Gateway shutdown grace period expired."));
          }
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections?.();
          settled = true;
          emitLog(logger, "warn", "openai_egress.stopped", {
            activeRequests,
            forced: true,
          });
          resolve();
        }, boundedGraceMs);
        forceTimer.unref?.();
        server.close(finish);
        server.closeIdleConnections?.();
      });
      return closePromise;
    },
  };

  function healthPayload() {
    return {
      status: "healthy",
      service: "asael-openai-egress",
      region: safeRuntimeValue(process.env.FLY_REGION),
      revision: safeRuntimeValue(process.env.OMNIAGENT_RELEASE_SHA),
      protocol: "1",
    };
  }
}

function proxyToOpenAI({
  request,
  response,
  route,
  authorization,
  requestId,
  requestUpstream,
  agent,
  logger,
  liveUpstreams,
}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let requestBytes = 0;
    let responseBytes = 0;
    let ttfbMs;
    let upstreamStatus;
    let upstreamRequestId;
    let completed = false;
    let upstream;

    const finish = (statusCode, errorKind) => {
      if (completed) return;
      completed = true;
      clearTimeout(timeout);
      if (upstream) liveUpstreams.delete(upstream);
      emitLog(logger, errorKind ? "warn" : "info", "openai_egress.completed", {
        requestId,
        route: route.id,
        method: route.method,
        statusCode,
        durationMs: Date.now() - startedAt,
        ttfbMs,
        requestBytes,
        responseBytes,
        upstreamRequestId,
        errorKind,
        region: safeRuntimeValue(process.env.FLY_REGION),
        revision: safeRuntimeValue(process.env.OMNIAGENT_RELEASE_SHA),
      });
      resolve();
    };

    const fail = (error) => {
      if (completed) return;
      const failure = classifyProxyFailure(error);
      if (!response.headersSent && !response.destroyed && failure.statusCode !== 499) {
        writeJson(response, failure.statusCode, { error: failure.publicMessage });
      } else if (!response.destroyed && !response.writableEnded) {
        response.destroy();
      }
      finish(failure.statusCode, failure.kind);
    };

    const timeout = setTimeout(() => {
      const error = new GatewayTimeoutError();
      upstream?.destroy(error);
      fail(error);
    }, route.timeoutMs);
    timeout.unref?.();

    try {
      upstream = requestUpstream(
        {
          protocol: "https:",
          hostname: "api.openai.com",
          port: 443,
          method: route.method,
          path: route.path,
          agent,
          headers: upstreamRequestHeaders(request, authorization),
        },
        (upstreamResponse) => {
          if (completed) {
            upstreamResponse.destroy();
            return;
          }
          ttfbMs = Date.now() - startedAt;
          upstreamStatus = upstreamResponse.statusCode || 502;
          upstreamRequestId = safeHeaderValue(upstreamResponse.headers["x-request-id"]);
          const headers = upstreamResponseHeaders(upstreamResponse.headers);
          response.writeHead(upstreamStatus, headers);
          const meter = new Transform({
            transform(chunk, _encoding, callback) {
              responseBytes += chunk.length;
              callback(null, chunk);
            },
          });
          pipeline(upstreamResponse, meter, response, (error) => {
            if (error) {
              fail(response.writableEnded ? error : new ClientClosedError());
              return;
            }
            finish(upstreamStatus);
          });
        },
      );
    } catch (error) {
      fail(error);
      return;
    }

    liveUpstreams.add(upstream);
    upstream.once("error", fail);
    const clientClosed = () => {
      if (!completed && !response.writableEnded) {
        const error = new ClientClosedError();
        upstream.destroy(error);
        fail(error);
      }
    };
    request.once("aborted", clientClosed);
    response.once("close", clientClosed);

    if (route.method === "GET") {
      upstream.end();
      return;
    }

    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        requestBytes += chunk.length;
        callback(
          requestBytes > route.maxBodyBytes ? new BodyLimitError() : null,
          chunk,
        );
      },
    });
    pipeline(request, limiter, upstream, (error) => {
      if (error) fail(error);
    });
  });
}

function parseGatewayRoute(method = "", rawUrl = "") {
  if (rawUrl === "/healthz") {
    return method === "GET"
      ? { kind: "health" }
      : { kind: "invalid", status: 405, reason: "method", routeId: "health", allow: "GET" };
  }
  if (!rawUrl.startsWith("/") || rawUrl.length > 256) {
    return { kind: "invalid", status: 404, reason: "path", routeId: "unknown" };
  }
  let url;
  try {
    url = new URL(rawUrl, "http://gateway.invalid");
  } catch {
    return { kind: "invalid", status: 404, reason: "path", routeId: "unknown" };
  }
  if (url.origin !== "http://gateway.invalid" || url.search || url.hash) {
    return { kind: "invalid", status: 404, reason: "path", routeId: "unknown" };
  }

  const definition = routeDefinitions.find((candidate) => candidate.path === url.pathname);
  if (definition) {
    return method === definition.method
      ? { kind: "proxy", route: definition }
      : {
          kind: "invalid",
          status: 405,
          reason: "method",
          routeId: definition.id,
          allow: definition.method,
        };
  }
  if (MODEL_PATH_PATTERN.test(url.pathname)) {
    const route = {
      id: "model_readiness",
      method: "GET",
      path: url.pathname,
      maxBodyBytes: 0,
      timeoutMs: 15_000,
    };
    return method === "GET"
      ? { kind: "proxy", route }
      : { kind: "invalid", status: 405, reason: "method", routeId: route.id, allow: "GET" };
  }
  return { kind: "invalid", status: 404, reason: "path", routeId: "unknown" };
}

function applyRouteOverrides(route, overrides) {
  const override = overrides[route.id] || {};
  return {
    ...route,
    timeoutMs: boundedInteger(override.timeoutMs, route.timeoutMs, 25, 300_000),
    maxBodyBytes: boundedInteger(
      override.maxBodyBytes,
      route.maxBodyBytes,
      route.method === "GET" ? 0 : 1,
      route.maxBodyBytes,
    ),
  };
}

function contentTypeAllowed(request, route) {
  if (!route.contentType) return true;
  const value = singleHeader(request.headers["content-type"])?.toLowerCase() || "";
  return value === route.contentType || value.startsWith(`${route.contentType};`);
}

function declaredContentLength(request) {
  const raw = request.headers["content-length"];
  if (raw === undefined) return 0;
  const value = singleHeader(raw);
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function upstreamRequestHeaders(request, authorization) {
  const headers = {
    authorization,
    accept: singleHeader(request.headers.accept) || "application/json",
    "accept-encoding": "identity",
    "user-agent": "asael-openai-egress/1",
  };
  for (const name of [
    "content-type",
    "content-length",
    "idempotency-key",
    "openai-beta",
    "openai-organization",
    "openai-project",
  ]) {
    const value = singleHeader(request.headers[name]);
    if (value) headers[name] = value;
  }
  return headers;
}

function upstreamResponseHeaders(headers) {
  const forwarded = { "cache-control": "private, no-store" };
  for (const name of [
    "content-type",
    "content-length",
    "openai-processing-ms",
    "retry-after",
    "retry-after-ms",
    "x-request-id",
    "x-ratelimit-limit-requests",
    "x-ratelimit-limit-tokens",
    "x-ratelimit-remaining-requests",
    "x-ratelimit-remaining-tokens",
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
  ]) {
    const value = safeHeaderValue(headers[name]);
    if (value) forwarded[name] = value;
  }
  return forwarded;
}

function classifyProxyFailure(error) {
  if (error instanceof BodyLimitError) {
    return { statusCode: 413, kind: "body_limit", publicMessage: "Request body is too large." };
  }
  if (error instanceof GatewayTimeoutError) {
    return { statusCode: 504, kind: "upstream_timeout", publicMessage: "OpenAI request timed out." };
  }
  if (error instanceof ClientClosedError || error?.code === "ECONNRESET") {
    return { statusCode: 499, kind: "client_closed", publicMessage: "Client disconnected." };
  }
  return { statusCode: 502, kind: "upstream_unavailable", publicMessage: "OpenAI is unavailable." };
}

function rejectRequest(response, logger, requestId, route, statusCode, reason, headers) {
  emitLog(logger, statusCode >= 500 ? "warn" : "info", "openai_egress.rejected", {
    requestId,
    route,
    statusCode,
    reason,
    region: safeRuntimeValue(process.env.FLY_REGION),
    revision: safeRuntimeValue(process.env.OMNIAGENT_RELEASE_SHA),
  });
  writeJson(response, statusCode, { error: rejectionMessage(statusCode) }, headers);
}

function rejectionMessage(statusCode) {
  if (statusCode === 401) return "Unauthorized.";
  if (statusCode === 404) return "Not found.";
  if (statusCode === 405) return "Method not allowed.";
  if (statusCode === 413) return "Request body is too large.";
  if (statusCode === 415) return "Unsupported media type.";
  if (statusCode === 503) return "Gateway is busy.";
  return "Invalid gateway request.";
}

function writeJson(response, statusCode, body, headers = {}) {
  if (response.headersSent || response.destroyed) return;
  response.writeHead(statusCode, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function isBearerAuthorization(value) {
  return Boolean(value && /^Bearer [^\s,]{16,2048}$/.test(value));
}

function tokensEqual(left, right) {
  return timingSafeEqual(digestToken(left), digestToken(right));
}

function tokenMatchesAny(providedToken, acceptedTokenDigests) {
  const providedDigest = digestToken(providedToken);
  let matched = 0;
  for (const acceptedDigest of acceptedTokenDigests) {
    matched |= timingSafeEqual(providedDigest, acceptedDigest) ? 1 : 0;
  }
  return matched === 1;
}

function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest();
}

function singleHeader(value) {
  if (typeof value !== "string" || value.includes("\r") || value.includes("\n")) return undefined;
  return value;
}

function safeHeaderValue(value) {
  const normalized = singleHeader(value);
  return normalized?.slice(0, 256);
}

function safeRuntimeValue(value) {
  const normalized = String(value || "unknown").trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(normalized) ? normalized : "unknown";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function emitLog(logger, level, event, fields) {
  const method = level === "warn" ? logger.warn : level === "error" ? logger.error : logger.log;
  method?.call(logger, JSON.stringify({ level, event, ...fields }));
}
