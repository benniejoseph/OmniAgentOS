import { describe, expect, it, vi } from "vitest";
import { createReviewCompletionGate } from "./review-completion";
import { reviewCompletionReceiptSchema, assertReviewCompletionBinding } from "./review-contracts";
import { reviewFixture } from "./review-test-fixtures";
import { parseAppBuilderSentinelVerdict, parseBoundAppBuilderSentinelVerdict } from "@/lib/app-builder/sentinel-review";

function setup() {
  const fixture = reviewFixture(), assertCurrent = vi.fn(async () => undefined), assertEvidenceCurrent = vi.fn(async () => undefined);
  const readReceipts = vi.fn(async () => fixture.reads);
  const gate = createReviewCompletionGate({ runId: fixture.runId, manifest: fixture.manifest, assertCurrent, assertEvidenceCurrent, readReceipts });
  return { ...fixture, assertCurrent, assertEvidenceCurrent, readReceipts, gate };
}

describe("exact required-criterion Sentinel completion", () => {
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
