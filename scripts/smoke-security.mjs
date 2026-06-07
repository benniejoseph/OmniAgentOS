const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000");
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;

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
  const authHeaders = { "content-type": "application/json", cookie };
  const authenticatedRead = await request("/api/memory?limit=1", { headers: { cookie } });
  checks.push(assert(authenticatedRead.status === 200, "authenticated memory read succeeds", `expected 200, got ${authenticatedRead.status}`));

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

  const forbiddenSecret = await request("/api/connectors", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "Smoke forbidden secret",
      endpoint: "https://example.com/mcp",
      authType: "bearer_env",
      authTokenEnv: "OPENAI_API_KEY",
      discover: false,
    }),
  });
  checks.push(assert(forbiddenSecret.status === 400, "connector cannot reference platform secrets", `expected 400, got ${forbiddenSecret.status}`));

  const privateEndpoint = await request("/api/connectors", {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      name: "Smoke private endpoint",
      endpoint: "http://127.0.0.1:9999/mcp",
      authType: "none",
      discover: false,
    }),
  });
  checks.push(assert(privateEndpoint.status === 400, "connector blocks private endpoints", `expected 400, got ${privateEndpoint.status}`));
} else {
  checks.push({ ok: true, label: "authenticated smoke skipped", detail: "set SMOKE_ADMIN_EMAIL and SMOKE_ADMIN_PASSWORD to enable authenticated checks" });
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
  return assert(response.status === expected, label, `expected ${expected}, got ${response.status}`);
}

async function request(path, init) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
  });
}

function assert(ok, label, detail) {
  return { ok, label, detail: ok ? undefined : detail };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
