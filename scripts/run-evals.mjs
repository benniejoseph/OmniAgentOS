#!/usr/bin/env node
/**
 * Agent quality scoreboard. Drives the real agent against evals/golden-tasks.json
 * and prints a pass rate. Run against a live server:
 *
 *   BASE_URL=http://localhost:3000 node scripts/run-evals.mjs
 *
 * Exits non-zero if the pass rate is below MIN_PASS_RATE (default 0.8), so it
 * can gate CI once a model key is configured. The assertion logic mirrors the
 * unit-tested reference in src/lib/evals2/scorer.ts.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MIN_PASS_RATE = Number(process.env.MIN_PASS_RATE || 0.8);
const REQUEST_TIMEOUT_MS = positiveInteger(
  process.env.EVAL_REQUEST_TIMEOUT_MS,
  60_000,
  300_000,
);
const here = path.dirname(fileURLToPath(import.meta.url));

function applyAssertion(assert, response, trajectory) {
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

async function runTask(task) {
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${BASE_URL}/api/agent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(process.env.SMOKE_INTERNAL_AUTH_SECRET
          ? {
              "x-omni-internal-auth": process.env.SMOKE_INTERNAL_AUTH_SECRET,
              "x-omni-user-role": "operator",
            }
          : {}),
      },
      body: JSON.stringify({ mode: task.mode || "orchestrate", messages: [{ role: "user", content: task.goal }] }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown network error";
    return { response: "", error: `request failed within ${REQUEST_TIMEOUT_MS}ms: ${detail}` };
  }
  if (!res.ok || !res.body) {
    return { response: "", error: `HTTP ${res.status}` };
  }
  const text = await res.text();
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
  trajectory.latencyMs = Date.now() - startedAt;
  return { response, trajectory };
}

async function main() {
  if (!Number.isFinite(MIN_PASS_RATE) || MIN_PASS_RATE < 0 || MIN_PASS_RATE > 1) {
    throw new Error("MIN_PASS_RATE must be a number from 0 to 1.");
  }

  const raw = await readFile(path.join(here, "..", "evals", "golden-tasks.json"), "utf8");
  const suite = JSON.parse(raw);
  const results = [];
  for (const task of suite.tasks) {
    const { response, trajectory, error } = await runTask(task);
    const failures = error ? [error] : applyAssertion(task.assert, response, trajectory);
    const passed = failures.length === 0;
    results.push({ id: task.id, passed, failures });
    console.log(`${passed ? "PASS" : "FAIL"}  ${task.id}${failures.length ? `  — ${failures.join("; ")}` : ""}`);
  }
  const passed = results.filter((r) => r.passed).length;
  const passRate = results.length ? passed / results.length : 0;
  console.log(`\nScoreboard: ${passed}/${results.length} passed (${(passRate * 100).toFixed(0)}%)`);
  if (passRate < MIN_PASS_RATE) {
    console.error(`Below MIN_PASS_RATE (${(MIN_PASS_RATE * 100).toFixed(0)}%).`);
    process.exit(1);
  }
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
