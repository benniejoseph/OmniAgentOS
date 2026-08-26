import { writeFile } from "node:fs/promises";
import {
  discardSmokeResponseBody,
  failSmoke,
  getSmokeBaseUrl,
  smokeFetch,
} from "./smoke-helpers.mjs";

const baseUrl = getSmokeBaseUrl();
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const syntheticHeaders = createSyntheticHeaders("security");
const SECURITY_REQUEST_TIMEOUT_MS = 30_000;

const protectedReads = [
  "/api/memory",
  "/api/knowledge",
  "/api/runs",
  "/api/tools",
  "/api/workflows",
  "/api/evaluations",
  "/api/connectors",
  "/api/openapi-connectors",
  "/api/capabilities",
  "/api/observability",
  "/api/operations",
  "/api/approvals",
  "/api/workflows/plan",
  "/api/security/isolation-report",
  "/api/release/evidence",
];

const checks = [];

const publicHealth = await request("/api/health");
let publicHealthBody = {};
try {
  publicHealthBody = await publicHealth.json();
} catch {
  publicHealthBody = {};
}
checks.push(assert(
  publicHealth.status === 200 || publicHealth.status === 503,
  "public health endpoint returns liveness status",
  `expected 200 or 503, got ${publicHealth.status}`,
));
checks.push(assert(
  typeof publicHealthBody.status === "string" &&
    typeof publicHealthBody.checkedAt === "string" &&
    typeof publicHealthBody.requestId === "string" &&
    !("components" in publicHealthBody) &&
    !("metrics" in publicHealthBody) &&
    !("incidents" in publicHealthBody),
  "public health endpoint omits detailed diagnostics",
  "health response exposed components, metrics, incidents, or omitted liveness fields",
));

for (const path of protectedReads) {
  checks.push(await expectStatus(path, { expected: 401, label: `anonymous ${path}` }));
}

const unauthWrite = await request("/api/memory", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ title: "smoke", content: "unauthorized write should fail" }),
});
checks.push(assert(unauthWrite.status === 401, "anonymous memory write is blocked", `expected 401, got ${unauthWrite.status}`));
await discardResponseBody(unauthWrite, "anonymous memory write");

if (email && password) {
  const login = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  checks.push(assert(login.status === 200, "admin login succeeds", `expected 200, got ${login.status}`));

  const setCookie = login.headers.get("set-cookie") || "";
  checks.push(assert(/httponly/i.test(setCookie), "session cookie is HttpOnly", "missing HttpOnly"));
  checks.push(assert(/samesite=lax/i.test(setCookie), "session cookie is SameSite=Lax", "missing SameSite=Lax"));
  if (baseUrl.startsWith("https://") || process.env.EXPECT_SECURE_COOKIES === "true") {
    checks.push(assert(/secure/i.test(setCookie), "session cookie is Secure", "missing Secure"));
  }

  const cookie = setCookie.split(";")[0];
  const sessionOutput = process.env.SMOKE_SESSION_OUTPUT?.trim();
  if (login.status === 200 && cookie && sessionOutput) {
    await writeFile(sessionOutput, `${cookie}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  await discardResponseBody(login, "admin login");
  const authHeaders = {
    "content-type": "application/json",
    cookie,
    origin: baseUrl,
  };
  const validationHeaders = internalSecret
    ? {
        "content-type": "application/json",
        origin: baseUrl,
        "x-omni-internal-auth": internalSecret,
        "x-omni-tenant-id": process.env.SMOKE_TENANT_ID || "production_smoke",
        "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
        "x-omni-user-role": "admin",
      }
    : authHeaders;
  const authenticatedRead = await request("/api/memory?limit=1", { headers: { cookie } });
  checks.push(assert(authenticatedRead.status === 200, "authenticated memory read succeeds", `expected 200, got ${authenticatedRead.status}`));
  await discardResponseBody(authenticatedRead, "authenticated memory read");

  for (const path of ["/api/connectors", "/api/openapi-connectors"]) {
    const catalogue = await request(path, { headers: { cookie } });
    const text = await catalogue.text();
    checks.push(assert(catalogue.status === 200, `authenticated ${path} read succeeds`, `expected 200, got ${catalogue.status}`));
    checks.push(assert(
      !/(OPENAI_API_KEY|DATABASE_URL|OMNIAGENT_CONNECTOR_[A-Z0-9_]+)/.test(text),
      `${path} redacts connector secret env names`,
      "raw connector secret env name leaked",
    ));
  }

  const observabilityRead = await request("/api/observability?limit=5", { headers: { cookie } });
  checks.push(assert(
    observabilityRead.status === 200 || observabilityRead.status === 403,
    "authenticated observability read is protected",
    `expected 200 or 403, got ${observabilityRead.status}`,
  ));
  await discardResponseBody(observabilityRead, "authenticated observability read");

  const forbiddenSecret = await request("/api/connectors", {
    method: "POST",
    headers: validationHeaders,
    body: JSON.stringify({
      name: "Smoke forbidden secret",
      endpoint: "https://example.com/mcp",
      authType: "bearer_env",
      authTokenEnv: "OPENAI_API_KEY",
      discover: false,
    }),
  });
  checks.push(assert(forbiddenSecret.status === 400, "connector cannot reference platform secrets", `expected 400, got ${forbiddenSecret.status}`));
  await discardResponseBody(forbiddenSecret, "forbidden connector secret");

  const privateEndpoint = await request("/api/connectors", {
    method: "POST",
    headers: validationHeaders,
    body: JSON.stringify({
      name: "Smoke private endpoint",
      endpoint: "http://127.0.0.1:9999/mcp",
      authType: "none",
      discover: false,
    }),
  });
  checks.push(assert(privateEndpoint.status === 400, "connector blocks private endpoints", `expected 400, got ${privateEndpoint.status}`));
  await discardResponseBody(privateEndpoint, "private connector endpoint");
} else if (internalSecret) {
  const internalHeaders = {
    "content-type": "application/json",
    origin: baseUrl,
    "x-omni-internal-auth": internalSecret,
    "x-omni-tenant-id": process.env.SMOKE_TENANT_ID || "production_smoke",
    "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
    "x-omni-user-role": "admin",
  };
  const authenticatedRead = await request("/api/memory?limit=1", { headers: internalHeaders });
  checks.push(assert(authenticatedRead.status === 200, "internal authenticated memory read succeeds", `expected 200, got ${authenticatedRead.status}`));
  await discardResponseBody(authenticatedRead, "internal authenticated memory read");
  for (const path of ["/api/connectors", "/api/openapi-connectors"]) {
    const catalogue = await request(path, { headers: internalHeaders });
    const text = await catalogue.text();
    checks.push(assert(catalogue.status === 200, `internal authenticated ${path} read succeeds`, `expected 200, got ${catalogue.status}`));
    checks.push(assert(
      !/(OPENAI_API_KEY|DATABASE_URL|OMNIAGENT_CONNECTOR_[A-Z0-9_]+)/.test(text),
      `${path} redacts connector secret env names`,
      "raw connector secret env name leaked",
    ));
  }
  const forbiddenSecret = await request("/api/connectors", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({
      name: "Smoke forbidden secret",
      endpoint: "https://example.com/mcp",
      authType: "bearer_env",
      authTokenEnv: "OPENAI_API_KEY",
      discover: false,
    }),
  });
  checks.push(assert(forbiddenSecret.status === 400, "connector cannot reference platform secrets", `expected 400, got ${forbiddenSecret.status}`));
  await discardResponseBody(forbiddenSecret, "forbidden connector secret");
  const privateEndpoint = await request("/api/connectors", {
    method: "POST",
    headers: internalHeaders,
    body: JSON.stringify({ name: "Smoke private endpoint", endpoint: "http://127.0.0.1:9999/mcp", authType: "none", discover: false }),
  });
  checks.push(assert(privateEndpoint.status === 400, "connector blocks private endpoints", `expected 400, got ${privateEndpoint.status}`));
  await discardResponseBody(privateEndpoint, "private connector endpoint");
} else {
  checks.push({
    ok: false,
    label: "authenticated smoke credentials are configured",
    detail: "set both SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD",
  });
}

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
}

if (failures.length) {
  process.exitCode = 1;
}

async function expectStatus(path, { expected, label }) {
  const response = await request(path);
  const result = assert(response.status === expected, label, `expected ${expected}, got ${response.status}`);
  await discardResponseBody(response, label);
  return result;
}

async function discardResponseBody(response, label) {
  try {
    await discardSmokeResponseBody(response, { label });
  } catch (error) {
    failSmoke(
      error instanceof Error
        ? error.message
        : `${label} response body could not be consumed.`,
    );
  }
}

async function request(path, init) {
  const method = String(init?.method || "GET").toUpperCase();
  try {
    return await smokeFetch(baseUrl, path, {
      ...init,
      timeoutMs: SECURITY_REQUEST_TIMEOUT_MS,
      retryTransport: method === "GET" || method === "HEAD",
      headers: {
        ...syntheticHeaders,
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    failSmoke(error instanceof Error ? error.message : `request failed for ${path}`);
  }
}

function assert(ok, label, detail) {
  return { ok, label, detail: ok ? undefined : detail };
}

function createSyntheticHeaders(scope) {
  if (!internalSecret) {
    return {};
  }

  const runId = process.env.SMOKE_RUN_ID || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    "x-omni-synthetic-auth": internalSecret,
    "x-omni-synthetic-source": process.env.SMOKE_SYNTHETIC_SOURCE || "production-smoke",
    "x-omni-slo-excluded": "true",
    "x-omni-correlation-id": `production-smoke:${scope}:${runId}`,
  };
}
