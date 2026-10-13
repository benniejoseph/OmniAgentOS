import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./smoke-eval-case.mjs", import.meta.url));
const secret = "synthetic-evaluation-test-secret";
const actorId = "synthetic-evaluation-reviewer";

test("each invocation isolates its evaluation from an older ordinary tenant queue", async () => {
  await withServer({}, async (baseUrl, observed) => {
    for (let index = 0; index < 2; index += 1) {
      const result = await runSmoke(baseUrl);
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /PASS evaluation job completed/);
    }
    const tenants = [...observed.jobs.values()].map((job) => job.tenantId);
    assert.equal(new Set(tenants).size, 2, "even a reused run label must not reuse the default tenant");
    for (const tenant of tenants) assert.match(tenant, /^production_smoke_[a-f0-9]{32}$/);
    assert.equal(observed.ticks, 2);
    assert.equal(observed.ordinaryEffects, 0);
    assert.equal(observed.details, 2);
  });
});

test("an explicit synthetic tenant and actor stay bound while older smoke work consumes a tick", async () => {
  await withServer({ olderSmokeJobs: 1 }, async (baseUrl, observed) => {
    const result = await runSmoke(baseUrl, { SMOKE_TENANT_ID: "production_smoke_release_retry" });
    assert.equal(result.code, 0, result.output);
    assert.equal(observed.ticks, 2);
    assert.equal(observed.polls, 3, "an unrelated completion must not pass the exact job check");
    assert.equal(observed.details, 1);
    assert.equal(observed.ordinaryEffects, 0);
    for (const request of observed.requests) {
      assert.equal(request.headers["x-omni-tenant-id"], "production_smoke_release_retry");
      assert.equal(request.headers["x-omni-user-id"], actorId);
      assert.equal(request.headers["x-omni-user-role"], "admin");
    }
  });
});

test("drive mode refuses cookie-only authentication and non-synthetic tenant overrides before effects", async () => {
  await withServer({}, async (baseUrl, observed) => {
    const configurations = [
      { SMOKE_INTERNAL_AUTH_SECRET: "", SMOKE_ADMIN_EMAIL: "owner@example.test", SMOKE_ADMIN_PASSWORD: "owner-password" },
      { SMOKE_TENANT_ID: "tenant_real_owner" },
      { SMOKE_TENANT_ID: "production_smoke_bad value" },
      { SMOKE_TENANT_ID: `production_smoke_${"a".repeat(104)}` },
    ];
    for (const environment of configurations) {
      const result = await runSmoke(baseUrl, environment);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /requires SMOKE_INTERNAL_AUTH_SECRET|SMOKE_TENANT_ID must be/);
    }
    assert.deepEqual(observed.requests, [], "no login, evaluation admission, or tick is allowed");
  });
});

test("a successful tick reporting another completed job cannot pass a queued evaluation", async () => {
  await withServer({ alwaysQueued: true }, async (baseUrl, observed) => {
    const startedAt = Date.now();
    const result = await runSmoke(baseUrl);
    assert.equal(result.code, 1, result.output);
    // The loop, request admission and in-flight fetch share one deadline. Any
    // can observe expiry first without accepting the unrelated completed job.
    const deadlineFailures = [
      /^FAIL evaluation job completed before timeout - timed out after 10000ms$/m,
      /^FAIL evaluation smoke timed out after 10000ms\.$/m,
      /^FAIL (?:GET \/api\/operations\/jobs\/evaluation-job-\d+|POST \/api\/workflows\/tick) failed after [01] attempt\(s\) in \d+ms \(timeout \d+ms; code=TIMEOUT\)\.$/m,
    ];
    assert.ok(deadlineFailures.some((pattern) => pattern.test(result.output)), result.output);
    assert.doesNotMatch(result.output, /^PASS evaluation job completed\b/m);
    const elapsedMs = Date.now() - startedAt;
    assert.ok(elapsedMs >= 10_000 && elapsedMs < 15_000, "ticks and polling must share the overall ten-second deadline");
    assert.ok(observed.ticks > 1 && observed.ticks <= 10);
    assert.ok(observed.polls > 1, "the exact admitted job must be reread after unrelated completions");
    assert.equal(observed.jobs.size, 1);
    assert.equal([...observed.jobs.values()][0].status, "queued");
    assert.equal(observed.details, 0);
    assert.equal(observed.ordinaryEffects, 0);
  });
});

test("an unsuccessful tick fails without replaying an ambiguous POST", async () => {
  await withServer({ tickStatus: 503 }, async (baseUrl, observed) => {
    const result = await runSmoke(baseUrl);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /FAIL isolated evaluation tenant tick accepted - status 503/);
    assert.equal(observed.ticks, 1);
    assert.equal(observed.details, 0);
  });
});

test("a mismatched status ID or type is rejected before any queue tick or evidence read", async () => {
  for (const statusOverride of [{ id: "different-job" }, { type: "knowledge.ingest" }]) {
    await withServer({ statusOverride }, async (baseUrl, observed) => {
      const result = await runSmoke(baseUrl);
      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /FAIL evaluation job identity matches/);
      assert.equal(observed.ticks, 0);
      assert.equal(observed.details, 0);
    });
  }
});

test("a future scheduled retry is polled without driving its tenant queue", async () => {
  await withServer({ futureRetry: true }, async (baseUrl, observed) => {
    const result = await runSmoke(baseUrl);
    assert.equal(result.code, 0, result.output);
    assert.equal(observed.polls, 2);
    assert.equal(observed.ticks, 0);
    assert.equal(observed.details, 1);
  });
});

test("terminal job failure and a failing linked case each fail the smoke", async () => {
  for (const scenario of [{ jobStatus: "failed" }, { caseStatus: "fail" }]) {
    await withServer(scenario, async (baseUrl, observed) => {
      const result = await runSmoke(baseUrl);
      assert.equal(result.code, 1, result.output);
      if (scenario.jobStatus) {
        assert.equal(observed.ticks, 0);
        assert.equal(observed.details, 0);
      } else {
        assert.equal(observed.details, 1);
        assert.match(result.output, /FAIL security.tenant_isolation passed/);
      }
    });
  }
});

async function runSmoke(baseUrl, environment = {}) {
  return new Promise((resolve, reject) => {
    // Do not inherit operator credentials, production targets, or Node loaders.
    const child = spawn(process.execPath, [script], {
      env: {
        BASE_URL: baseUrl,
        SMOKE_INTERNAL_AUTH_SECRET: secret,
        SMOKE_ACTOR_ID: actorId,
        SMOKE_RUN_ID: "reused-test-run-label",
        SMOKE_DRIVE_BACKGROUND_QUEUE: "true",
        SMOKE_EVAL_TIMEOUT_MS: "10000",
        SMOKE_REQUEST_TIMEOUT_MS: "300000",
        ...environment,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Evaluation smoke subprocess exceeded its test watchdog."));
    }, 18_000);
    child.on("error", (error) => { clearTimeout(watchdog); reject(error); });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      resolve({ code, output });
    });
  });
}

async function withServer(scenario, callback) {
  const observed = { requests: [], jobs: new Map(), ticks: 0, polls: 0, details: 0, ordinaryEffects: 0 };
  const errors = [];
  let olderSmokeJobs = scenario.olderSmokeJobs || 0;
  const server = createServer(async (request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks).toString();
      const body = rawBody ? JSON.parse(rawBody) : undefined;
      observed.requests.push({ path: request.url, headers: request.headers, body });
      assert.equal(request.headers["x-omni-internal-auth"], secret);
      assert.equal(request.headers["x-omni-synthetic-auth"], secret);
      assert.equal(request.headers["x-omni-slo-excluded"], "true");
      assert.equal(request.headers["x-omni-user-role"], "admin");
      assert.equal(request.headers["x-omni-user-id"], actorId);
      assert.equal(request.headers["x-omni-worker-instance"], undefined);
      assert.equal(request.headers["x-omni-worker-protocol"], undefined);
      const tenantId = request.headers["x-omni-tenant-id"];
      if (request.method === "POST" && request.url === "/api/evaluations") {
        assert.equal(request.headers["idempotency-key"], "reused-test-run-label");
        assert.deepEqual(body.caseIds, ["security.tenant_isolation"]);
        assert.equal(body.suite, "production-smoke");
        const id = `evaluation-job-${observed.jobs.size + 1}`;
        const job = {
          id, type: "evaluation.run", status: scenario.jobStatus || "queued", tenantId,
          ...(scenario.futureRetry ? { runAt: new Date(Date.now() + 60_000).toISOString() } : {}),
        };
        observed.jobs.set(id, job);
        response.setHeader("location", "/api/operations/jobs/unrelated-job");
        return send(202, { job });
      }
      if (request.method === "POST" && request.url === "/api/workflows/tick") {
        observed.ticks += 1;
        if (body.scope === "all_tenants") {
          observed.ordinaryEffects += 1;
          return send(200, { backgroundJobs: { jobs: [{ id: "older-ordinary-job", status: "completed" }] } });
        }
        assert.deepEqual(body, { scope: "tenant", limit: 1, slo: false, alerts: false });
        const job = [...observed.jobs.values()].find((item) => item.tenantId === tenantId);
        assert.ok(job, "the tick must use the exact admitted tenant");
        if (scenario.tickStatus) return send(scenario.tickStatus, { error: "synthetic tick failure" });
        if (olderSmokeJobs > 0 || scenario.alwaysQueued) {
          olderSmokeJobs -= 1;
          return send(200, { backgroundJobs: { jobs: [{ id: "older-smoke-job", status: "completed" }] } });
        }
        job.status = "completed";
        job.result = { evaluationRunId: `run-${job.id}` };
        return send(200, { backgroundJobs: { jobs: [{ id: job.id, status: "completed" }] } });
      }
      if (request.method === "GET" && request.url.startsWith("/api/operations/jobs/")) {
        observed.polls += 1;
        const job = observed.jobs.get(request.url.split("/").at(-1));
        assert.ok(job, "polling must select the accepted job, regardless of Location");
        assert.equal(job.tenantId, tenantId);
        if (scenario.futureRetry && observed.polls === 2) {
          job.status = "completed";
          job.result = { evaluationRunId: `run-${job.id}` };
        }
        return send(200, { job: { ...job, ...scenario.statusOverride } });
      }
      if (request.method === "GET" && request.url.startsWith("/api/evaluations/run-")) {
        observed.details += 1;
        const job = observed.jobs.get(request.url.slice("/api/evaluations/run-".length));
        assert.equal(job?.status, "completed");
        assert.equal(job.tenantId, tenantId);
        return send(200, { run: { status: "completed" }, results: [{ caseId: "security.tenant_isolation", status: scenario.caseStatus || "pass" }] });
      }
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    } catch (error) {
      errors.push(error.message);
      send(500, { error: "mock contract violation" });
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`, observed);
    assert.deepEqual(errors, []);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
