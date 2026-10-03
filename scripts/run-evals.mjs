#!/usr/bin/env node
/**
 * Agent quality scoreboard. Drives the real agent against evals/golden-tasks.json
 * and prints a pass rate. Run against a live server:
 *
 *   BASE_URL=http://localhost:3000 EVAL_EMAIL=<owner> EVAL_PASSWORD=<secret> npm run eval:agents
 *
 * EVAL_TASKS_FILE reads another task file, such as a ledger-replay corpus
 * from GET /api/evaluations/ledger-replay. EVAL_EMAIL and EVAL_PASSWORD sign
 * in a real account; optional EVAL_TENANT_ID and EVAL_ACTOR_ID verify that
 * session's identity and never select or impersonate an owner.
 * EVAL_MODEL_SELECTION, a modelSelection JSON object, pins the candidate
 * model. Ledger replay requires EVAL_AGENT_ID naming a custom Agent whose
 * active principal has the read-only policy. The server checks the same
 * identity it executes, forces direct execution, and withholds memory
 * formation. Replay against a candidate deployment, not production.
 *
 * Exits non-zero if the pass rate is below MIN_PASS_RATE (default 0.8), so it
 * can gate CI once a model key is configured. The assertion logic mirrors the
 * unit-tested reference in src/lib/evals2/scorer.ts.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import {
  createOperatorSession,
  operatorTarget,
  readTextLimited,
  requiredEnvironment,
} from "./operator-session.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TASKS_FILE = path.join(here, "..", "evals", "golden-tasks.json");

/** @param {Record<string, string | undefined>} [env] */
export function evalConfig(env = process.env) {
  const minPassRate = Number(env.MIN_PASS_RATE || 0.8);
  if (!Number.isFinite(minPassRate) || minPassRate < 0 || minPassRate > 1) {
    throw new Error("MIN_PASS_RATE must be a number from 0 to 1.");
  }
  const tenantId = env.EVAL_TENANT_ID?.trim() || undefined;
  const actorId = env.EVAL_ACTOR_ID?.trim() || undefined;
  const agentId = env.EVAL_AGENT_ID?.trim() || undefined;
  if (agentId && !/^[a-zA-Z0-9_.:-]{1,120}$/.test(agentId)) {
    throw new Error("EVAL_AGENT_ID must be a valid Agent identifier.");
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
    ...operatorTarget(env.BASE_URL || "http://localhost:3000", { allowLoopback: true }),
    minPassRate,
    requestTimeoutMs: positiveInteger(env.EVAL_REQUEST_TIMEOUT_MS, 60_000, 300_000),
    tasksFile: env.EVAL_TASKS_FILE ? path.resolve(env.EVAL_TASKS_FILE) : DEFAULT_TASKS_FILE,
    tenantId,
    actorId,
    agentId,
    modelSelection,
  };
}

export function evalSuiteConfig(suite, config) {
  const requireReadOnlyAgent = suite.kind === "ledger_replay";
  if (requireReadOnlyAgent && !config.agentId) {
    throw new Error("Ledger replay requires EVAL_AGENT_ID naming a custom Agent with the read-only approval policy.");
  }
  return { ...config, requireReadOnlyAgent };
}

export function agentRequestInit(task, config) {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      mode: task.mode || "orchestrate",
      messages: [{ role: "user", content: task.goal }],
      ...(config.agentId ? { agentId: config.agentId } : {}),
      ...(config.requireReadOnlyAgent ? { requireReadOnlyAgent: true } : {}),
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
  let costKnown = true;
  let completed = false;
  let error;
  const trajectory = { toolIds: new Set(), citationIds: new Set(), providers: new Set(), estimatedCostUsd: undefined, latencyMs: 0, fallbackCount: 0 };
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "delta" && event.text) response += event.text;
      if (event.type === "done" && typeof event.response === "string") {
        completed = true;
        response = event.response;
      }
      if (["error", "canceled", "waiting_approval", "clarification", "delegated", "budget_exhausted", "execution_target_retired"].includes(event.type)) {
        error = `Agent stream ended with ${event.type}.`;
      }
      if (event.type === "tool" && event.toolId && event.status !== "running") trajectory.toolIds.add(event.toolId);
      if (event.type === "model") {
        if (event.provider) trajectory.providers.add(event.provider);
        costKnown = costKnown && event.costKnown !== false &&
          typeof event.estimatedCostUsd === "number" &&
          Number.isFinite(event.estimatedCostUsd) && event.estimatedCostUsd >= 0;
        trajectory.estimatedCostUsd = costKnown
          ? (trajectory.estimatedCostUsd ?? 0) + event.estimatedCostUsd
          : undefined;
        if (event.fallbackUsed) trajectory.fallbackCount += 1;
      }
      if (event.type === "done" && event.grounding?.citedIds) event.grounding.citedIds.forEach((id) => trajectory.citationIds.add(id));
    } catch {
      // ignore non-JSON keepalive lines
    }
  }
  if (!completed && !error) error = "Agent stream did not complete successfully.";
  return { response, trajectory, ...(error ? { error } : {}) };
}

async function runTask(task, config, session) {
  const startedAt = Date.now();
  try {
    const res = await session.rawRequest("/api/agent", {
      ...agentRequestInit(task, config),
      accept: "text/event-stream",
      timeoutMs: config.requestTimeoutMs,
    });
    if (!res.ok || !res.body) {
      return { response: "", error: `HTTP ${res.status}` };
    }
    if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
      return { response: "", error: "Agent response was not an SSE stream." };
    }
    const outcome = readAgentStream(await readTextLimited(res, 4_000_000));
    outcome.trajectory.latencyMs = Date.now() - startedAt;
    return outcome;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown network error";
    return { response: "", error: `request failed within ${config.requestTimeoutMs}ms: ${detail}` };
  }
}

async function main() {
  const config = evalConfig();
  const session = createOperatorSession({
    ...config,
    email: requiredEnvironment(process.env, "EVAL_EMAIL"),
    password: requiredEnvironment(process.env, "EVAL_PASSWORD", { preserveWhitespace: true }),
    expectedTenantId: config.tenantId,
    expectedActorId: config.actorId,
    syntheticSecret: process.env.SMOKE_INTERNAL_AUTH_SECRET?.trim() || "",
    syntheticSource: "agent-quality-evaluation",
    bypassSecret: process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim() || "",
  });
  let primaryFailure;
  let signOutFailure;
  try {
    const raw = await readFile(config.tasksFile, "utf8");
    const suite = JSON.parse(raw);
    const requestConfig = evalSuiteConfig(suite, config);
    await session.signIn();
    if (suite.kind === "ledger_replay") {
      console.log(`Replaying ${suite.tasks.length} recorded runs against ${config.baseUrl}.`);
    }
    const results = [];
    for (const task of suite.tasks) {
      const { response, trajectory, error } = await runTask(task, requestConfig, session);
      const failures = error ? [error] : applyAssertion(task.assert, response, trajectory);
      const passed = failures.length === 0;
      results.push({ id: task.id, passed, failures });
      console.log(session.safeText(`${passed ? "PASS" : "FAIL"}  ${task.id}${failures.length ? `  — ${failures.join("; ")}` : ""}`));
    }
    const passed = results.filter((r) => r.passed).length;
    const passRate = results.length ? passed / results.length : 0;
    console.log(`\nScoreboard: ${passed}/${results.length} passed (${(passRate * 100).toFixed(0)}%)`);
    if (passRate < config.minPassRate) {
      throw new Error(`Below MIN_PASS_RATE (${(config.minPassRate * 100).toFixed(0)}%).`);
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await session.signOut();
    } catch (error) {
      signOutFailure = error;
    }
  }
  if (primaryFailure || signOutFailure) {
    for (const [error, label] of [[primaryFailure, ""], [signOutFailure, "Sign-out: "]]) {
      if (error) console.error(label + session.safeText(error instanceof Error ? error.message : error));
    }
    process.exitCode = 1;
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
    console.error(error instanceof Error ? error.message : "Evaluation configuration failed.");
    process.exitCode = 1;
  });
}
