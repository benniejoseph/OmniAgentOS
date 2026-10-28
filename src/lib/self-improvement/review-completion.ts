import { selfImprovementSha256 } from "./contracts";
import { parseImprovementAgentJson } from "./runtime";
import { reviewCompletionReceiptSchema, reviewManifestSchema, reviewReadSchema, reviewSubmissionSchema, type ReviewCompletionReceipt, type ReviewManifest, type ReviewRead, type ReviewSubmission } from "./review-contracts";
import type { InspectionToolObservation } from "./inspection-completion";

// JSON.parse validates syntax but overwrites duplicate keys. A second closed
// lexical pass rejects conflicting declarations instead of choosing the last.
function assertUniqueKeys(text: string) {
  const stack: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
  for (const token of text.match(/"(?:\\.|[^"\\])*"|[{}\[\],:]/g) || []) {
    const current = stack.at(-1);
    if (token === "{" || token === "[") stack.push({ object: token === "{", key: token === "{", seen: new Set() });
    else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && current?.object) current.key = true;
    else if (token.startsWith('"') && current?.object && current.key) {
      const key = JSON.parse(token) as string;
      if (current.seen.has(key)) throw new Error("Conflicting review JSON keys.");
      current.seen.add(key); current.key = false;
    }
  }
}

export type ReviewCompletionGate = Readonly<{
  runId: string;
  beforeTurn: () => Promise<{ stop: true; receipt: ReviewCompletionReceipt } | undefined>;
  observeTool?: (observation: InspectionToolObservation) => void;
  assessFinal: (input: { text: string; incomplete: boolean }) => Promise<ReviewCompletionReceipt>;
  receipt: () => ReviewCompletionReceipt | undefined;
}>;

/** One final assessment in the existing run. No repair turn, new authority or model reservation. */
export function createReviewCompletionGate(input: {
  runId: string; manifest: ReviewManifest; assertCurrent: () => Promise<void>;
  assertEvidenceCurrent?: () => Promise<void>;
  readReceipts: () => Promise<ReviewRead[]>; observeTool?: (observation: InspectionToolObservation) => void;
}): ReviewCompletionGate {
  const manifest = reviewManifestSchema.parse(input.manifest);
  let final: ReviewCompletionReceipt | undefined;
  const seal = (reason: ReviewCompletionReceipt["reason"], result?: ReviewSubmission, reads: ReviewRead[] = []) => {
    const { tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256, planSha256, preparationSha256, checksSha256 } = manifest;
    const base = { version: 1 as const, runId: input.runId, tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256, planSha256, preparationSha256, checksSha256,
      manifestSha256: selfImprovementSha256("review_manifest", manifest), criterionCount: manifest.criteria.length };
    let body = { ...base, outcome: (reason === "complete" ? "passed" : reason === "criteria_not_satisfied" ? "blocked" : "rejected") as ReviewCompletionReceipt["outcome"], reason, reads,
      ...(result ? { result, resultSha256: selfImprovementSha256("review_result", result) } : {}) };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 47 * 1024) body = { ...base, outcome: "rejected", reason: "evidence_unavailable", reads: [] };
    final = reviewCompletionReceiptSchema.parse({ ...body, receiptSha256: selfImprovementSha256("review_completion", body) });
    return final;
  };
  return {
    runId: input.runId, observeTool: input.observeTool, receipt: () => final,
    async beforeTurn() {
      try { await input.assertCurrent(); } catch { return { stop: true, receipt: seal("evidence_unavailable") }; }
      return undefined;
    },
    async assessFinal({ text, incomplete }) {
      if (final) return final;
      if (incomplete) return seal("incomplete_run");
      let result: ReviewSubmission;
      try {
        result = parseImprovementAgentJson(text, reviewSubmissionSchema);
        assertUniqueKeys(text);
        const ids = result.criteria.map(item => item.criterionId);
        if (ids.length !== manifest.criteria.length || new Set(ids).size !== ids.length || ids.some(id => !manifest.criteria.map((_, i) => `c${i + 1}`).includes(id))) return seal("invalid_result");
      } catch { return seal("invalid_result"); }
      try {
        await input.assertCurrent();
        await input.assertEvidenceCurrent?.();
        const reads = (await input.readReceipts()).map(item => reviewReadSchema.parse(item));
        if (reads.length > 48 || reads.some(read => manifest.fileHashes[read.path] !== read.sha256)) return seal("evidence_unavailable");
        const used = new Map<string, ReviewRead>();
        const assess = (item: ReviewSubmission["baselineControl"], baseline: boolean) => {
          let testProof = false;
          for (const reference of item.evidence) {
            const read = reads.find(read => read.path === reference.path && read.startLine <= reference.startLine && read.endLine >= reference.endLine);
            if (!read) return false;
            used.set(read.executionId, read);
            if (reference.checkId) {
              const check = manifest.checks.find(check => check.id === reference.checkId);
              if (!check || !check.paths.includes(reference.path) || !check.command.includes("test_focused")) return false;
              if (baseline ? check.id === "baseline" && check.passedTests >= 1 && check.failedTests >= 1 : check.id !== "baseline" && check.exitCode === 0 && check.totalTests >= 1 && check.passedTests === check.totalTests && check.failedTests === 0) testProof = true;
              else return false;
            }
          }
          return item.status !== "satisfied" || testProof;
        };
        if (!assess(result.baselineControl, true) || result.criteria.some(item => !assess(item, false))) return seal("evidence_unavailable");
        for (const path of [...manifest.sourcePaths, ...manifest.focusedTestPaths]) {
          const read = reads.find(read => read.path === path);
          if (!read) return seal("evidence_unavailable");
          used.set(read.executionId, read);
        }
        await input.assertCurrent();
        await input.assertEvidenceCurrent?.();
        return seal(result.baselineControl.status === "satisfied" && result.criteria.every(item => item.status === "satisfied") ? "complete" : "criteria_not_satisfied", result, [...used.values()]);
      } catch { return seal("evidence_unavailable"); }
    },
  };
}
