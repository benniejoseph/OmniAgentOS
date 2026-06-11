#!/usr/bin/env node
/**
 * Agent quality scoreboard. Drives the real agent against evals/golden-tasks.json
 * and prints a pass rate. Run against a live server:
 *
 *   BASE_URL=http://localhost:3000 node scripts/run-evals.mjs
 *
 * Exits non-zero if the pass rate is below MIN_PASS_RATE (default 0.6), so it
 * can gate CI once a model key is configured. The assertion logic mirrors the
 * unit-tested reference in src/lib/evals2/scorer.ts.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const MIN_PASS_RATE = Number(process.env.MIN_PASS_RATE || 0.6);
const here = path.dirname(fileURLToPath(import.meta.url));

function applyAssertion(assert, response) {
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
  return failures;
}

async function runTask(task) {
  const res = await fetch(`${BASE_URL}/api/agent`, {
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
  });
  if (!res.ok || !res.body) {
    return { response: "", error: `HTTP ${res.status}` };
  }
  const text = await res.text();
  let response = "";
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    try {
      const event = JSON.parse(line.slice(5).trim());
      if (event.type === "delta" && event.text) response += event.text;
      if (event.type === "done" && event.response) response = event.response;
    } catch {
      // ignore non-JSON keepalive lines
    }
  }
  return { response };
}

async function main() {
  const raw = await readFile(path.join(here, "..", "evals", "golden-tasks.json"), "utf8");
  const suite = JSON.parse(raw);
  const results = [];
  for (const task of suite.tasks) {
    const { response, error } = await runTask(task);
    const failures = error ? [error] : applyAssertion(task.assert, response);
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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
