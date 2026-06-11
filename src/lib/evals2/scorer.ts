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

export function scoreTask(task: GoldenTask, response: string): TaskScore {
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
