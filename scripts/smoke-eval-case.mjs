import { failSmoke, getSmokeBaseUrl, smokeFetch } from "./smoke-helpers.mjs";

const baseUrl = getSmokeBaseUrl();
const caseId = process.env.SMOKE_EVAL_CASE_ID || "security.tenant_isolation";
const email = process.env.SMOKE_ADMIN_EMAIL || process.env.OMNIAGENT_BOOTSTRAP_EMAIL;
const password = process.env.SMOKE_ADMIN_PASSWORD || process.env.OMNIAGENT_BOOTSTRAP_PASSWORD;
const internalSecret = process.env.SMOKE_INTERNAL_AUTH_SECRET || process.env.OMNIAGENT_INTERNAL_AUTH_SECRET;
const cronSecret = process.env.SMOKE_CRON_SECRET || process.env.CRON_SECRET;
const syntheticHeaders = createSyntheticHeaders("eval");
const evaluationRequestId =
  process.env.SMOKE_RUN_ID ||
  `production-smoke-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const evaluationTimeoutMs = Math.min(
  Math.max(Number(process.env.SMOKE_EVAL_TIMEOUT_MS) || 240_000, 10_000),
  300_000,
);

const checks = [];
const headers = await resolveAuthHeaders();

if (!headers) {
  for (const check of checks) {
    console.error(`FAIL ${check.label}${check.detail ? ` - ${check.detail}` : ""}`);
  }
  failSmoke("evaluation smoke requires valid administrator credentials or SMOKE_INTERNAL_AUTH_SECRET.");
}

const response = await request("/api/evaluations", {
  method: "POST",
  headers: {
    ...headers,
    "content-type": "application/json",
    "idempotency-key": evaluationRequestId,
  },
  body: JSON.stringify({
    suite: "production-smoke",
    caseIds: [caseId],
    allowMutation: true,
    reason: `Automated production smoke validation for ${caseId}.`,
  }),
});
const json = await readJson(response);
checks.push(assert(response.status === 202, "evaluation run accepted", statusDetail(response.status, json)));
const jobId = json?.job?.id;
checks.push(assert(Boolean(jobId), "evaluation job returned", "missing evaluation job id"));
if (jobId && process.env.SMOKE_DRIVE_BACKGROUND_QUEUE === "true") {
  await driveBackgroundQueue();
}
const job = jobId
  ? await waitForEvaluationJob(
      response.headers.get("location") || `/api/operations/jobs/${jobId}`,
    )
  : undefined;
checks.push(assert(
  job?.status === "completed",
  "evaluation job completed",
  `expected completed, got ${job?.status || "missing"}${job?.lastError ? `: ${job.lastError}` : ""}`,
));
const evaluationRunId = job?.result?.evaluationRunId;
checks.push(assert(
  Boolean(evaluationRunId),
  "evaluation run linked",
  "completed job did not expose an evaluation run id",
));
const detailResponse = evaluationRunId
  ? await request(`/api/evaluations/${encodeURIComponent(evaluationRunId)}`, {
      headers,
    })
  : undefined;
const detail = detailResponse ? await readJson(detailResponse) : undefined;
const result = Array.isArray(detail?.results)
  ? detail.results.find((item) => item.caseId === caseId)
  : undefined;
checks.push(assert(
  detailResponse?.status === 200,
  "evaluation evidence loaded",
  detailResponse
    ? statusDetail(detailResponse.status, detail)
    : "evaluation run id unavailable",
));
checks.push(assert(detail?.run?.status === "completed", "evaluation run completed", `expected completed, got ${detail?.run?.status}`));
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
    return cookie ? { cookie, origin: baseUrl, ...syntheticHeaders } : undefined;
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

async function waitForEvaluationJob(path) {
  const deadline = Date.now() + evaluationTimeoutMs;
  let latest;
  while (Date.now() < deadline) {
    const response = await request(path, { headers });
    const json = await readJson(response);
    if (response.status !== 200) {
      checks.push(
        assert(
          false,
          "evaluation job status loaded",
          statusDetail(response.status, json),
        ),
      );
      return undefined;
    }
    latest = json?.job;
    if (["completed", "failed", "canceled"].includes(latest?.status)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  checks.push(
    assert(
      false,
      "evaluation job completed before timeout",
      `timed out after ${evaluationTimeoutMs}ms`,
    ),
  );
  return latest;
}

async function driveBackgroundQueue() {
  if (!cronSecret || !internalSecret) {
    checks.push(
      assert(
        false,
        "staged background queue credentials available",
        "SMOKE_CRON_SECRET and SMOKE_INTERNAL_AUTH_SECRET are required",
      ),
    );
    return;
  }
  const response = await request("/api/workflows/tick", {
    headers: {
      authorization: `Bearer ${cronSecret}`,
      "x-omni-synthetic-auth": internalSecret,
    },
  });
  const json = await readJson(response);
  checks.push(
    assert(
      response.status === 200,
      "staged background queue processed",
      statusDetail(response.status, json),
    ),
  );
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
