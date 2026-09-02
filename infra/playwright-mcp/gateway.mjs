import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, rm } from "node:fs/promises";
import {
  createServer,
  request as httpRequest,
} from "node:http";
import {
  BlockList,
  connect as connectSocket,
  isIP,
} from "node:net";

const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{32,256}$/;
const SCOPE_PATTERN = /^[A-Za-z0-9._~-]{32,128}$/;
const LOOPBACK_HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MCP_KEEPER_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_BODY_BYTES = 1_048_576;
const MAX_KEEPER_RESPONSE_BYTES = 1_048_576;
const CHILD_STOP_GRACE_MS = 5_000;
const SHUTDOWN_GRACE_MS = 20_000;
const MCP_UPSTREAM_INACTIVITY_MS = 70_000;
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const MCP_REQUEST_HEADERS = new Set([
  "accept",
  "content-length",
  "content-type",
  "idempotency-key",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "user-agent",
]);
const MCP_RESPONSE_HEADERS = new Set([
  "allow",
  "cache-control",
  "content-length",
  "content-type",
  "mcp-session-id",
  "retry-after",
]);

const listenPort = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_PORT,
  8080,
  1,
  65_535,
);
const egressProxyPort = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_EGRESS_PROXY_PORT,
  8899,
  1,
  65_535,
);
const maxConcurrency = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_MAX_CONCURRENCY,
  8,
  1,
  32,
);
const maxScopes = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_MAX_SCOPES,
  2,
  1,
  8,
);
const scopeTtlMs = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_SCOPE_TTL_MS,
  30 * 60_000,
  60_000,
  30 * 60_000,
);
const scopeReclaimIdleMs = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_SCOPE_RECLAIM_IDLE_MS,
  2 * 60_000,
  10_000,
  scopeTtlMs,
);
const upstreamStartTimeoutMs = boundedInteger(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_UPSTREAM_START_TIMEOUT_MS,
  30_000,
  5_000,
  60_000,
);
const publicHost = normalizePublicHost(
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_PUBLIC_HOST,
);
const primaryToken = requiredToken(
  "OMNIAGENT_PLAYWRIGHT_MCP_TOKEN",
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_TOKEN,
);
const previousToken = optionalToken(
  "OMNIAGENT_PLAYWRIGHT_MCP_PREVIOUS_TOKEN",
  process.env.OMNIAGENT_PLAYWRIGHT_MCP_PREVIOUS_TOKEN,
);
if (previousToken && tokensEqual(primaryToken, previousToken)) {
  fail("OMNIAGENT_PLAYWRIGHT_MCP_PREVIOUS_TOKEN must differ from the primary token.");
}
const acceptedTokenDigests = [
  digestToken(primaryToken),
  ...(previousToken ? [digestToken(previousToken)] : []),
];
delete process.env.OMNIAGENT_PLAYWRIGHT_MCP_TOKEN;
delete process.env.OMNIAGENT_PLAYWRIGHT_MCP_PREVIOUS_TOKEN;

const blockedAddresses = createBlockedAddressList();
const scopes = new Map();
const scopeDirectories = "/tmp/playwright-mcp/scopes";
const sockets = new Set();
const tunnelSockets = new Set();
let activeRequests = 0;
let shuttingDown = false;
let scopeCreationQueue = Promise.resolve();

await mkdir(scopeDirectories, { recursive: true, mode: 0o700 });

const egressProxy = createServer((request, response) => {
  void proxyPlainHttpRequest(request, response).catch((error) => {
    if (!response.headersSent && !response.destroyed) {
      writeJson(response, error instanceof NetworkPolicyError ? error.status : 502, {
        error: error instanceof NetworkPolicyError
          ? "Browser destination is not allowed."
          : "Browser network request failed.",
      });
    } else if (!response.destroyed) {
      response.destroy();
    }
  });
});
egressProxy.on("connect", (request, clientSocket, head) => {
  void proxyConnectRequest(request, clientSocket, head).catch((error) => {
    rejectTunnel(
      clientSocket,
      error instanceof NetworkPolicyError ? error.status : 502,
    );
  });
});
configureHttpServer(egressProxy);
trackServerSockets(egressProxy);

const gateway = createServer((request, response) => {
  void handleGatewayRequest(request, response).catch((error) => {
    request.resume();
    if (!response.headersSent && !response.destroyed) {
      if (error instanceof GatewayCapacityError) {
        writeJson(response, 503, { error: error.message }, { "retry-after": "5" });
      } else if (error instanceof GatewayRequestError) {
        writeJson(response, error.status, { error: error.message });
      } else {
        console.error(JSON.stringify({
          level: "error",
          message: "Browser gateway request failed.",
          error: safeErrorMessage(error),
        }));
        writeJson(response, 502, { error: "Browser gateway request failed." });
      }
    } else if (!response.destroyed) {
      response.destroy();
    }
  });
});
configureHttpServer(gateway);
trackServerSockets(gateway);

await listen(egressProxy, egressProxyPort, LOOPBACK_HOST);
await listen(gateway, listenPort, "0.0.0.0");

const reaper = setInterval(() => {
  void reapExpiredScopes();
}, Math.min(30_000, Math.max(5_000, Math.floor(scopeTtlMs / 2))));
reaper.unref();

process.on("SIGINT", () => void shutdown(0, "SIGINT"));
process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));

console.log(JSON.stringify({
  level: "info",
  message: "OmniAgent Playwright MCP gateway started.",
  port: listenPort,
  region: safeRuntimeValue(process.env.FLY_REGION),
  revision: safeRuntimeValue(process.env.OMNIAGENT_RELEASE_SHA),
  maxConcurrency,
  maxScopes,
  scopeTtlMs,
  scopeReclaimIdleMs,
}));

async function handleGatewayRequest(request, response) {
  const url = requestUrl(request.url);
  if (url.pathname === "/healthz" && request.method === "GET") {
    writeJson(response, shuttingDown ? 503 : 200, {
      status: shuttingDown ? "stopping" : "healthy",
      service: "omniagent-playwright-mcp",
      region: safeRuntimeValue(process.env.FLY_REGION),
      revision: safeRuntimeValue(process.env.OMNIAGENT_RELEASE_SHA),
      protocol: "streamable-http",
    });
    return;
  }

  if (shuttingDown) {
    writeJson(response, 503, { error: "Browser gateway is stopping." }, {
      "retry-after": "1",
    });
    request.resume();
    return;
  }
  if (
    (url.pathname !== MCP_PATH && url.pathname !== `${MCP_PATH}/`) ||
    url.search
  ) {
    writeJson(response, 404, { error: "Not found." });
    request.resume();
    return;
  }
  if (!["GET", "POST", "DELETE"].includes(request.method || "")) {
    writeJson(response, 405, { error: "Method not allowed." }, {
      allow: "GET, POST, DELETE",
    });
    request.resume();
    return;
  }
  if (!requestHostAllowed(request)) {
    writeJson(response, 421, { error: "Misdirected request." });
    request.resume();
    return;
  }
  if (request.headers.origin !== undefined) {
    writeJson(response, 403, { error: "Browser-origin requests are not allowed." });
    request.resume();
    return;
  }

  const token = bearerToken(request);
  if (!token || !tokenMatchesAny(token, acceptedTokenDigests)) {
    writeJson(response, 401, { error: "Authentication required." }, {
      "www-authenticate": "Bearer",
    });
    request.resume();
    return;
  }

  const scopeValue = singleHeader(request, "x-omniagent-browser-scope");
  if (!scopeValue || !SCOPE_PATTERN.test(scopeValue)) {
    writeJson(response, 400, {
      error: "A valid x-omniagent-browser-scope header is required.",
    });
    request.resume();
    return;
  }
  const browserSessionMode = singleHeader(
    request,
    "x-omniagent-browser-session",
  );
  if (
    request.headers["x-omniagent-browser-session"] !== undefined &&
    browserSessionMode !== "run"
  ) {
    writeJson(response, 400, { error: "Invalid browser session mode." });
    request.resume();
    return;
  }

  const requestLength = declaredRequestLength(request);
  if (requestLength.error) {
    writeJson(response, requestLength.status, { error: requestLength.error });
    request.resume();
    return;
  }
  if (activeRequests >= maxConcurrency) {
    writeJson(response, 503, { error: "Browser gateway is at capacity." }, {
      "retry-after": "1",
    });
    request.resume();
    return;
  }

  activeRequests += 1;
  try {
    const requestBody = await readMcpRequestBody(request, requestLength.value);
    const isToolCall = requestBody ? containsToolCall(requestBody) : false;
    const scope = await getOrCreateScope(scopeValue);
    if (isToolCall) scope.hasToolCall = true;
    scope.activeRequests += 1;
    scope.lastUsedAt = Date.now();
    try {
      const upstreamResult = await proxyMcpRequest(
        request,
        response,
        scope.port,
        requestBody,
      );
      if (
        request.method === "DELETE" &&
        upstreamResult.status >= 200 &&
        upstreamResult.status < 300
      ) {
        if (browserSessionMode === "run") {
          scope.retireWhenIdle = true;
          scope.retireReason = "run_session_complete";
        } else if (!scope.hasToolCall) {
          scope.retireWhenIdle = true;
          scope.retireReason = "discovery_complete";
        }
      }
    } finally {
      scope.activeRequests = Math.max(0, scope.activeRequests - 1);
      scope.lastUsedAt = Date.now();
      if (
        scope.retireWhenIdle &&
        scope.activeRequests === 0 &&
        !scope.stopping
      ) {
        await stopScope(scope, scope.retireReason || "session_complete");
      }
    }
  } finally {
    activeRequests -= 1;
  }
}

function getOrCreateScope(scopeValue) {
  const scopeKey = createHash("sha256").update(scopeValue).digest("hex");
  const pending = scopeCreationQueue.then(async () => {
    const existing = scopes.get(scopeKey);
    if (existing && !existing.stopping && !hasChildExited(existing.child)) {
      return existing;
    }

    await makeScopeCapacity();
    if (scopes.size >= maxScopes) {
      throw new GatewayCapacityError();
    }
    const created = await startScope(scopeKey);
    scopes.set(scopeKey, created);
    return created;
  });
  scopeCreationQueue = pending.then(() => undefined, () => undefined);
  return pending;
}

async function makeScopeCapacity() {
  if (scopes.size < maxScopes) return;
  await reapExpiredScopes();
  if (scopes.size < maxScopes) return;

  // A browser run is idle between individual model tool calls. Reclaiming it
  // immediately can erase the active tab while the model is deciding its next
  // action, so only recycle scopes that have been quiet for a meaningful gap.
  const reclaimDeadline = Date.now() - scopeReclaimIdleMs;
  const leastRecentlyUsedIdleScope = [...scopes.values()]
    .filter((scope) =>
      !scope.stopping &&
      scope.activeRequests === 0 &&
      scope.lastUsedAt <= reclaimDeadline
    )
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)[0];
  if (leastRecentlyUsedIdleScope) {
    await stopScope(leastRecentlyUsedIdleScope, "capacity_lru");
  }
}

async function startScope(scopeKey) {
  const scopeDirectory = `${scopeDirectories}/${scopeKey}`;
  const outputDirectory = `${scopeDirectory}/output`;
  const profileDirectory = `${scopeDirectory}/profile`;
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await mkdir(profileDirectory, { recursive: true, mode: 0o700 });
  const port = await reserveLoopbackPort();
  const childEnvironment = { ...process.env };
  delete childEnvironment.OMNIAGENT_PLAYWRIGHT_MCP_TOKEN;
  delete childEnvironment.OMNIAGENT_PLAYWRIGHT_MCP_PREVIOUS_TOKEN;
  childEnvironment.HOME = scopeDirectory;
  // Chromium appends its random ProcessSingleton socket directory to TMPDIR.
  // The full per-scope path exceeds Linux's AF_UNIX limit, while /tmp remains
  // safe because Chromium creates a private mode-0700 directory beneath it.
  childEnvironment.TMPDIR = "/tmp";
  // The gateway owns lifecycle through its per-scope TTL. A keeper MCP session
  // holds the shared persistent context open while short-lived app clients
  // initialize and DELETE their own sessions after each tool call.
  childEnvironment.PLAYWRIGHT_MCP_PING_TIMEOUT_MS = "0";

  const child = spawn(process.execPath, [
    "/app/cli.js",
    "--config",
    "/app/playwright-mcp.config.json",
    "--host",
    LOOPBACK_HOST,
    "--port",
    String(port),
    "--allowed-hosts",
    "127.0.0.1,localhost",
    "--proxy-server",
    `http://${LOOPBACK_HOST}:${egressProxyPort}`,
    "--proxy-bypass",
    "<-loopback>",
    "--user-data-dir",
    profileDirectory,
    "--output-dir",
    outputDirectory,
  ], {
    detached: process.platform !== "win32",
    env: childEnvironment,
    stdio: "ignore",
  });
  const childExit = new Promise((resolve) => {
    child.once("error", () => resolve({ code: null, signal: null }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForPort(port, child, upstreamStartTimeoutMs);
    await openKeeperSession(port);
  } catch (error) {
    signalChildTree(child, "SIGKILL");
    await childExit;
    await rm(scopeDirectory, { recursive: true, force: true });
    throw error;
  }
  if (hasChildExited(child)) {
    await rm(scopeDirectory, { recursive: true, force: true });
    throw new Error("Playwright MCP process exited during startup.");
  }

  const scope = {
    key: scopeKey,
    fingerprint: scopeKey.slice(0, 12),
    directory: scopeDirectory,
    port,
    child,
    childExit,
    activeRequests: 0,
    hasToolCall: false,
    lastUsedAt: Date.now(),
    retireWhenIdle: false,
    retireReason: undefined,
    stopping: false,
  };
  void childExit.then(({ code, signal }) => {
    if (scopes.get(scopeKey) === scope) {
      scopes.delete(scopeKey);
    }
    void rm(scopeDirectory, { recursive: true, force: true });
    if (!scope.stopping && !shuttingDown) {
      console.error(JSON.stringify({
        level: "error",
        message: "Scoped Playwright MCP process exited unexpectedly.",
        scope: scope.fingerprint,
        code,
        signal,
      }));
    }
  });
  return scope;
}

async function openKeeperSession(port) {
  const initializeBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_KEEPER_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "omniagent-playwright-scope-keeper",
        version: "1.0.0",
      },
    },
  });
  const initialized = await internalMcpRequest(port, initializeBody);
  if (initialized.status < 200 || initialized.status >= 300) {
    throw new Error("Unable to initialize the scoped Playwright MCP keeper.");
  }
  const sessionId = singleResponseHeader(initialized.headers, "mcp-session-id");
  if (!sessionId || !/^[\x21-\x7e]{1,256}$/.test(sessionId)) {
    throw new Error("Playwright MCP did not return a valid keeper session.");
  }

  const readyBody = JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const ready = await internalMcpRequest(port, readyBody, sessionId);
  if (ready.status < 200 || ready.status >= 300) {
    throw new Error("Unable to activate the scoped Playwright MCP keeper.");
  }
}

function internalMcpRequest(port, body, sessionId) {
  return new Promise((resolve, reject) => {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-length": Buffer.byteLength(body),
      "content-type": "application/json",
      host: LOOPBACK_HOST,
      "mcp-protocol-version": MCP_KEEPER_PROTOCOL_VERSION,
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const request = httpRequest({
      host: LOOPBACK_HOST,
      port,
      method: "POST",
      path: MCP_PATH,
      headers,
    });
    request.setTimeout(upstreamStartTimeoutMs, () => {
      request.destroy(new Error("Playwright MCP keeper request timed out."));
    });
    request.once("response", (response) => {
      let responseBytes = 0;
      response.on("data", (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_KEEPER_RESPONSE_BYTES) {
          response.destroy(new Error("Playwright MCP keeper response is too large."));
        }
      });
      response.once("end", () => resolve({
        status: response.statusCode || 500,
        headers: response.headers,
      }));
      response.once("error", reject);
    });
    request.once("error", reject);
    request.end(body);
  });
}

function singleResponseHeader(headers, name) {
  const value = headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

async function stopScope(scope, reason) {
  if (scope.stopping) {
    await scope.childExit;
    return;
  }
  scope.stopping = true;
  if (scopes.get(scope.key) === scope) {
    scopes.delete(scope.key);
  }
  signalChildTree(scope.child, "SIGTERM");
  const graceful = await Promise.race([
    scope.childExit.then(() => true),
    delay(CHILD_STOP_GRACE_MS).then(() => false),
  ]);
  if (!graceful && !hasChildExited(scope.child)) {
    signalChildTree(scope.child, "SIGKILL");
    await scope.childExit;
  }
  await rm(scope.directory, { recursive: true, force: true });
  console.log(JSON.stringify({
    level: "info",
    message: "Scoped Playwright MCP process stopped.",
    scope: scope.fingerprint,
    reason,
  }));
}

async function reapExpiredScopes() {
  if (shuttingDown) return;
  const deadline = Date.now() - scopeTtlMs;
  const expired = [...scopes.values()].filter(
    (scope) =>
      !scope.stopping &&
      scope.activeRequests === 0 &&
      scope.lastUsedAt <= deadline,
  );
  await Promise.all(expired.map((scope) => stopScope(scope, "idle_ttl")));
}

function proxyMcpRequest(request, response, upstreamPort, requestBody) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const upstream = httpRequest({
      host: LOOPBACK_HOST,
      port: upstreamPort,
      method: request.method,
      path: MCP_PATH,
      headers: filteredHeaders(request.headers, MCP_REQUEST_HEADERS, {
        // Playwright's DNS-rebinding guard compares the Host header against
        // --allowed-hosts without normalizing the ephemeral upstream port.
        host: LOOPBACK_HOST,
      }),
    });
    upstream.setTimeout(MCP_UPSTREAM_INACTIVITY_MS, () => {
      upstream.destroy(new Error("Playwright MCP request timed out."));
    });
    upstream.once("response", (upstreamResponse) => {
      const upstreamStatus = upstreamResponse.statusCode || 502;
      if (response.destroyed) {
        upstreamResponse.destroy();
        settle({ status: upstreamStatus });
        return;
      }
      response.writeHead(
        upstreamStatus,
        filteredHeaders(upstreamResponse.headers, MCP_RESPONSE_HEADERS),
      );
      upstreamResponse.once("error", () => {
        if (!response.destroyed) response.destroy();
        settle({ status: upstreamStatus });
      });
      response.once("finish", () => settle({ status: upstreamStatus }));
      response.once("close", () => {
        if (!response.writableEnded) upstreamResponse.destroy();
        settle({ status: upstreamStatus });
      });
      upstreamResponse.pipe(response);
    });
    upstream.once("error", () => {
      if (!response.headersSent && !response.destroyed) {
        writeJson(response, 502, { error: "Playwright MCP process is unavailable." });
      } else if (!response.destroyed) {
        response.destroy();
      }
      settle({ status: 502 });
    });
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    if (requestBody) upstream.end(requestBody);
    else upstream.end();
  });
}

function readMcpRequestBody(request, declaredLength) {
  if (request.method !== "POST") {
    request.resume();
    return Promise.resolve(undefined);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    request.on("data", (chunk) => {
      received += chunk.length;
      if (received > MAX_MCP_BODY_BYTES) {
        reject(new GatewayRequestError("MCP request body is too large.", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (received !== declaredLength) {
        reject(new GatewayRequestError("MCP request body length is invalid.", 400));
        return;
      }
      resolve(Buffer.concat(chunks, received));
    });
    request.once("aborted", () => {
      reject(new GatewayRequestError("MCP request was interrupted.", 400));
    });
    request.once("error", reject);
  });
}

function containsToolCall(body) {
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return false;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages.some(
    (message) => message && typeof message === "object" && message.method === "tools/call",
  );
}

async function proxyPlainHttpRequest(request, response) {
  let target;
  try {
    target = new URL(request.url || "");
  } catch {
    throw new NetworkPolicyError("Browser proxy requires an absolute URL.", 400);
  }
  if (
    target.protocol !== "http:" ||
    target.username ||
    target.password ||
    (target.port && target.port !== "80")
  ) {
    throw new NetworkPolicyError("Browser proxy allows plain HTTP only on port 80.");
  }
  const address = await resolvePublicAddress(target.hostname);
  await new Promise((resolve, reject) => {
    const upstream = httpRequest({
      host: address.address,
      family: address.family,
      port: 80,
      method: request.method,
      path: `${target.pathname}${target.search}`,
      headers: proxyHeaders(request.headers, { host: target.host }),
    });
    upstream.once("response", (upstreamResponse) => {
      response.writeHead(
        upstreamResponse.statusCode || 502,
        proxyHeaders(upstreamResponse.headers),
      );
      upstreamResponse.once("error", reject);
      upstreamResponse.once("end", resolve);
      upstreamResponse.once("close", resolve);
      upstreamResponse.pipe(response);
    });
    upstream.once("error", reject);
    request.once("aborted", () => upstream.destroy());
    response.once("close", () => {
      if (!response.writableEnded) upstream.destroy();
    });
    request.pipe(upstream);
  });
}

async function proxyConnectRequest(request, clientSocket, head) {
  const target = parseConnectTarget(request.url);
  const address = await resolvePublicAddress(target.hostname);
  await new Promise((resolve, reject) => {
    let connected = false;
    const upstreamSocket = connectSocket({
      host: address.address,
      family: address.family,
      port: target.port,
    });
    tunnelSockets.add(upstreamSocket);
    upstreamSocket.once("connect", () => {
      connected = true;
      clientSocket.write(
        "HTTP/1.1 200 Connection Established\r\nProxy-Agent: omniagent-browser-gateway\r\n\r\n",
      );
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstreamSocket.once("error", (error) => {
      if (!connected) reject(error);
      else clientSocket.destroy();
    });
    upstreamSocket.once("close", () => {
      tunnelSockets.delete(upstreamSocket);
      resolve();
    });
    clientSocket.once("error", () => upstreamSocket.destroy());
    clientSocket.once("close", () => upstreamSocket.destroy());
  });
}

function parseConnectTarget(authority) {
  if (!authority) {
    throw new NetworkPolicyError("Browser proxy CONNECT target is required.", 400);
  }
  let parsed;
  try {
    parsed = new URL(`http://${authority}`);
  } catch {
    throw new NetworkPolicyError("Browser proxy CONNECT target is invalid.", 400);
  }
  const port = Number(parsed.port);
  if (
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    port !== 443
  ) {
    throw new NetworkPolicyError("Browser proxy allows CONNECT only to port 443.");
  }
  return { hostname: parsed.hostname, port };
}

async function resolvePublicAddress(value) {
  const hostname = normalizeHostname(value);
  if (isBlockedHostname(hostname)) {
    throw new NetworkPolicyError("Browser destination hostname is blocked.");
  }
  if (isIP(hostname)) {
    if (isPrivateIpAddress(hostname)) {
      throw new NetworkPolicyError("Browser destination address is blocked.");
    }
    return { address: hostname, family: isIP(hostname) };
  }
  let addresses;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new NetworkPolicyError("Browser destination could not be resolved.", 502);
  }
  if (!addresses.length || addresses.some((address) => isPrivateIpAddress(address.address))) {
    throw new NetworkPolicyError("Browser destination resolved to a blocked address.");
  }
  return addresses.toSorted(
    (left, right) => (left.family === 4 ? 0 : 1) - (right.family === 4 ? 0 : 1),
  )[0];
}

function createBlockedAddressList() {
  const list = new BlockList();
  for (const [network, prefix] of [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 3],
  ]) {
    list.addSubnet(network, prefix, "ipv4");
  }
  // node:net BlockList applies the IPv4 subnet rules above to IPv4-mapped
  // IPv6 addresses too. Blocking ::ffff:0:0/96 here would therefore also
  // classify every ordinary public IPv4 destination as private.
  for (const [network, prefix] of [
    ["::", 96],
    ["::1", 128],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["ff00::", 8],
  ]) {
    list.addSubnet(network, prefix, "ipv6");
  }
  return list;
}

function isPrivateIpAddress(value) {
  const hostname = normalizeHostname(value);
  const family = isIP(hostname);
  if (!family) return true;
  return blockedAddresses.check(hostname, family === 4 ? "ipv4" : "ipv6");
}

function isBlockedHostname(hostname) {
  return (
    hostname === "localhost" ||
    hostname === "metadata" ||
    hostname === "metadata.google.internal" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal")
  );
}

function normalizeHostname(value) {
  const normalized = String(value).trim().toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function requestHostAllowed(request) {
  const host = singleHeader(request, "host")?.toLowerCase();
  return host === publicHost || host === `${publicHost}:443`;
}

function declaredRequestLength(request) {
  if (request.headers["transfer-encoding"] !== undefined) {
    return { status: 400, error: "Chunked MCP requests are not accepted." };
  }
  const raw = singleHeader(request, "content-length");
  if (request.method === "POST" && raw === undefined) {
    return { status: 411, error: "Content-Length is required." };
  }
  if (raw === undefined) return { value: 0 };
  if (!/^\d+$/.test(raw)) {
    return { status: 400, error: "Content-Length is invalid." };
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length) || length > MAX_MCP_BODY_BYTES) {
    return { status: 413, error: "MCP request body is too large." };
  }
  if (request.method === "POST") {
    const contentType = singleHeader(request, "content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
      return { status: 415, error: "MCP requests must use application/json." };
    }
  } else if (length !== 0) {
    return { status: 400, error: "This MCP method does not accept a request body." };
  }
  return { value: length };
}

function bearerToken(request) {
  const authorization = singleHeader(request, "authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length);
  return TOKEN_PATTERN.test(token) ? token : undefined;
}

function tokenMatchesAny(token, digests) {
  const candidate = digestToken(token);
  return digests.some((digest) => timingSafeEqual(candidate, digest));
}

function tokensEqual(left, right) {
  return timingSafeEqual(digestToken(left), digestToken(right));
}

function digestToken(token) {
  return createHash("sha256").update(token).digest();
}

function singleHeader(request, name) {
  const distinct = request.headersDistinct?.[name];
  if (distinct) return distinct.length === 1 ? distinct[0] : undefined;
  const value = request.headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

function filteredHeaders(headers, allowlist, overrides = {}) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (allowlist.has(normalized) && value !== undefined) {
      result[normalized] = value;
    }
  }
  return { ...result, ...overrides };
}

function proxyHeaders(headers, overrides = {}) {
  const result = {};
  const connectionHeaders = new Set(
    String(headers.connection || "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const normalized = name.toLowerCase();
    if (
      !HOP_BY_HOP_HEADERS.has(normalized) &&
      !connectionHeaders.has(normalized) &&
      value !== undefined
    ) {
      result[normalized] = value;
    }
  }
  return { ...result, ...overrides };
}

function rejectTunnel(socket, status) {
  if (socket.destroyed) return;
  const reason = status === 400
    ? "Bad Request"
    : status === 403
      ? "Forbidden"
      : "Bad Gateway";
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function configureHttpServer(server) {
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 100;
}

function trackServerSockets(server) {
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
}

function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const reservation = createServer();
    reservation.once("error", reject);
    reservation.listen(0, LOOPBACK_HOST, () => {
      const address = reservation.address();
      const port = address && typeof address === "object" ? address.port : 0;
      reservation.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Unable to reserve a Playwright MCP port."));
        else resolve(port);
      });
    });
  });
}

async function waitForPort(port, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasChildExited(child)) {
      throw new Error("Playwright MCP process exited before becoming ready.");
    }
    if (await canConnect(port)) return;
    await delay(200);
  }
  throw new Error("Playwright MCP process did not become ready in time.");
}

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = connectSocket({ host: LOOPBACK_HOST, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function hasChildExited(child) {
  return child.pid === undefined || child.exitCode !== null || child.signalCode !== null;
}

function signalChildTree(child, signal) {
  if (hasChildExited(child)) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function shutdown(exitCode, signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reaper);
  console.log(JSON.stringify({
    level: "info",
    message: "OmniAgent Playwright MCP gateway stopping.",
    signal,
  }));
  const forceTimer = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
    for (const socket of tunnelSockets) socket.destroy();
    gateway.closeAllConnections?.();
    egressProxy.closeAllConnections?.();
  }, SHUTDOWN_GRACE_MS);
  forceTimer.unref();
  await Promise.all([
    closeServer(gateway),
    closeServer(egressProxy),
    ...[...scopes.values()].map((scope) => stopScope(scope, "shutdown")),
  ]);
  clearTimeout(forceTimer);
  process.exitCode = exitCode;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function writeJson(response, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function requestUrl(value) {
  try {
    return new URL(value || "/", "http://gateway.invalid");
  } catch {
    return new URL("http://gateway.invalid/invalid");
  }
}

function normalizePublicHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) || !host.includes(".")) {
    fail("OMNIAGENT_PLAYWRIGHT_MCP_PUBLIC_HOST must be a valid hostname.");
  }
  return host;
}

function requiredToken(name, value) {
  const token = String(value || "").trim();
  if (!TOKEN_PATTERN.test(token)) {
    fail(`${name} must contain 32-256 URL-safe characters.`);
  }
  return token;
}

function optionalToken(name, value) {
  const token = String(value || "").trim();
  if (!token) return undefined;
  if (!TOKEN_PATTERN.test(token)) {
    fail(`${name} must contain 32-256 URL-safe characters when configured.`);
  }
  return token;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function safeRuntimeValue(value) {
  return String(value || "unknown").replace(/[^A-Za-z0-9._:-]/g, "").slice(0, 128) || "unknown";
}

function safeErrorMessage(error) {
  const value = error instanceof Error ? error.message : "Unknown internal error.";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 256) || "Unknown internal error.";
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

class NetworkPolicyError extends Error {
  constructor(message, status = 403) {
    super(message);
    this.name = "NetworkPolicyError";
    this.status = status;
  }
}

class GatewayCapacityError extends Error {
  constructor() {
    super("No isolated browser scope is currently available.");
    this.name = "GatewayCapacityError";
  }
}

class GatewayRequestError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GatewayRequestError";
    this.status = status;
  }
}
