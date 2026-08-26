/**
 * Deterministic scorer for golden agent tasks. Pure and dependency-free so it
 * runs in CI without a model: given an agent's final text and a task's
 * assertions, it returns pass/fail with reasons. The runner (scripts/run-evals)
 * produces the text by driving the real agent; this module only judges it.
 */

export type GoldenAssertion = {
  anyOf?: string[];
  allOf?: string[];
  noneOf?: string[];
  minLength?: number;
  regex?: string;
  minCitations?: number;
  requiredToolIds?: string[];
  forbiddenToolIds?: string[];
  maxEstimatedCostUsd?: number;
  maxLatencyMs?: number;
  maxFallbacks?: number;
  requiredProvider?: "openai" | "google" | "anthropic" | "local";
};

export type EvalTrajectory = {
  citationIds?: string[];
  toolIds?: string[];
  estimatedCostUsd?: number;
  latencyMs?: number;
  fallbackCount?: number;
  providers?: string[];
};

export type GoldenTask = {
  id: string;
  goal: string;
  mode?: string;
  assert: GoldenAssertion;
  rationale?: string;
};

export type TaskScore = {
  id: string;
  passed: boolean;
  score: number;
  failures: string[];
};

export function scoreTask(task: GoldenTask, response: string, trajectory: EvalTrajectory = {}): TaskScore {
  const text = (response || "").toLowerCase();
  const failures: string[] = [];
  const checks: boolean[] = [];

  if (task.assert.minLength !== undefined) {
    const ok = response.trim().length >= task.assert.minLength;
    checks.push(ok);
    if (!ok) {
      failures.push(`response shorter than ${task.assert.minLength} chars`);
    }
  }

  if (task.assert.anyOf?.length) {
    const ok = task.assert.anyOf.some((needle) => text.includes(needle.toLowerCase()));
    checks.push(ok);
    if (!ok) {
      failures.push(`expected any of: ${task.assert.anyOf.join(", ")}`);
    }
  }

  if (task.assert.allOf?.length) {
    const missing = task.assert.allOf.filter((needle) => !text.includes(needle.toLowerCase()));
    checks.push(missing.length === 0);
    if (missing.length) {
      failures.push(`missing required: ${missing.join(", ")}`);
    }
  }

  if (task.assert.noneOf?.length) {
    const present = task.assert.noneOf.filter((needle) => text.includes(needle.toLowerCase()));
    checks.push(present.length === 0);
    if (present.length) {
      failures.push(`contained forbidden: ${present.join(", ")}`);
    }
  }

  if (task.assert.regex) {
    const ok = new RegExp(task.assert.regex, "i").test(response);
    checks.push(ok);
    if (!ok) {
      failures.push(`did not match /${task.assert.regex}/i`);
    }
  }

  if (task.assert.minCitations !== undefined) {
    const count = new Set(trajectory.citationIds || []).size;
    const ok = count >= task.assert.minCitations;
    checks.push(ok);
    if (!ok) failures.push(`expected at least ${task.assert.minCitations} verified citations; received ${count}`);
  }

  if (task.assert.requiredToolIds?.length) {
    const used = new Set(trajectory.toolIds || []);
    const missing = task.assert.requiredToolIds.filter((toolId) => !used.has(toolId));
    checks.push(missing.length === 0);
    if (missing.length) failures.push(`required tools not used: ${missing.join(", ")}`);
  }

  if (task.assert.forbiddenToolIds?.length) {
    const used = new Set(trajectory.toolIds || []);
    const present = task.assert.forbiddenToolIds.filter((toolId) => used.has(toolId));
    checks.push(present.length === 0);
    if (present.length) failures.push(`forbidden tools used: ${present.join(", ")}`);
  }

  if (task.assert.maxEstimatedCostUsd !== undefined) {
    const cost = trajectory.estimatedCostUsd;
    const ok = cost !== undefined && cost <= task.assert.maxEstimatedCostUsd;
    checks.push(ok);
    if (!ok) failures.push(`estimated cost ${cost ?? "unavailable"} exceeded ${task.assert.maxEstimatedCostUsd}`);
  }

  if (task.assert.maxLatencyMs !== undefined) {
    const latency = trajectory.latencyMs;
    const ok = latency !== undefined && latency <= task.assert.maxLatencyMs;
    checks.push(ok);
    if (!ok) failures.push(`latency ${latency ?? "unavailable"}ms exceeded ${task.assert.maxLatencyMs}ms`);
  }

  if (task.assert.maxFallbacks !== undefined) {
    const count = trajectory.fallbackCount || 0;
    const ok = count <= task.assert.maxFallbacks;
    checks.push(ok);
    if (!ok) failures.push(`fallback count ${count} exceeded ${task.assert.maxFallbacks}`);
  }

  if (task.assert.requiredProvider) {
    const ok = new Set(trajectory.providers || []).has(task.assert.requiredProvider);
    checks.push(ok);
    if (!ok) failures.push(`required provider not used: ${task.assert.requiredProvider}`);
  }

  const passedChecks = checks.filter(Boolean).length;
  const score = checks.length ? passedChecks / checks.length : 0;
  return { id: task.id, passed: failures.length === 0 && checks.length > 0, score, failures };
}

export type ScoreboardResult = {
  total: number;
  passed: number;
  passRate: number;
  averageScore: number;
  tasks: TaskScore[];
};

export function scoreboard(results: TaskScore[]): ScoreboardResult {
  const passed = results.filter((result) => result.passed).length;
  const averageScore = results.length
    ? results.reduce((sum, result) => sum + result.score, 0) / results.length
    : 0;
  return {
    total: results.length,
    passed,
    passRate: results.length ? passed / results.length : 0,
    averageScore,
    tasks: results,
  };
}
