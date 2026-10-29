import { describe, expect, it, vi } from "vitest";
import { createReviewCompletionGate } from "./review-completion";
import { reviewCompletionReceiptSchema, assertReviewCompletionBinding, reviewReferenceReads } from "./review-contracts";
import { reviewFixture } from "./review-test-fixtures";
import { parseAppBuilderSentinelVerdict } from "@/lib/app-builder/sentinel-review";
import { parseBoundAppBuilderSentinelVerdict } from "@/lib/app-builder/sentinel-review.server";

function setup() {
  const fixture = reviewFixture(), assertCurrent = vi.fn(async () => undefined), assertEvidenceCurrent = vi.fn(async () => undefined);
  const readReceipts = vi.fn(async () => fixture.reads);
  const gate = createReviewCompletionGate({ runId: fixture.runId, manifest: fixture.manifest, assertCurrent, assertEvidenceCurrent, readReceipts });
  return { ...fixture, assertCurrent, assertEvidenceCurrent, readReceipts, gate };
}

describe("exact required-criterion Sentinel completion", () => {
  it.each(["adjacent", "overlap", "gap", "wrong_hash", "wrong_path", "duplicate_id"] as const)("uses only continuous delivered page evidence: %s", async mode => {
    const f = reviewFixture(), first = { ...f.reads[1], endLine: 10 }, second = { ...f.reads[1], executionId: mode === "duplicate_id" ? first.executionId : "continued-read", startLine: mode === "overlap" ? 10 : mode === "gap" ? 12 : 11,
      ...(mode === "wrong_hash" ? { sha256: "d".repeat(64) } : {}), ...(mode === "wrong_path" ? { path: "src/other.test.ts" } : {}) };
    f.result.criteria[0].evidence[0] = { ...f.result.criteria[0].evidence[0], startLine: 8, endLine: 15 };
    const reads = [f.reads[0], second, first];
    const gate = createReviewCompletionGate({ runId: f.runId, manifest: f.manifest, assertCurrent: async () => undefined, readReceipts: async () => reads });
    const receipt = await gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false });
    expect(receipt.outcome).toBe(mode === "adjacent" || mode === "overlap" ? "passed" : "rejected");
    if (receipt.outcome === "passed") {
      expect(receipt.reads.map(read => read.executionId)).toContain(second.executionId);
      expect(reviewCompletionReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(reviewCompletionReceiptSchema.safeParse({ ...receipt, reads: receipt.reads.filter(read => read.executionId !== second.executionId) }).success).toBe(false);
    } else if (mode === "gap" || mode === "wrong_hash" || mode === "wrong_path") expect(reviewReferenceReads(f.result.criteria[0].evidence[0], reads)).toBeUndefined();
  });
  it.each(["satisfied", "unmet", "unverified"] as const)("keeps supplemental baseline citations valid for a %s criterion without changing its verdict", async status => {
    const f = setup();
    f.result.criteria[0].status = status;
    f.result.criteria[0].evidence.push({ ...f.result.baselineControl.evidence[0] });
    if (status !== "satisfied") f.result.criteria[0].evidence.shift();
    expect(await f.gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false })).toMatchObject({
      outcome: status === "satisfied" ? "passed" : "blocked", reason: status === "satisfied" ? "complete" : "criteria_not_satisfied", result: f.result });
  });
  it.each(["criterion", "baselineControl"] as const)("never lets corroboration substitute for required %s proof", async target => {
    const f = setup();
    if (target === "criterion") f.result.criteria[0].evidence = [{ ...f.result.baselineControl.evidence[0] }];
    else f.result.baselineControl.evidence = [{ ...f.result.criteria[0].evidence[0] }];
    expect(await f.gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false })).toMatchObject({ outcome: "rejected", reason: "evidence_unavailable",
      evidenceFailure: { code: "required_check_missing", criterionId: target === "criterion" ? "c1" : "baselineControl" } });
  });
  it.each(["valid", "unverified", "unknown_path", "changed_hash", "wrong_snapshot", "changed_selected_hash", "changed_after_reads"] as const)("binds contextual reads to the private checkpoint index: %s", async mode => {
    const f = reviewFixture(), contextPath = "src/consumer.ts", contextHash = "c".repeat(64);
    f.result.criteria[0].evidence.push({ path: contextPath, startLine: 1, endLine: 3 });
    if (mode === "unverified") f.result.criteria[0].status = "unverified";
    const reads = [...f.reads, { ...f.reads[0], executionId: "context-read", path: contextPath, sha256: mode === "changed_hash" ? "d".repeat(64) : contextHash }];
    const workspaceIndex = { workspaceSha256: mode === "wrong_snapshot" ? "d".repeat(64) : f.manifest.workspaceSha256,
      fileHashes: { ...f.manifest.fileHashes, ...(mode === "unknown_path" ? {} : { [contextPath]: contextHash }),
        ...(mode === "changed_selected_hash" ? { [f.manifest.sourcePaths[0]]: "e".repeat(64) } : {}) } };
    const assertEvidenceCurrent = vi.fn(async () => undefined);
    if (mode === "changed_after_reads") assertEvidenceCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("changed"));
    const gate = createReviewCompletionGate({ runId: f.runId, manifest: f.manifest, workspaceIndex, assertCurrent: async () => undefined, assertEvidenceCurrent, readReceipts: async () => reads });
    const receipt = await gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false });
    expect(receipt.outcome).toBe(mode === "valid" ? "passed" : mode === "unverified" ? "blocked" : "rejected");
    if (mode === "valid" || mode === "unverified") {
      expect(receipt.reads).toContainEqual(reads[2]);
      expect(reviewCompletionReceiptSchema.safeParse(receipt).success).toBe(true);
      expect(receipt).not.toHaveProperty("fileHashes");
      expect(receipt).not.toHaveProperty("workspaceIndex");
    } else expect(receipt.evidenceFailure?.code).toBe(mode === "wrong_snapshot" || mode === "changed_selected_hash" ? "workspace_index_mismatch" : mode === "changed_after_reads" ? "workspace_changed" : "read_hash_mismatch");
  });
  it("accepts only a whole latest submission supported by current scoped reads and checks", async () => {
    const f = setup(), receipt = await f.gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false });
    expect(receipt).toMatchObject({ outcome: "passed", criterionCount: 2, result: f.result });
    expect(receipt.reads.map(item => item.executionId).sort()).toEqual(["read0", "read1"]);
    expect(f.assertEvidenceCurrent).toHaveBeenCalledTimes(2);
    expect(reviewCompletionReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(assertReviewCompletionBinding(receipt, { tenantId: f.manifest.tenantId, ownerActorId: f.manifest.ownerActorId, projectId: f.manifest.projectId, cycleId: f.manifest.cycleId,
      policySha256: f.manifest.policySha256, sessionId: f.manifest.sessionId, checkpointId: f.manifest.checkpointId, verificationId: f.manifest.verificationId,
      workspaceSha256: f.manifest.workspaceSha256, plan: f.plan, runId: f.runId, preparation: f.preparation, baseline: f.baseline, checks: f.checks })).toEqual(receipt);
  });
  it("seals optional supervision and closed diagnostics while preserving historical receipts", async () => {
    const f = reviewFixture(), supervisionSha256 = "c".repeat(64);
    const gate = createReviewCompletionGate({ runId: f.runId, manifest: { ...f.manifest, supervisionSha256 }, assertCurrent: async () => undefined, readReceipts: async () => f.reads });
    const receipt = await gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false });
    const { tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256 } = f.manifest;
    const binding = { tenantId, ownerActorId, projectId, cycleId, policySha256, sessionId, checkpointId, verificationId, workspaceSha256,
      plan: f.plan, runId: f.runId, preparation: f.preparation, baseline: f.baseline, checks: f.checks, supervisionSha256 };
    expect(assertReviewCompletionBinding(receipt, binding)).toEqual(receipt);
    expect(() => assertReviewCompletionBinding(receipt, { ...binding, supervisionSha256: "d".repeat(64) })).toThrow("exact, complete");
    expect(reviewCompletionReceiptSchema.safeParse({ ...receipt, evidenceFailure: { code: "workspace_changed" } }).success).toBe(false);
    const bad = setup(); bad.result.criteria[0].evidence[0].endLine = 21;
    const rejected = await bad.gate.assessFinal({ text: JSON.stringify(bad.result), incomplete: false });
    expect(rejected.evidenceFailure).toEqual({ code: "reference_range_unavailable", criterionId: "c1", referenceIndex: 0 });
    expect(reviewCompletionReceiptSchema.safeParse(rejected).success).toBe(true);
    expect(reviewCompletionReceiptSchema.safeParse({ ...rejected, evidenceFailure: { code: "untrusted error text" } }).success).toBe(false);
  });
  it.each(["omitted", "duplicate", "extra", "trailing", "prefix", "conflicting_keys", "overall_pass", "malformed"])("rejects %s instead of interpreting soft PASS", async mode => {
    const f = setup(), result = structuredClone(f.result);
    if (mode === "omitted") result.criteria.pop();
    if (mode === "duplicate") result.criteria[1].criterionId = "c1";
    if (mode === "extra") result.criteria.push({ ...result.criteria[0], criterionId: "c3" });
    let text = JSON.stringify(result);
    if (mode === "trailing") text += "\nPASS";
    if (mode === "prefix") text = "PASS\n" + text;
    if (mode === "conflicting_keys") text = text.replace('"status":"satisfied"', '"status":"unmet","status":"satisfied"');
    if (mode === "overall_pass") text = text.replace('{"architectureImpact"', '{"verdict":"PASS","architectureImpact"');
    if (mode === "malformed") text = "{}";
    expect(await f.gate.assessFinal({ text, incomplete: false })).toMatchObject({ outcome: "rejected", reason: "invalid_result" });
  });
  it.each(["unmet", "unverified"] as const)("blocks a required %s criterion and never lets aggregate green counts waive it", async status => {
    const f = setup(); f.result.criteria[1].status = status; f.result.criteria[1].evidence = [];
    const receipt = await f.gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false });
    expect(receipt).toMatchObject({ outcome: "blocked", reason: "criteria_not_satisfied" });
    const { tenantId, ownerActorId, projectId, sessionId, checkpointId, verificationId, workspaceSha256 } = f.manifest;
    expect(parseBoundAppBuilderSentinelVerdict(receipt, { tenantId, ownerActorId, projectId, sessionId, checkpointId, verificationId, workspaceSha256, runId: f.runId })).toBe("blocked");
  });
  it.each(["range", "path", "hash", "missing_source", "missing_test", "wrong_check", "no_test_support", "baseline_unverified", "changed_workspace", "pause"])("refuses unsupported or changed evidence: %s", async mode => {
    const f = setup();
    if (mode === "range") f.result.criteria[0].evidence[0].endLine = 21;
    if (mode === "path") f.result.criteria[0].evidence[0].path = "src/foreign.test.ts";
    if (mode === "hash") f.reads[1].sha256 = "f".repeat(64);
    if (mode === "missing_source") f.reads.shift();
    if (mode === "missing_test") f.reads.pop();
    if (mode === "wrong_check") f.result.criteria[0].evidence[0].checkId = "candidate:3";
    if (mode === "no_test_support") delete f.result.criteria[0].evidence[0].checkId;
    if (mode === "baseline_unverified") f.result.baselineControl.status = "unverified";
    if (mode === "changed_workspace") f.assertEvidenceCurrent.mockRejectedValue(new Error("changed"));
    if (mode === "pause") f.assertCurrent.mockRejectedValue(new Error("paused"));
    expect((await f.gate.assessFinal({ text: JSON.stringify(f.result), incomplete: false })).outcome).not.toBe("passed");
  });
  it("stops after authority loss and rejects incomplete final output without another model request", async () => {
    const f = setup();
    expect(await f.gate.assessFinal({ text: JSON.stringify(f.result), incomplete: true })).toMatchObject({ outcome: "rejected", reason: "incomplete_run" });
    expect(f.readReceipts).not.toHaveBeenCalled();
    const g = setup(); g.assertCurrent.mockRejectedValue(new Error("paused"));
    expect(await g.gate.beforeTurn()).toMatchObject({ stop: true, receipt: { reason: "evidence_unavailable" } });
  });
  it("uses the same exact criterion gate for native analyze/test evidence", async () => {
    const f = reviewFixture(), source = "apps/flutter/lib/features/example.dart", test = "apps/flutter/test/features/example_test.dart";
    const manifest = { ...f.manifest, sourcePaths: [source], focusedTestPaths: [test], fileHashes: { [source]: "a".repeat(64), [test]: "a".repeat(64) },
      checks: f.manifest.checks.map(check => ({ ...check, paths: [test], command: check.command === "test_focused" ? "macos_test_focused" : "macos_analyze" })) };
    const result = structuredClone(f.result); for (const assessment of [result.baselineControl, ...result.criteria]) for (const reference of assessment.evidence) reference.path = test;
    const gate = createReviewCompletionGate({ runId: f.runId, manifest, assertCurrent: async () => undefined, readReceipts: async () => f.reads.map((read, index) => ({ ...read, path: index ? test : source })) });
    expect(await gate.assessFinal({ text: JSON.stringify(result), incomplete: false })).toMatchObject({ outcome: "passed" });
  });
  it("returns bounded incomplete evidence instead of throwing after measured work on an oversized legal result", async () => {
    const f = reviewFixture(), test = `src/${"界".repeat(450)}.test.ts`;
    const manifest = { ...f.manifest, criteria: Array.from({ length: 12 }, (_, i) => `Required ${i}`), focusedTestPaths: [test],
      fileHashes: { [f.manifest.sourcePaths[0]]: "a".repeat(64), [test]: "a".repeat(64) }, checks: f.manifest.checks.map(check => ({ ...check, paths: [test] })) };
    const assessment = { status: "satisfied" as const, rationale: "Exact evidence.", evidence: Array.from({ length: 4 }, () => ({ path: test, startLine: 1, endLine: 1, checkId: "candidate:2" })) };
    const result = { ...f.result, baselineControl: { ...assessment, evidence: [{ path: test, startLine: 1, endLine: 1, checkId: "baseline" }] }, criteria: manifest.criteria.map((_, i) => ({ ...assessment, criterionId: `c${i + 1}` })) };
    const gate = createReviewCompletionGate({ runId: f.runId, manifest, assertCurrent: async () => undefined, readReceipts: async () => f.reads.map((read, index) => index ? { ...read, path: test } : read) });
    const receipt = await gate.assessFinal({ text: JSON.stringify(result), incomplete: false });
    expect(receipt).toMatchObject({ outcome: "rejected", reason: "evidence_unavailable", reads: [] });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(48 * 1024);
  });
  it("rejects PASS-with-admitted-gaps while ordinary Builder PASS remains compatible", async () => {
    // Synthetic incident shape. Exact captured response stays in private evidence.
    const captured = "PASS\nArchitecture impact: none\nThe suite is green. Required semantic validation, partial selection and history checks are missing; add them later as strengthening.";
    const f = setup(); expect(parseAppBuilderSentinelVerdict(captured)).toBe("passed");
    expect(await f.gate.assessFinal({ text: captured, incomplete: false })).toMatchObject({ outcome: "rejected", reason: "invalid_result" });
  });
});
