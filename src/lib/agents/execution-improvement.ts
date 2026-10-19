import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { redactSensitive } from "@/lib/security/context";
import type { AgentRunRecord } from "@/lib/runs/types";
import type { ToolExecutionRecord } from "@/lib/tools/types";

const scalar = z.union([z.string().max(1_000), z.number().finite(), z.boolean(), z.null()]);
export const executionBehaviorAssertionSchema = z.object({ toolId: z.string().min(1).max(240),
  path: z.array(z.union([z.string().min(1).max(120), z.number().int().min(0).max(1000)])).min(1).max(12), equals: scalar }).strict();
export const executionImprovementComparisonInputSchema = z.object({ baselineRunId: z.string().min(1).max(200), candidateRunId: z.string().min(1).max(200),
  assertions: z.array(executionBehaviorAssertionSchema).min(1).max(20) }).strict();
type Assertion = z.infer<typeof executionBehaviorAssertionSchema>;

export function buildExecutionFailureFixture(run: AgentRunRecord, receipts: readonly ToolExecutionRecord[]) {
  const body = { schemaVersion: 1, kind: "execution_failure_fixture", sourceRunId: run.id,
    promptSha256: canonicalJsonSha256(run.prompt), prompt: redactSensitive(run.prompt),
    observedStatus: run.status, failure: run.error || null, ownerVerdict: run.feedback?.verdict || null,
    observations: receipts.map(record => ({ executionId: record.id, toolId: record.toolId, status: record.status,
      dryRun: record.dryRun, inputSha256: canonicalJsonSha256(record.input),
      input: record.riskLevel === 0 ? redactSensitive(record.input) : null,
      output: record.riskLevel === 0 ? redactSensitive(record.output ?? null) : null,
      outputSha256: canonicalJsonSha256(record.output ?? null), reason: record.reason || null })),
    replay: { automaticallyExecutable: false, externalMutations: "disabled",
      instructions: "Use recorded reads as fixtures in an isolated candidate task. Declare expected saved fields, retain a baseline run, and compare the candidate with app.agents.improvements.compare. Never replay real side effects from this fixture." },
    activation: { automatic: false, requirement: "A reviewable patch, passing behavior comparison and adjacent regressions, then a versioned Build Studio checkpoint and the governed release step." },
  };
  return { ...body, fixtureSha256: canonicalJsonSha256(body) };
}

function field(value: unknown, path: Assertion["path"]) {
  for (const key of path) {
    if (!value || typeof value !== "object" || ["__proto__", "constructor", "prototype"].includes(String(key)) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}

/** Compares real tool trajectories against explicit field assertions. A model
 * saying "fixed" cannot pass this comparator. This never activates code. */
export function compareExecutionBehavior(input: {
  baseline: AgentRunRecord; candidate: AgentRunRecord; baselineReceipts: readonly ToolExecutionRecord[];
  candidateReceipts: readonly ToolExecutionRecord[]; assertions: readonly Assertion[];
}) {
  const evaluate = (records: readonly ToolExecutionRecord[], assertion: Assertion) => {
    const record = records.filter(record => record.toolId === assertion.toolId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).at(-1);
    const actual = record && field(record.output, assertion.path);
    return { passed: Boolean(record && record.status === "executed" && !record.dryRun && actual !== undefined &&
      canonicalJsonSha256(actual) === canonicalJsonSha256(assertion.equals)), executionId: record?.id || null,
      actual: actual === undefined ? null : typeof actual === "object" && actual !== null
        ? { valueSha256: canonicalJsonSha256(actual), scalarExpected: true } : redactSensitive(actual), observed: actual !== undefined };
  };
  const cases = input.assertions.map(assertion => ({ assertion, baseline: evaluate(input.baselineReceipts, assertion), candidate: evaluate(input.candidateReceipts, assertion) }));
  const comparable = input.baseline.id !== input.candidate.id && input.baseline.tenantId === input.candidate.tenantId &&
    input.baseline.ownerActorId === input.candidate.ownerActorId && canonicalJsonSha256(input.baseline.prompt) === canonicalJsonSha256(input.candidate.prompt);
  const baselinePassed = cases.filter(item => item.baseline.passed).length;
  const candidatePassed = cases.filter(item => item.candidate.passed).length;
  const candidateFailedTools = input.candidateReceipts.filter(record => ["failed", "blocked"].includes(record.status)).length;
  const verdict = !comparable || input.candidate.status !== "completed" || candidateFailedTools > 0 ? "incomplete"
    : cases.some(item => item.baseline.passed && !item.candidate.passed) ? "regressed"
      : candidatePassed === cases.length && candidatePassed > baselinePassed ? "improved" : "no_change";
  const body = { schemaVersion: 1, kind: "execution_behavior_comparison", baselineRunId: input.baseline.id,
    candidateRunId: input.candidate.id, promptSha256: canonicalJsonSha256(input.baseline.prompt), comparable,
    cases, baselinePassed, candidatePassed, candidateFailedTools, verdict,
    coverage: "Only the declared saved-field assertions and recorded tool failures; independent adjacent scenarios and release checks remain required.", activation: "not_performed" };
  return { ...body, comparisonSha256: canonicalJsonSha256(body) };
}
