const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000");
const caseId = process.env.SMOKE_EVAL_CASE_ID || "security.tenant_isolation";
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;

const checks = [];
const headers = await resolveAuthHeaders();

if (!headers) {
  console.log("PASS evaluation smoke skipped - set SMOKE_ADMIN_EMAIL/SMOKE_ADMIN_PASSWORD or SMOKE_INTERNAL_AUTH_SECRET");
  process.exit(0);
}

const response = await request("/api/evaluations", {
  method: "POST",
  headers: {
    ...headers,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    suite: "production-smoke",
    caseIds: [caseId],
    allowMutation: true,
    reason: `Automated production smoke validation for ${caseId}.`,
  }),
});
const json = await readJson(response);
const result = Array.isArray(json?.results)
  ? json.results.find((item) => item.caseId === caseId)
  : undefined;

checks.push(assert(response.status === 201, "evaluation run accepted", statusDetail(response.status, json)));
checks.push(assert(json?.run?.status === "completed", "evaluation run completed", `expected completed, got ${json?.run?.status}`));
checks.push(assert(Boolean(result), `${caseId} result returned`, "missing evaluation result"));
checks.push(assert(result?.status === "pass", `${caseId} passed`, `expected pass, got ${result?.status || "missing"}`));

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
}

if (failures.length) {
  process.exitCode = 1;
}

async function resolveAuthHeaders() {
  if (email && password) {
    const login = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const json = await readJson(login);
    checks.push(assert(login.status === 200, "admin login succeeds", statusDetail(login.status, json)));
    if (login.status !== 200) {
      return undefined;
    }
    const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
    checks.push(assert(Boolean(cookie), "session cookie returned", "missing session cookie"));
    return cookie ? { cookie } : undefined;
  }

  if (internalSecret) {
    return {
      "x-omni-internal-auth": internalSecret,
      "x-omni-tenant-id": process.env.SMOKE_TENANT_ID || "production_smoke",
      "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
      "x-omni-user-role": "admin",
    };
  }

  return undefined;
}

async function request(path, init) {
  return fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function statusDetail(status, json) {
  return `status ${status}${json?.error ? `: ${json.error}` : ""}${json?.message ? ` (${json.message})` : ""}`;
}

function assert(ok, label, detail) {
  return { ok, label, detail: ok ? undefined : detail };
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}
