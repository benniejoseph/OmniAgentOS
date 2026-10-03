import { randomUUID } from "node:crypto";

const productionOrigin = "https://asael.bennierichard.com";
const stagedOriginPattern =
  /^https:\/\/omniagent-[a-z0-9]+-benniejosephs-projects\.vercel\.app$/;

// Credentials go only to an explicit canonical release origin or a local
// development server. Redirects are never followed by the session client.
export function operatorTarget(value, { allowLoopback = false, productionOnly = false } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("BASE_URL must be a valid absolute URL.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const allowed = (allowLoopback && local && url.protocol === "http:") ||
    (url.protocol === "https:" && (url.origin === productionOrigin ||
      (!productionOnly && stagedOriginPattern.test(url.origin))));
  if (!allowed || (value !== url.origin && value !== `${url.origin}/`) ||
    url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("BASE_URL is not an approved Asael operator target.");
  }
  return { baseUrl: url.origin, origin: local ? url.origin : productionOrigin };
}

export function requiredEnvironment(env, name, { preserveWhitespace = false } = {}) {
  const value = env[name] || "";
  if (!value.trim()) throw new Error(`${name} is required.`);
  return preserveWhitespace ? value : value.trim();
}

// This is a browser session client, not an internal-identity client. Synthetic
// headers label telemetry only; tenant and actor assertions cannot choose scope.
export function createOperatorSession({
  baseUrl,
  origin,
  email,
  password,
  expectedTenantId,
  expectedActorId,
  syntheticSecret = "",
  syntheticSource,
  bypassSecret = "",
}) {
  let sessionCookie = "";
  const sessionTokens = [];

  function safeText(value) {
    let redacted = String(value)
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[redacted-api-key]");
    for (const secret of [syntheticSecret, bypassSecret, password, ...sessionTokens]) {
      if (secret) redacted = redacted.replaceAll(secret, "[redacted-secret]");
    }
    for (const identity of [email, expectedActorId, expectedTenantId]) {
      if (identity) {
        redacted = redacted.replace(
          new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
          "[redacted-account]",
        );
      }
    }
    return redacted.replace(/[\u0000-\u001f\u007f<>]/g, " ").slice(0, 500);
  }

  async function rawRequest(requestPath, options = {}) {
    const method = options.method || "GET";
    const headers = new Headers(options.headers);
    headers.set("accept", options.accept || "application/json");
    headers.set("origin", origin);
    if (sessionCookie) headers.set("cookie", sessionCookie);
    if (syntheticSecret) {
      headers.set("x-omni-synthetic-auth", syntheticSecret);
      headers.set("x-omni-synthetic-source", syntheticSource);
      headers.set("x-omni-slo-excluded", "true");
    }
    if (bypassSecret) headers.set("x-vercel-protection-bypass", bypassSecret);
    if (options.body !== undefined) headers.set("content-type", "application/json");
    if (method !== "GET" && !headers.has("idempotency-key")) {
      headers.set("idempotency-key", randomUUID());
    }
    return fetch(`${baseUrl}${requestPath}`, {
      method,
      headers,
      body: options.body === undefined ? undefined :
        typeof options.body === "string" ? options.body : JSON.stringify(options.body),
      cache: "no-store",
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs || 30_000),
    });
  }

  async function jsonRequest(requestPath, options = {}, expectedStatus = 200) {
    const response = await rawRequest(requestPath, options);
    const text = await readTextLimited(response, 2_000_000);
    assert(response.status === expectedStatus,
      `${options.method || "GET"} ${requestPath} expected HTTP ${expectedStatus}, received ${response.status}.`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`${requestPath} returned invalid JSON.`);
    }
  }

  async function signIn() {
    const response = await rawRequest("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    const cookies = response.headers.getSetCookie()
      .map((value) => value.split(";")[0].trim())
      .filter((value) => /^(?:__Host-asael_session|asael_session)=\S+$/.test(value));
    // Capture before checking status/body, so an invalid login reply still
    // has its newly issued session signed out in the caller's finally block.
    sessionCookie = cookies.join("; ");
    sessionTokens.push(...cookies.map((pair) => pair.slice(pair.indexOf("=") + 1)));
    const text = await readTextLimited(response, 100_000);
    assert(response.status === 200, `Sign-in returned HTTP ${response.status}.`);
    assert(sessionCookie, "Sign-in returned no session cookie.");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("Sign-in returned invalid JSON.");
    }
    assert(body.authenticated === true && body.context?.source === "session",
      "Sign-in did not open a browser session.");
    assert(typeof body.context.tenantId === "string" && body.context.tenantId,
      "Sign-in returned no tenant.");
    assert(typeof body.context.actorId === "string" && body.context.actorId,
      "Sign-in returned no actor.");
    assert(!expectedTenantId || body.context.tenantId === expectedTenantId,
      "Signed-in tenant does not match the expected tenant.");
    assert(!expectedActorId || body.context.actorId === expectedActorId,
      "Signed-in actor does not match the expected actor.");
    return { tenantId: body.context.tenantId, actorId: body.context.actorId };
  }

  async function signOut() {
    if (!sessionCookie) return;
    const body = await jsonRequest("/api/auth/logout", { method: "POST" });
    assert(body.authenticated === false, "Sign-out did not end the session.");
    sessionCookie = "";
  }

  return { rawRequest, jsonRequest, signIn, signOut, safeText };
}

export async function readTextLimited(response, maxBytes) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Verification response exceeded the safe size limit.");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}
