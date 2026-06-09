const baseUrl = normalizeBaseUrl(process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "http://127.0.0.1:3000");
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const checks = [];
const syntheticHeaders = createSyntheticHeaders("release");

const headers = await resolveAuthHeaders();

if (!headers) {
  console.log("PASS release evidence smoke skipped - set SMOKE_ADMIN_EMAIL/SMOKE_ADMIN_PASSWORD or SMOKE_INTERNAL_AUTH_SECRET");
  process.exit(0);
}

const response = await request("/api/release/evidence", { headers });
const json = await readJson(response);
const report = json?.report;
const gateById = new Map((report?.gates || []).map((gate) => [gate.id, gate]));
await writeReleaseEvidenceArtifact(report);

checks.push(assert(response.status === 200, "release evidence endpoint returns report", statusDetail(response.status, json)));
checks.push(assert(Boolean(report), "release evidence report is present", "missing report"));
checks.push(assert(report?.releaseGate?.approved === true, "release gate is approved", releaseGateDetail(report)));
checks.push(assert(report?.releaseGate?.status === "passed", "release gate is fully passed", releaseGateDetail(report)));
checks.push(assert(gateById.get("tenant_isolation_database")?.status === "pass", "database tenant isolation gate passes", gateDetail(gateById.get("tenant_isolation_database"))));
checks.push(assert(gateById.get("latest_tenant_isolation_eval")?.status === "pass", "tenant isolation eval gate passes", gateDetail(gateById.get("latest_tenant_isolation_eval"))));
checks.push(assert(gateById.get("internal_smoke_auth")?.status === "pass", "internal smoke auth gate passes", gateDetail(gateById.get("internal_smoke_auth"))));
checks.push(assert(gateById.get("observability_slo")?.status === "pass", "observability SLO gate passes", gateDetail(gateById.get("observability_slo"))));
checks.push(assert(gateById.get("eval_report_signing")?.status === "pass", "eval report signing gate passes", gateDetail(gateById.get("eval_report_signing"))));

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
    return cookie ? { cookie, ...syntheticHeaders } : undefined;
  }

  if (internalSecret) {
    return {
      ...syntheticHeaders,
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
    headers: {
      ...syntheticHeaders,
      ...(init?.headers || {}),
    },
  });
}

async function writeReleaseEvidenceArtifact(report) {
  const outputPath = process.env.RELEASE_EVIDENCE_OUTPUT;
  if (!outputPath) {
    return;
  }

  const [{ mkdir, writeFile }, { dirname }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({
      generatedAt: new Date().toISOString(),
      baseUrl,
      smokeRunId: process.env.SMOKE_RUN_ID,
      releaseGate: report?.releaseGate,
      deployment: report?.deployment,
      gates: report?.gates,
      tenantIsolation: report?.tenantIsolation?.summary,
      observability: report?.observability,
      recommendations: report?.recommendations,
    }, null, 2)}\n`,
  );
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function releaseGateDetail(report) {
  const reasons = report?.releaseGate?.reasons || [];
  const warnings = report?.releaseGate?.warnings || [];
  return `status ${report?.releaseGate?.status || "missing"}${reasons.length ? `; reasons: ${reasons.join(" | ")}` : ""}${warnings.length ? `; warnings: ${warnings.join(" | ")}` : ""}`;
}

function gateDetail(gate) {
  return gate ? `${gate.status}: ${gate.summary}` : "missing gate";
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
