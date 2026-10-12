import {
  failSmoke,
  getSmokeBaseUrl,
  positiveInteger,
  releaseErrorBudgetException,
  smokeFetch,
} from "./smoke-helpers.mjs";
import {
  isSafeReleaseErrorBudgetException,
  selectedErrorBudgetProof,
} from "./release-error-budget-scope.mjs";
import {
  ownerBudgetOverrideEvidence,
  readOwnerBudgetOverride,
} from "./release-owner-budget-override.mjs";

const baseUrl = getSmokeBaseUrl();
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const checks = [];
const syntheticHeaders = createSyntheticHeaders("release");
// The runner uses this only before replacing the currently deployed release.
// A CLI argument cannot carry over to staged, canonical, or scheduled checks.
const previousRelease = process.argv.slice(2).includes("--previous-release");

await clearReleaseEvidenceArtifact();
const headers = await resolveAuthHeaders();

if (!headers) {
  for (const check of checks) {
    console.error(`FAIL ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  failSmoke("release evidence smoke requires valid administrator credentials or SMOKE_INTERNAL_AUTH_SECRET.");
}

const evidenceQuery = new URLSearchParams({ refresh: "true" });
if (process.env.OMNIAGENT_REQUIRE_ACTIVE_WORKER_HEARTBEATS === "true") {
  const notBefore = process.env.OMNIAGENT_WORKER_HEARTBEAT_NOT_BEFORE?.trim();
  const notBeforeMs = notBefore ? Date.parse(notBefore) : Number.NaN;
  if (!notBefore || notBefore.length > 80 || !Number.isFinite(notBeforeMs)) {
    failSmoke(
      "active worker evidence requires a valid OMNIAGENT_WORKER_HEARTBEAT_NOT_BEFORE timestamp.",
    );
  }
  evidenceQuery.set("requireActiveWorker", "true");
  evidenceQuery.set(
    "workerHeartbeatNotBefore",
    new Date(notBeforeMs).toISOString(),
  );
}
let errorBudgetException;
let ownerBudgetPin;
try {
  errorBudgetException = releaseErrorBudgetException();
  ownerBudgetPin = readOwnerBudgetOverride();
} catch (error) {
  failSmoke(error instanceof Error ? error.message : "invalid error budget exception");
}
if (errorBudgetException) {
  // A release that is the fix ships while the error budget is spent.
  evidenceQuery.set("errorBudgetException", errorBudgetException);
}
const response = await request(
  `/api/release/evidence?${evidenceQuery.toString()}`,
  { headers },
);
const json = await readJson(response);
const report = json?.report;
const gateById = new Map((report?.gates || []).map((gate) => [gate.id, gate]));
const previousReleaseWithoutErrorBudget = previousRelease && !gateById.has("agent_error_budget");
const ownerBudgetEvidence = ownerBudgetOverrideEvidence(report, ownerBudgetPin, previousRelease);
const ownerBudgetApplied = ownerBudgetEvidence?.applied === true;
const expectedSyntheticTenant = internalSecret
  ? process.env.SMOKE_TENANT_ID || "production_smoke"
  : undefined;

checks.push(assert(response.status === 200, "release evidence endpoint returns report", statusDetail(response.status, json)));
checks.push(assert(Boolean(report), "release evidence report is present", "missing report"));
checks.push(assert(
  boundedIdentity(report?.tenantId) !== null &&
    (!expectedSyntheticTenant || report.tenantId === expectedSyntheticTenant),
  "release evidence tenant matches request scope",
  "missing or mismatched tenant identifier",
));
checks.push(assert(report?.releaseGate?.approved === true || ownerBudgetApplied, ownerBudgetApplied ? "owner authorized the measured reliability exception" : "release gate is approved", releaseGateDetail(report)));
checks.push(assert(report?.releaseGate?.status === "passed" || ownerBudgetApplied, ownerBudgetApplied ? "all other release gates fully pass" : "release gate is fully passed", releaseGateDetail(report)));
checks.push(assert(gateById.get("tenant_isolation_database")?.status === "pass", "database tenant isolation gate passes", gateDetail(gateById.get("tenant_isolation_database"))));
checks.push(assert(gateById.get("latest_tenant_isolation_eval")?.status === "pass", "tenant isolation eval gate passes", gateDetail(gateById.get("latest_tenant_isolation_eval"))));
checks.push(assert(gateById.get("internal_smoke_auth")?.status === "pass", "internal smoke auth gate passes", gateDetail(gateById.get("internal_smoke_auth"))));
checks.push(assert(gateById.get("openai_provider")?.status === "pass", "OpenAI provider gate passes", gateDetail(gateById.get("openai_provider"))));
checks.push(assert(gateById.get("cron_auth")?.status === "pass", "cron authentication gate passes", gateDetail(gateById.get("cron_auth"))));
checks.push(assert(gateById.get("runtime_database_role")?.status === "pass", "runtime database role gate passes", gateDetail(gateById.get("runtime_database_role"))));
checks.push(assert(gateById.get("dedicated_worker")?.status === "pass", "dedicated worker revision and heartbeat gate passes", gateDetail(gateById.get("dedicated_worker"))));
checks.push(assert(gateById.get("observability_slo")?.status === "pass", "observability SLO gate passes", gateDetail(gateById.get("observability_slo"))));
checks.push(previousReleaseWithoutErrorBudget
  ? assert(true, "previous release predates the agent error budget gate")
  : assert(gateById.get("agent_error_budget")?.status === "pass" || ownerBudgetApplied, ownerBudgetApplied ? "measured error budget covered by recorded owner exception" : "agent error budget gate passes", gateDetail(gateById.get("agent_error_budget"))));
if (ownerBudgetPin) {
  checks.push(assert(Boolean(ownerBudgetEvidence), "owner reliability exception matches this release and only measured error budgets", "revision, expiry, telemetry, or other release gates did not match"));
}
checks.push(assert(
  isSafeReleaseErrorBudgetException(gateById.get("agent_error_budget"), errorBudgetException),
  "agent error budget exception has measured agent-run-only scope",
  "missing or changed objective evidence",
));
checks.push(assert(gateById.get("eval_report_signing")?.status === "pass", "eval report signing gate passes", gateDetail(gateById.get("eval_report_signing"))));
checks.push(report
  ? assert(await writeReleaseEvidenceArtifact(report, response.status), "release evidence artifact is present and bounded", "artifact validation failed")
  : assert(false, "release evidence artifact is present and bounded", "report was missing, so no artifact was written"));

const failures = checks.filter((check) => !check.ok);
for (const check of checks) {
  const prefix = check.ok ? "PASS" : "FAIL";
  console.log(`${prefix} ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
}

if (failures.length) {
  process.exitCode = 1;
}

async function resolveAuthHeaders() {
  if (internalSecret) {
    return {
      ...syntheticHeaders,
      "x-omni-internal-auth": internalSecret,
      "x-omni-tenant-id": process.env.SMOKE_TENANT_ID || "production_smoke",
      "x-omni-user-id": process.env.SMOKE_ACTOR_ID || "production-smoke",
      "x-omni-user-role": "admin",
    };
  }

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

  return undefined;
}

async function request(path, init) {
  try {
    return await smokeFetch(baseUrl, path, {
      ...init,
      headers: {
        ...syntheticHeaders,
        ...(init?.headers || {}),
      },
    });
  } catch (error) {
    failSmoke(error instanceof Error ? error.message : `request failed for ${path}`);
  }
}

async function clearReleaseEvidenceArtifact() {
  const outputPath = process.env.RELEASE_EVIDENCE_OUTPUT?.trim();
  if (!outputPath) {
    failSmoke("RELEASE_EVIDENCE_OUTPUT is required for the release evidence gate.");
  }
  const { rm } = await import("node:fs/promises");
  await rm(outputPath, { force: true });
}

async function writeReleaseEvidenceArtifact(report, httpStatus) {
  const outputPath = process.env.RELEASE_EVIDENCE_OUTPUT?.trim();
  if (!outputPath) {
    failSmoke("RELEASE_EVIDENCE_OUTPUT is required for the release evidence gate.");
  }

  const maxBytes = positiveInteger(
    process.env.RELEASE_EVIDENCE_MAX_BYTES,
    262_144,
    1_048_576,
  );
  const [{ mkdir, stat, writeFile }, { dirname }] = await Promise.all([
    import("node:fs/promises"),
    import("node:path"),
  ]);
  const content = `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    httpStatus,
    reportCheckedAt: report.checkedAt,
    baseUrl,
    tenantId: boundedIdentity(report.tenantId),
    smokeRunId: process.env.SMOKE_RUN_ID,
    ...(previousReleaseWithoutErrorBudget
      ? { previousReleaseCompatibility: { missingAgentErrorBudget: true } }
      : {}),
    // Preserve measured evidence even when this owner pin cannot independently
    // admit the blocked report. The paired runner may validate a separate,
    // exact forward-schema gap; this smoke still fails and never waives it.
    ...(errorBudgetException || ownerBudgetPin
      ? { errorBudgetProof: selectedErrorBudgetProof(gateById.get("agent_error_budget")) }
      : {}),
    ...(ownerBudgetEvidence ? { ownerErrorBudgetOverride: ownerBudgetEvidence } : {}),
    releaseGate: {
      ...report.releaseGate,
      reasons: limitStrings(report.releaseGate?.reasons),
      warnings: limitStrings(report.releaseGate?.warnings),
    },
    deployment: report.deployment,
    gates: (report.gates || []).slice(0, 50).map((gate) => ({
      id: gate.id,
      name: gate.name,
      status: gate.status,
      summary: limitText(gate.summary),
    })),
    tenantIsolationStatus: report.tenantIsolation?.status,
    tenantIsolation: report.tenantIsolation?.summary,
    observability: {
      ...report.observability,
      breaches: (report.observability?.breaches || []).slice(0, 25),
    },
    recommendations: limitStrings(report.recommendations),
  }, null, 2)}\n`;
  const bytes = Buffer.byteLength(content);
  if (bytes > maxBytes) {
    failSmoke(`release evidence artifact is ${bytes} bytes, above the ${maxBytes}-byte limit.`);
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content, { mode: 0o600 });
  const artifact = await stat(outputPath);
  return artifact.isFile() && artifact.size > 0 && artifact.size <= maxBytes;
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

function limitStrings(values) {
  return (values || []).slice(0, 25).map((value) => limitText(value));
}

function limitText(value) {
  return String(value || "").slice(0, 2_000);
}

function boundedIdentity(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
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
