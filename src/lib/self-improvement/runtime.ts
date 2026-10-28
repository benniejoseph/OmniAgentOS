import { z } from "zod";
import { isSelfImprovementNativeSourcePath, isSelfImprovementNativeTestPath, selfImprovementNativeRuntimeSchema, nativePairedBaselineSchema } from "./native-contracts";
import { selfImprovementDigestSchema, selfImprovementPathSchema } from "./contracts";
import { forgeHandoffReceiptSchema } from "./forge-handoff";

const testPath = selfImprovementPathSchema.refine((path) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path) || isSelfImprovementNativeTestPath(path), "Select an exact regression test file.");
export const MAX_IMPROVEMENT_ACCEPTANCE_CRITERIA = 12;
export const improvementPlanSchema = z.object({
  releaseTarget: z.literal("macos_app").optional(),
  summary: z.string().min(1).max(1_000),
  sourcePaths: z.array(selfImprovementPathSchema).min(1).max(12),
  newSourcePaths: z.array(selfImprovementPathSchema).max(8).default([]),
  focusedTestPaths: z.array(testPath).min(1).max(6),
  adjacentTestPaths: z.array(testPath).min(1).max(6),
  acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(MAX_IMPROVEMENT_ACCEPTANCE_CRITERIA),
}).strict().superRefine((value, context) => {
  if (value.releaseTarget === "macos_app") {
    if ([...value.sourcePaths, ...value.newSourcePaths].some(path => !isSelfImprovementNativeSourcePath(path)) || [...value.focusedTestPaths, ...value.adjacentTestPaths].some(path => !isSelfImprovementNativeTestPath(path))) context.addIssue({ code: "custom", message: "Native repair plan contains a protected or unsupported path." });
  } else if ([...value.focusedTestPaths, ...value.adjacentTestPaths].some(path => !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(path))) context.addIssue({ code: "custom", message: "Native tests require an explicit macos_app target." });
  const paths = [...value.sourcePaths, ...value.newSourcePaths, ...value.focusedTestPaths, ...value.adjacentTestPaths];
  if (new Set(paths).size !== paths.length) context.addIssue({ code: "custom", message: "Source, reproduction and adjacent test paths must be unique and separate." });
});
export const improvementInspectionSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("no_change"), summary: z.string().min(1).max(1_000) }).strict(),
  z.object({ decision: z.literal("repair"), plan: improvementPlanSchema }).strict(),
]);
export const improvementPhaseSchema = z.enum(["setup", "inspect", "reproduce", "baseline_check", "implement", "verify", "review", "deliver", "release_wait", "done"]);
export type ImprovementPhase = z.infer<typeof improvementPhaseSchema>;
const commandEvidence = z.object({
  executionId: z.string().min(1).max(240), command: z.string().min(1).max(40),
  paths: z.array(selfImprovementPathSchema).max(20),
  outputSha256: selfImprovementDigestSchema, workspaceSha256: selfImprovementDigestSchema,
  exitCode: z.number().int(), totalTests: z.number().int().nonnegative(),
  passedTests: z.number().int().nonnegative(), failedTests: z.number().int().nonnegative(),
  pendingTests: z.number().int().nonnegative().optional(),
  executedPaths: z.array(selfImprovementPathSchema).max(30).optional(),
  completedAt: z.string().datetime(),
}).strict();
export const improvementPreparationCheckSchema = z.object({
  evidence: commandEvidence, output: z.string().max(4_000), reportComplete: z.boolean(),
}).strict();
export const improvementPreparationSchema = z.object({
  attempt: z.number().int().min(0).max(1), workspaceSha256: selfImprovementDigestSchema,
  testHashes: z.record(selfImprovementPathSchema, selfImprovementDigestSchema),
  checks: z.array(improvementPreparationCheckSchema).max(3), accepted: z.boolean(),
}).strict();
export type ImprovementPreparation = z.infer<typeof improvementPreparationSchema>;
export type ImprovementPreparationCheck = z.infer<typeof improvementPreparationCheckSchema>;

/** A sanity gate, not proof that a passing control is semantically relevant. */
export function improvementPreparationPassed(preparation: ImprovementPreparation, plan: ImprovementPlan): boolean {
  const pathsEqual = (left: readonly string[], right: readonly string[]) =>
    JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  const native = plan.releaseTarget === "macos_app";
  const expected = native ? ["macos_analyze", "macos_test_focused"] : ["lint_focused", "typecheck_direct", "test_focused"];
  if (!pathsEqual(Object.keys(preparation.testHashes), plan.focusedTestPaths) || preparation.checks.length !== expected.length ||
      preparation.checks.some((item, index) => !item.reportComplete || item.evidence.command !== expected[index] ||
        item.evidence.workspaceSha256 !== preparation.workspaceSha256)) return false;
  const statics = preparation.checks.slice(0, -1);
  if (statics.some(item => item.evidence.exitCode !== 0) ||
      !pathsEqual(statics[0].evidence.paths, native ? [...plan.sourcePaths, ...plan.focusedTestPaths] : plan.focusedTestPaths) ||
      (!native && statics[1].evidence.paths.length !== 0)) return false;
  const test = preparation.checks.at(-1)!.evidence;
  return test.exitCode !== 0 && test.passedTests >= 1 && test.failedTests >= 1 && test.pendingTests === 0 &&
    test.totalTests === test.passedTests + test.failedTests && pathsEqual(test.paths, plan.focusedTestPaths) &&
    pathsEqual(test.executedPaths || [], plan.focusedTestPaths);
}
export const selfImprovementRuntimeSchema = z.object({
  version: z.literal(1), phase: improvementPhaseSchema,
  native: selfImprovementNativeRuntimeSchema.optional(),
  releasePairedBaseline: nativePairedBaselineSchema.optional(),
  releaseRecoveryOnly: z.object({ version: z.literal(1), releaseBindingSha256: selfImprovementDigestSchema, controllerId: z.string().min(1).max(120), recoveredAt: z.string().datetime() }).strict().optional(),
  setupStep: z.enum(["create", "bind", "checkout", "complete"]).default("create"),
  plan: improvementPlanSchema.nullable().default(null),
  agentRuns: z.array(z.object({ phase: improvementPhaseSchema, agentId: z.enum(["atlas", "forge", "sentinel"]), runId: z.string().uuid(), costCeilingUsd: z.number().min(0).max(100), completed: z.boolean() }).strict()).max(6).default([]),
  forgeReceipts: z.array(forgeHandoffReceiptSchema).max(3).optional(),
  phaseAttempt: z.object({ key: z.string().min(1).max(240), phase: improvementPhaseSchema, startedAt: z.string().datetime(), costCeilingUsd: z.number().min(0).max(100) }).strict().nullable().default(null),
  reservedModelUsd: z.number().min(0).max(100).default(0),
  baseline: commandEvidence.nullable().default(null), checks: z.array(commandEvidence).max(12).default([]),
  // Optional for historical readability; an old baseline alone grants no new source-write authority.
  preparations: z.array(improvementPreparationSchema).max(2).optional(),
  correctionKind: z.enum(["test_preparation", "source"]).optional(),
  correctionChecks: z.array(improvementPreparationCheckSchema).max(4).optional(),
  baselineOutput: z.string().max(12_000).default(""),
  reviewRunId: z.string().uuid().nullable().default(null),
  architectureImpact: z.enum(["none", "minor", "major"]).default("major"),
  sourceHashes: z.record(z.string(), selfImprovementDigestSchema).default({}),
  summary: z.string().max(2_000).default(""), errorCode: z.string().max(120).nullable().default(null),
}).strict();
export type SelfImprovementRuntime = z.infer<typeof selfImprovementRuntimeSchema>;
export type ImprovementPlan = z.infer<typeof improvementPlanSchema>;
export class ImprovementPhaseFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ImprovementPhaseFailure"; }
}
export function initialSelfImprovementRuntime(): SelfImprovementRuntime {
  return selfImprovementRuntimeSchema.parse({ version: 1, phase: "setup" });
}
// The inspection schema permits 23,000 string code units: 32 paths of 500,
// a 1,000-unit summary and twelve 500-unit criteria. Even six-byte JSON escapes
// for every unit (138,000 bytes) plus keys and the envelope fit within 160 KiB.
// Bound the original response so whitespace or fences cannot hide oversized output.
export const MAX_IMPROVEMENT_AGENT_JSON_BYTES = 160 * 1024;
export function parseImprovementAgentJson<T>(response: string, schema: z.ZodType<T>): T {
  if (response.length > MAX_IMPROVEMENT_AGENT_JSON_BYTES || Buffer.byteLength(response, "utf8") > MAX_IMPROVEMENT_AGENT_JSON_BYTES) {
    throw new Error("Improvement agent JSON exceeds the 160 KiB response limit.");
  }
  let body = response.trim();
  if (body.startsWith("```")) {
    // Accept only a complete outer Markdown fence on its own opening/closing
    // lines. Never extract braces or discard commentary, warnings or documents.
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*)\r?\n```$/i.exec(body);
    if (!fenced) throw new Error("Improvement agent JSON requires one complete outer JSON fence.");
    body = fenced[1];
  }
  return schema.parse(JSON.parse(body));
}
export function reserveImprovementPhase(runtime: SelfImprovementRuntime, dailyBudgetUsd: number, phase: ImprovementPhase, now: string): SelfImprovementRuntime {
  if (runtime.phaseAttempt) throw new Error("An interrupted improvement phase requires reconciliation before another model call.");
  const share = phase === "inspect" ? 0.10 : phase === "reproduce" ? 0.20 : phase === "implement" ? 0.20 : phase === "review" ? 0.10 : 0;
  if (!share) throw new Error("This phase does not make model calls.");
  const costCeilingUsd = Math.floor(dailyBudgetUsd * share * 1_000_000) / 1_000_000;
  if (costCeilingUsd <= 0 || runtime.reservedModelUsd + costCeilingUsd > dailyBudgetUsd * 0.9 + 0.000001) throw new Error("The improvement cycle has exhausted its model reservation; release verification keeps a separate allowance.");
  return selfImprovementRuntimeSchema.parse({ ...runtime, reservedModelUsd: runtime.reservedModelUsd + costCeilingUsd,
    phaseAttempt: { key: `${phase}:${runtime.agentRuns.length}`, phase, startedAt: now, costCeilingUsd } });
}

/** Native waiting is bounded and never creates additional model or dollar allowance. */
export function selfImprovementExecutionElapsedMs(createdAt: string, raw: unknown, now = new Date().toISOString()): number {
  const parsed = selfImprovementRuntimeSchema.safeParse(raw);
  const native = parsed.success ? parsed.data.native : undefined;
  const waiting = native ? Math.min(86_400_000, native.waitedMs + (native.waitStartedAt ? Math.max(0, Date.parse(now) - Date.parse(native.waitStartedAt)) : 0)) : 0;
  return Math.max(0, Date.parse(now) - Date.parse(createdAt) - waiting);
}
