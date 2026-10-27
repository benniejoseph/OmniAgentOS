import { z } from "zod";
import { selfImprovementDigestSchema, selfImprovementPathSchema, selfImprovementSha256 } from "./contracts";
import type { ImprovementPlan } from "./runtime";
import type { InspectionToolObservation } from "./inspection-completion";

const handle = z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/);
const digest = selfImprovementDigestSchema;
export const FORGE_CONTEXT_MAX_READS = 6;
export const FORGE_CONTEXT_RESULT_CHARS = 8_000;
export type ForgePlan = Readonly<{ phase: "reproduce" | "implement"; plan: ImprovementPlan; expectedHashes: Readonly<Record<string, string>> }>;
export type ForgeContextRead = Readonly<{ kind: "source" | "adjacent_test" | "focused_test"; path: string; startLine: number; lineCount: number; continuation?: boolean; expectedSha256?: string }>;
const forgeReadSchema = z.object({
  executionId: handle, path: selfImprovementPathSchema, sha256: digest, inputSha256: digest, scopeSha256: digest,
  startLine: z.number().int().positive(), endLine: z.number().int().positive(), totalLines: z.number().int().positive(),
}).strict().refine(value => value.endLine >= value.startLine && value.totalLines >= value.endLine);
export type ForgeReadReceipt = z.infer<typeof forgeReadSchema>;
export const forgeEffectSchema = z.object({
  executionId: handle, toolId: z.enum(["app.projects.builder.file.update", "app.projects.builder.file.edit", "app.projects.builder.file.delete"]),
  path: selfImprovementPathSchema, previousSha256: digest.nullable(), sha256: digest.nullable(), inputSha256: digest, scopeSha256: digest,
}).strict();
export type ForgeEffect = z.infer<typeof forgeEffectSchema>;
export const forgeHandoffReceiptSchema = z.object({
  version: z.literal(1), origin: z.literal("forge_workflow"), runId: z.string().uuid(), sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/),
  phase: z.enum(["reproduce", "implement"]), planSha256: digest,
  outcome: z.enum(["context_collected", "completed", "incomplete"]),
  reason: z.enum(["complete", "budget_unavailable", "evidence_unavailable", "authority_unavailable", "no_changes", "budget_before_effect", "pending_approval", "incomplete_run"]),
  reads: z.array(forgeReadSchema).max(FORGE_CONTEXT_MAX_READS), effects: z.array(forgeEffectSchema).max(48),
  receiptSha256: digest,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 48 * 1024 || selfImprovementSha256("forge_handoff", body) !== receiptSha256 ||
      (value.outcome === "incomplete") === (value.reason === "complete") ||
      (value.outcome === "completed" && !value.effects.length) ||
      (value.outcome === "context_collected" && (!value.reads.length || value.effects.length))) context.addIssue({ code: "custom", message: "Forge handoff receipt changed." });
});
export type ForgeHandoffReceipt = z.infer<typeof forgeHandoffReceiptSchema>;
export type ForgeHandoff = Readonly<{
  runId: string;
  requests: readonly ForgeContextRead[];
  assertCurrent: () => Promise<void>;
  beforeTurn: () => Promise<ForgeHandoffReceipt | undefined>;
  modelStarting: () => void;
  modelAttempted: () => boolean;
  begin: () => void;
  verifyRead: (request: ForgeContextRead, observation: InspectionToolObservation) => Promise<ForgeReadReceipt>;
  finishContext: (reads: ForgeReadReceipt[], reason?: "budget_unavailable" | "evidence_unavailable" | "authority_unavailable") => ForgeHandoffReceipt;
  finish: (effects: ForgeEffect[], reason?: ForgeHandoffReceipt["reason"]) => ForgeHandoffReceipt;
  receipt: () => ForgeHandoffReceipt | undefined;
}>;

/** Saved-plan anchors, not a claim that the remaining plan files were inspected. */
export function createForgeHandoff(input: {
  runId: string; sessionId: string; plan: ForgePlan; assertCurrent: () => Promise<void>;
  verifyRead: ForgeHandoff["verifyRead"];
}): ForgeHandoff {
  const { plan, phase, expectedHashes } = input.plan;
  const requiredHashes = phase === "reproduce" ? plan.sourcePaths : plan.focusedTestPaths;
  if (requiredHashes.some(path => !digest.safeParse(expectedHashes[path]).success)) throw new Error("Forge context requires every original source or fixed-test hash for this phase.");
  const anchors = [
    { kind: "source" as const, path: plan.sourcePaths[0] },
    { kind: "adjacent_test" as const, path: plan.adjacentTestPaths[0] },
    ...(phase === "implement" ? [{ kind: "focused_test" as const, path: plan.focusedTestPaths[0] }] : []),
  ];
  if (anchors.some(item => !selfImprovementPathSchema.safeParse(item.path).success) || new Set(anchors.map(item => item.path)).size !== anchors.length) throw new Error("Forge context requires separate saved plan paths.");
  const requests = anchors.map(item => Object.freeze({ ...item, startLine: 1, lineCount: 200,
    ...(expectedHashes[item.path] ? { expectedSha256: digest.parse(expectedHashes[item.path]) } : {}) }));
  let begun = false, attempted = false, current: ForgeHandoffReceipt | undefined;
  const seal = (outcome: ForgeHandoffReceipt["outcome"], reason: ForgeHandoffReceipt["reason"], reads: ForgeReadReceipt[], effects: ForgeEffect[]) => {
    let body = { version: 1 as const, origin: "forge_workflow" as const, runId: input.runId, sessionId: input.sessionId,
      phase, planSha256: selfImprovementSha256("forge_plan", input.plan), outcome, reason, reads, effects };
    // Bounded persistence must not discard already measured model usage. Keep
    // the run/plan binding and reject completion if legal metadata exceeds it.
    if (Buffer.byteLength(JSON.stringify({ ...body, receiptSha256: "0".repeat(64) }), "utf8") > 48 * 1024) {
      body = { ...body, outcome: "incomplete", reason: "evidence_unavailable", reads: [], effects: [] };
    }
    current = forgeHandoffReceiptSchema.parse({ ...body, receiptSha256: selfImprovementSha256("forge_handoff", body) });
    return current;
  };
  return {
    runId: input.runId, requests, assertCurrent: input.assertCurrent,
    async beforeTurn() {
      if (current?.outcome === "incomplete") return current;
      try { await input.assertCurrent(); return undefined; }
      catch { return seal("incomplete", "authority_unavailable", current?.reads || [], []); }
    },
    modelStarting() { attempted = true; }, modelAttempted: () => attempted,
    begin() { if (begun) throw new Error("The Forge context episode cannot replay."); begun = true; },
    verifyRead: input.verifyRead,
    finishContext: (reads, reason) => seal(reason ? "incomplete" : "context_collected", reason || "complete", reads, []),
    finish(effects, reason) {
      if (current?.outcome === "incomplete") return current;
      if (!current) return seal("incomplete", "evidence_unavailable", [], []);
      return seal(reason && reason !== "complete" ? "incomplete" : effects.length ? "completed" : "incomplete",
        reason && reason !== "complete" ? reason : effects.length ? "complete" : "no_changes", current?.reads || [], effects);
    },
    receipt: () => current,
  };
}

export const FORGE_FINAL_BUDGET_INSTRUCTIONS = "Tools are disabled for this final turn because the existing run budget cannot admit another tool round; this is not missing permission or a disconnected Builder. Report only actual completed file edits. If no edit executed, say the phase remains incomplete within its budget; do not ask the owner to enable tools or treat proposed file contents as a saved change.";
