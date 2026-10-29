import { selfImprovementSha256 } from "./contracts";
import { parseImprovementAgentJson } from "./runtime";
import { reviewCompletionReceiptSchema, reviewManifestSchema, reviewReadSchema, reviewReferenceReads, reviewSubmissionSchema, type ReviewCompletionReceipt, type ReviewEvidenceFailure, type ReviewManifest, type ReviewRead, type ReviewSubmission, type ReviewWorkspaceIndex } from "./review-contracts";
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
  workspaceIndex?: ReviewWorkspaceIndex;
  assertEvidenceCurrent?: () => Promise<void>;
  readReceipts: () => Promise<ReviewRead[]>; observeTool?: (observation: InspectionToolObservation) => void;
}): ReviewCompletionGate {
  const manifest = reviewManifestSchema.parse(input.manifest);
  const workspaceIndex = input.workspaceIndex && { workspaceSha256: input.workspaceIndex.workspaceSha256, fileHashes: Object.freeze({ ...input.workspaceIndex.fileHashes }) };
  const fileHashes = workspaceIndex?.fileHashes || manifest.fileHashes;
  let final: ReviewCompletionReceipt | undefined;
  const seal = (reason: ReviewCompletionReceipt["reason"], result?: ReviewSubmission, reads: ReviewRead[] = [], evidenceFailure?: ReviewEvidenceFailure) => {
    const { tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256, planSha256, preparationSha256, checksSha256 } = manifest;
    const base = { version: 1 as const, runId: input.runId, tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256, planSha256, preparationSha256, checksSha256,
      manifestSha256: selfImprovementSha256("review_manifest", manifest), criterionCount: manifest.criteria.length,
      ...(manifest.supervisionSha256 ? { supervisionSha256: manifest.supervisionSha256 } : {}) };
    let body = { ...base, outcome: (reason === "complete" ? "passed" : reason === "criteria_not_satisfied" ? "blocked" : "rejected") as ReviewCompletionReceipt["outcome"], reason, reads, ...(evidenceFailure ? { evidenceFailure } : {}),
      ...(result ? { result, resultSha256: selfImprovementSha256("review_result", result) } : {}) };
    if (Buffer.byteLength(JSON.stringify(body), "utf8") > 47 * 1024) body = { ...base, outcome: "rejected", reason: "evidence_unavailable", reads: [], evidenceFailure: { code: "receipt_too_large" } };
    final = reviewCompletionReceiptSchema.parse({ ...body, receiptSha256: selfImprovementSha256("review_completion", body) });
    return final;
  };
  return {
    runId: input.runId, observeTool: input.observeTool, receipt: () => final,
    async beforeTurn() {
      try { await input.assertCurrent(); } catch { return { stop: true, receipt: seal("evidence_unavailable", undefined, [], { code: "authority_unavailable" }) }; }
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
      let evidenceStage: ReviewEvidenceFailure["code"] = "authority_unavailable";
      try {
        await input.assertCurrent();
        evidenceStage = "workspace_changed";
        await input.assertEvidenceCurrent?.();
        if (workspaceIndex && (workspaceIndex.workspaceSha256 !== manifest.workspaceSha256 ||
            Object.entries(manifest.fileHashes).some(([path, hash]) => !Object.hasOwn(fileHashes, path) || fileHashes[path] !== hash))) {
          return seal("evidence_unavailable", undefined, [], { code: "workspace_index_mismatch" });
        }
        evidenceStage = "read_receipt_unavailable";
        const reads = (await input.readReceipts()).map(item => reviewReadSchema.parse(item));
        if (reads.length > 48 || new Set(reads.map(read => read.executionId)).size !== reads.length) return seal("evidence_unavailable", undefined, [], { code: "read_receipt_unavailable" });
        if (reads.some(read => !Object.hasOwn(fileHashes, read.path) || fileHashes[read.path] !== read.sha256)) return seal("evidence_unavailable", undefined, [], { code: "read_hash_mismatch" });
        const used = new Map<string, ReviewRead>();
        const assess = (item: ReviewSubmission["baselineControl"], baseline: boolean, criterionId: string): ReviewEvidenceFailure | undefined => {
          let testProof = false;
          for (const [referenceIndex, reference] of item.evidence.entries()) {
            const coveringReads = reviewReferenceReads(reference, reads);
            if (!coveringReads) return { code: "reference_range_unavailable", criterionId, referenceIndex };
            for (const read of coveringReads) used.set(read.executionId, read);
            if (reference.checkId) {
              const check = manifest.checks.find(check => check.id === reference.checkId);
              if (!check || !check.paths.includes(reference.path) || !check.command.includes("test_focused")) return { code: "check_reference_mismatch", criterionId, referenceIndex };
              const redBaseline = check.id === "baseline" && check.passedTests >= 1 && check.failedTests >= 1;
              const greenCandidate = check.id !== "baseline" && check.exitCode === 0 && check.totalTests >= 1 && check.passedTests === check.totalTests && check.failedTests === 0;
              if (!redBaseline && !greenCandidate) return { code: "check_reference_mismatch", criterionId, referenceIndex };
              // Corroborating citations do not substitute for the required evidence class.
              if (baseline ? redBaseline : greenCandidate) testProof = true;
            }
          }
          return item.status === "satisfied" && !testProof ? { code: "required_check_missing", criterionId } : undefined;
        };
        const failure = assess(result.baselineControl, true, "baselineControl") || result.criteria.map(item => assess(item, false, item.criterionId)).find(Boolean);
        if (failure) return seal("evidence_unavailable", undefined, [], failure);
        for (const path of [...manifest.sourcePaths, ...manifest.focusedTestPaths]) {
          const read = reads.find(read => read.path === path);
          if (!read) return seal("evidence_unavailable", undefined, [], { code: "required_file_unread" });
          used.set(read.executionId, read);
        }
        evidenceStage = "authority_unavailable";
        await input.assertCurrent();
        evidenceStage = "workspace_changed";
        await input.assertEvidenceCurrent?.();
        return seal(result.baselineControl.status === "satisfied" && result.criteria.every(item => item.status === "satisfied") ? "complete" : "criteria_not_satisfied", result, [...used.values()]);
      } catch { return seal("evidence_unavailable", undefined, [], { code: evidenceStage }); }
    },
  };
}
