#!/usr/bin/env node
/**
 * Agent quality scoreboard. Drives the real agent against evals/golden-tasks.json
 * and prints a pass rate. Run against a live server:
 *
 *   BASE_URL=http://localhost:3000 node scripts/run-evals.mjs
 *
 * EVAL_TASKS_FILE reads another task file, such as a ledger-replay corpus
 * from GET /api/evaluations/ledger-replay. With SMOKE_INTERNAL_AUTH_SECRET,
 * EVAL_TENANT_ID and EVAL_ACTOR_ID run the tasks as that workspace owner.
 * EVAL_MODEL_SELECTION, a modelSelection JSON object, pins the candidate
 * model. Replay a corpus against a candidate deployment, not production.
 *
 * Exits non-zero if the pass rate is below MIN_PASS_RATE (default 0.8), so it
 * can gate CI once a model key is configured. The assertion logic mirrors the
 * unit-tested reference in src/lib/evals2/scorer.ts.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS_FILE = path.join(here, "..", "evals", "golden-tasks.json");

/** @param {Record<string, string | undefined>} [env] */
export function evalConfig(env = process.env) {
  const minPassRate = Number(env.MIN_PASS_RATE || 0.8);
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    throw new Error("MIN_PASS_RATE must be a number from 0 to 1.");
  }
  const internalAuth = env.SMOKE_INTERNAL_AUTH_SECRET || undefined;
  const tenantId = env.EVAL_TENANT_ID?.trim() || undefined;
  const actorId = env.EVAL_ACTOR_ID?.trim() || undefined;
  if ((tenantId || actorId) && !internalAuth) {
    throw new Error("EVAL_TENANT_ID and EVAL_ACTOR_ID need SMOKE_INTERNAL_AUTH_SECRET.");
  }
  let modelSelection;
  if (env.EVAL_MODEL_SELECTION) {
    try {
      modelSelection = JSON.parse(env.EVAL_MODEL_SELECTION);
    } catch {
      modelSelection = undefined;
    }
    if (!modelSelection || typeof modelSelection !== "object" || Array.isArray(modelSelection)) {
      throw new Error("EVAL_MODEL_SELECTION must be a JSON object.");
    }
  }
  return {
    baseUrl: env.BASE_URL || "http://localhost:3000",
    minPassRate,
    requestTimeoutMs: positiveInteger(env.EVAL_REQUEST_TIMEOUT_MS, 60_000, 300_000),
    tasksFile: env.EVAL_TASKS_FILE ? path.resolve(env.EVAL_TASKS_FILE) : DEFAULT_TASKS_FILE,
    internalAuth,
    tenantId,
    actorId,
    modelSelection,
  };
}

export function agentRequestInit(task, config) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.internalAuth
        ? {
            "x-omni-internal-auth": config.internalAuth,
            "x-omni-user-role": "operator",
            ...(config.tenantId ? { "x-omni-tenant-id": config.tenantId } : {}),
            ...(config.actorId ? { "x-omni-user-id": config.actorId } : {}),
          }
        : {}),
    },
    body: JSON.stringify({
      mode: task.mode || "orchestrate",
      messages: [{ role: "user", content: task.goal }],
      ...(config.modelSelection ? { modelSelection: config.modelSelection } : {}),
    }),
  };
}

export function applyAssertion(assert, response, trajectory) {
  const text = (response || "").toLowerCase();
  const failures = [];
  if (assert.minLength !== undefined && response.trim().length < assert.minLength) {
    failures.push(`shorter than ${assert.minLength} chars`);
  }
  if (assert.anyOf?.length && !assert.anyOf.some((n) => text.includes(n.toLowerCase()))) {
    failures.push(`expected any of: ${assert.anyOf.join(", ")}`);
  }
  if (assert.allOf?.length) {
    const missing = assert.allOf.filter((n) => !text.includes(n.toLowerCase()));
    if (missing.length) failures.push(`missing: ${missing.join(", ")}`);
  }
  if (assert.noneOf?.length) {
    const present = assert.noneOf.filter((n) => text.includes(n.toLowerCase()));
    if (present.length) failures.push(`forbidden: ${present.join(", ")}`);
  }
  if (assert.regex && !new RegExp(assert.regex, "i").test(response)) {
    failures.push(`no match /${assert.regex}/i`);
  }
  if (assert.minCitations !== undefined && trajectory.citationIds.size < assert.minCitations) failures.push(`expected ${assert.minCitations} citations, received ${trajectory.citationIds.size}`);
  if (assert.requiredToolIds?.length) {
    const missing = assert.requiredToolIds.filter((id) => !trajectory.toolIds.has(id));
    if (missing.length) failures.push(`required tools not used: ${missing.join(", ")}`);
  }
  if (assert.forbiddenToolIds?.length) {
    const present = assert.forbiddenToolIds.filter((id) => trajectory.toolIds.has(id));
    if (present.length) failures.push(`forbidden tools used: ${present.join(", ")}`);
  }
  if (assert.maxEstimatedCostUsd !== undefined && !(trajectory.estimatedCostUsd <= assert.maxEstimatedCostUsd)) failures.push(`cost ${trajectory.estimatedCostUsd} exceeded ${assert.maxEstimatedCostUsd}`);
  if (assert.maxLatencyMs !== undefined && trajectory.latencyMs > assert.maxLatencyMs) failures.push(`latency ${trajectory.latencyMs}ms exceeded ${assert.maxLatencyMs}ms`);
  if (assert.maxFallbacks !== undefined && trajectory.fallbackCount > assert.maxFallbacks) failures.push(`fallback count ${trajectory.fallbackCount} exceeded ${assert.maxFallbacks}`);
  if (assert.requiredProvider && !trajectory.providers.has(assert.requiredProvider)) failures.push(`required provider not used: ${assert.requiredProvider}`);
  return failures;
}

/** The answer and trajectory in an /api/agent event stream. */
export function readAgentStream(text) {
  let response = "";
  const trajectory = { toolIds: new Set(), citationIds: new Set(), providers: new Set(), estimatedCostUsd: undefined, latencyMs: 0, fallbackCount: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "delta" && event.text) response += event.text;
      if (event.type === "done" && event.response) response = event.response;
      if (event.type === "tool" && event.toolId && event.status !== "running") trajectory.toolIds.add(event.toolId);
      if (event.type === "model") {
        if (event.provider) trajectory.providers.add(event.provider);
        if (typeof event.estimatedCostUsd === "number") trajectory.estimatedCostUsd = (trajectory.estimatedCostUsd || 0) + event.estimatedCostUsd;
        if (event.fallbackUsed) trajectory.fallbackCount += 1;
      }
      if (event.type === "done" && event.grounding?.citedIds) event.grounding.citedIds.forEach((id) => trajectory.citationIds.add(id));
    } catch {
      // ignore non-JSON keepalive lines
    }
  }
  return { response, trajectory };
}

async function runTask(task, config) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${config.baseUrl}/api/agent`, {
      ...agentRequestInit(task, config),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown network error";
    return { response: "", error: `request failed within ${config.requestTimeoutMs}ms: ${detail}` };
  }
  if (!res.ok || !res.body) {
    return { response: "", error: `HTTP ${res.status}` };
  }
  const { response, trajectory } = readAgentStream(await res.text());
  trajectory.latencyMs = Date.now() - startedAt;
  return { response, trajectory };
}

async function main() {
  const config = evalConfig();
  const raw = await readFile(config.tasksFile, "utf8");
  const suite = JSON.parse(raw);
  if (suite.kind === "ledger_replay") {
    console.log(`Replaying ${suite.tasks.length} recorded runs against ${config.baseUrl}.`);
  }
  const results = [];
  for (const task of suite.tasks) {
    const { response, trajectory, error } = await runTask(task, config);
    const failures = error ? [error] : applyAssertion(task.assert, response, trajectory);
    const passed = failures.length === 0;
    results.push({ id: task.id, passed, failures });
    console.log(`${passed ? "PASS" : "FAIL"}  ${task.id}${failures.length ? `  — ${failures.join("; ")}` : ""}`);
  }
  const passed = results.filter((r) => r.passed).length;
  const passRate = results.length ? passed / results.length : 0;
  console.log(`\nScoreboard: ${passed}/${results.length} passed (${(passRate * 100).toFixed(0)}%)`);
  if (passRate < config.minPassRate) {
    console.error(`Below MIN_PASS_RATE (${(config.minPassRate * 100).toFixed(0)}%).`);
    process.exit(1);
  }
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
