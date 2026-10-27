import { z } from "zod";
import { selfImprovementPathSchema, selfImprovementSha256 } from "./contracts";
import { improvementInspectionSchema, parseImprovementAgentJson } from "./runtime";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const handle = z.string().min(1).max(240).regex(/^[^\u0000-\u001f\u007f]+$/);
export const inspectionReadReceiptSchema = z.object({
  executionId: handle, path: selfImprovementPathSchema, inputSha256: digest, scopeSha256: digest,
}).strict();
export type InspectionReadReceipt = z.infer<typeof inspectionReadReceiptSchema>;
export const inspectionCompletionReceiptSchema = z.object({
  version: z.literal(1), runId: z.string().uuid(), sessionId: z.string().regex(/^app_build_[a-f0-9]{48}$/),
  outcome: z.enum(["reminder", "needs_reads", "accepted", "rejected"]),
  reason: z.enum(["missing_adjacent_read", "missing_plan_reads", "evidence_unavailable", "invalid_result", "incomplete_run", "completion_budget_unavailable", "complete"]),
  correctionUsed: z.boolean(), reads: z.array(inspectionReadReceiptSchema).max(48),
  missingSourcePaths: z.array(selfImprovementPathSchema).max(12),
  adjacentCandidates: z.array(selfImprovementPathSchema).max(6),
  result: improvementInspectionSchema.optional(), resultSha256: digest.optional(), receiptSha256: digest,
}).strict().superRefine((value, context) => {
  const { receiptSha256, ...body } = value;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 48 * 1024 || selfImprovementSha256("inspection_completion", body) !== receiptSha256 ||
      (value.outcome === "accepted") !== (value.result !== undefined && value.resultSha256 !== undefined) ||
      (value.result && selfImprovementSha256("inspection_result", value.result) !== value.resultSha256)) {
    context.addIssue({ code: "custom", message: "Inspection completion receipt changed." });
  }
});
export type InspectionCompletionReceipt = z.infer<typeof inspectionCompletionReceiptSchema>;
export type InspectionResult = z.infer<typeof improvementInspectionSchema>;
export type InspectionCompletionGate = Readonly<{
  runId: string;
  beforeTurn: () => Promise<({ stop: false; feedback: string } | { stop: true }) & { receipt: InspectionCompletionReceipt } | undefined>;
  assessFinal: (input: { text: string; incomplete: boolean; canCorrect: boolean }) => Promise<{ receipt: InspectionCompletionReceipt; feedback?: string }>;
  accepted: () => InspectionCompletionReceipt | undefined;
}>;

export const isInspectionTestPath = (path: string) => /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.dart)$/.test(path);
export const isInspectionImplementationPath = (path: string) => /^(?:src|apps\/flutter\/lib)\/.+\.(?:[cm]?[jt]sx?|dart)$/.test(path) && !isInspectionTestPath(path) && !/(?:^|\/)(?:config|configuration|[^/]+\.config)\.[^/]+$/.test(path);

/** One semantic correction within the original run. It grants no tool or budget authority. */
export function createInspectionCompletionGate(input: {
  runId: string; sessionId: string; assertCurrent: () => Promise<void>;
  readReceipts: () => Promise<InspectionReadReceipt[]>;
}): InspectionCompletionGate {
  let reminderSent = false, correctionUsed = false;
  let accepted: InspectionCompletionReceipt | undefined;
  const receipt = (values: Omit<InspectionCompletionReceipt, "version" | "runId" | "sessionId" | "correctionUsed" | "receiptSha256">) => {
    let body = { version: 1 as const, runId: input.runId, sessionId: input.sessionId, correctionUsed, ...values };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 47 * 1024) {
      body = { version: 1 as const, runId: input.runId, sessionId: input.sessionId, correctionUsed, outcome: "rejected", reason: "evidence_unavailable", reads: [], missingSourcePaths: [], adjacentCandidates: [] };
    }
    return inspectionCompletionReceiptSchema.parse({ ...body, receiptSha256: selfImprovementSha256("inspection_completion", body) });
  };
  const read = async () => {
    await input.assertCurrent();
    return z.array(inspectionReadReceiptSchema).max(48).parse(await input.readReceipts());
  };
  return {
    runId: input.runId,
    accepted: () => accepted,
    async beforeTurn() {
      // Revalidate even after the once-only reminder. A known authority loss
      // must stop before the next reservation, while retaining prior costs.
      let reads: InspectionReadReceipt[];
      try { reads = await read(); } catch {
        return { stop: true, receipt: receipt({ outcome: "rejected", reason: "evidence_unavailable", reads: [], missingSourcePaths: [], adjacentCandidates: [] }) };
      }
      if (reminderSent || accepted) return;
      if (!reads.some(item => isInspectionImplementationPath(item.path)) || reads.some(item => isInspectionTestPath(item.path))) return;
      reminderSent = true;
      return { stop: false, feedback: "Inspection evidence is incomplete: implementation was read, but no existing adjacent test file has been read. Before submitting your result, use app.projects.builder.file.read to inspect a relevant existing adjacent test. Search hits and proposed validation filenames are not file-read evidence. Keep the original scope and remaining budget.",
        receipt: receipt({ outcome: "reminder", reason: "missing_adjacent_read", reads, missingSourcePaths: [], adjacentCandidates: [] }) };
    },
    async assessFinal({ text, incomplete, canCorrect }) {
      let reads: InspectionReadReceipt[];
      try { reads = await read(); } catch {
        return { receipt: receipt({ outcome: "rejected", reason: "evidence_unavailable", reads: [], missingSourcePaths: [], adjacentCandidates: [] }) };
      }
      const rejected = (reason: InspectionCompletionReceipt["reason"], missingSourcePaths: string[] = [], adjacentCandidates: string[] = []) => ({ receipt: receipt({ outcome: "rejected", reason, reads, missingSourcePaths, adjacentCandidates }) });
      if (incomplete) return rejected("incomplete_run");
      let result: InspectionResult;
      try { result = parseImprovementAgentJson(text, improvementInspectionSchema); } catch { return rejected("invalid_result"); }
      const paths = new Set(reads.map(item => item.path));
      const missingSourcePaths = result.decision === "repair" ? result.plan.sourcePaths.filter(path => !paths.has(path)) : [];
      const adjacentCandidates = result.decision === "repair" ? result.plan.adjacentTestPaths : [];
      const hasSource = result.decision === "repair" ? missingSourcePaths.length === 0 : reads.some(item => isInspectionImplementationPath(item.path));
      const hasTest = result.decision === "repair" ? adjacentCandidates.some(path => paths.has(path)) : reads.some(item => isInspectionTestPath(item.path));
      if (hasSource && hasTest) {
        accepted = receipt({ outcome: "accepted", reason: "complete", reads, missingSourcePaths: [], adjacentCandidates: [], result,
          resultSha256: selfImprovementSha256("inspection_result", result) });
        return { receipt: accepted };
      }
      if (correctionUsed || !canCorrect) return rejected(canCorrect ? "missing_plan_reads" : "completion_budget_unavailable", missingSourcePaths, adjacentCandidates);
      correctionUsed = true;
      return { receipt: receipt({ outcome: "needs_reads", reason: "missing_plan_reads", reads, missingSourcePaths, adjacentCandidates }),
        feedback: `Your inspection result is not accepted: required governed reads are missing. ${missingSourcePaths.length ? `Read every missing source path: ${JSON.stringify(missingSourcePaths)}. ` : ""}${hasTest ? "" : adjacentCandidates.length ? `Read at least one existing adjacent test from: ${JSON.stringify(adjacentCandidates)}. ` : "Read a relevant existing adjacent test. "}${hasSource ? "" : result.decision === "no_change" ? "Read actual implementation code; documentation alone does not establish no_change. " : ""}This is your one completion opportunity in the same run and remaining budget. Use the governed read tools, then submit one complete JSON result. Preserve all intended future validation targets; do not claim unread files were inspected.` };
    },
  };
}
