import { describe, expect, it } from "vitest";
import { buildTerminalReceiptV1, type BuildTerminalReceiptV1Input } from "@/lib/runs/contracts";
import { companionWork, companionPendingWork, companionPresentation, createCompanionReadGate, createCompanionReactionLedger, createCompanionHomeGate } from "./presentation";

function receipt(overrides: Partial<BuildTerminalReceiptV1Input> = {}) {
  return buildTerminalReceiptV1({
    terminalReceiptId: "receipt-a", runId: "run-a", outcomeContractId: "contract-a", source: "outcome_evaluator",
    legacyStatus: null, disposition: "succeeded", executionMode: "live", verificationState: "verified", reasonCode: "all_requirements_verified",
    requirementResults: [{ requirementId: "criterion-a", requirementKind: "criterion", requirementLevel: "required", state: "verified", verificationMethod: "deterministic", verifierId: "verifier-a", verificationReceiptId: "verification-a" }],
    usefulWorkUnitCount: 1, artifactReceiptIds: [], effectReceiptIds: [], verifierReceiptIds: ["verification-a"], pendingApprovalIds: [], blockingDependencyIds: [], outputSha256: null,
    ...overrides,
  });
}
describe("read-only Companion presentation", () => {
  it("permanently supersedes a Home read when an intervening action starts and finishes without a render", () => {
    const gate = createCompanionHomeGate();
    const pendingHome = gate.capture();
    gate.invalidate(); // Synchronous action admission; no observed busy render is required.
    expect(gate.current(pendingHome)).toBe(false);
    const laterHome = gate.capture();
    expect(gate.current(laterHome)).toBe(true);
    gate.invalidate();
    expect(gate.current(pendingHome)).toBe(false);
    expect(gate.current(laterHome)).toBe(false);
  });
  it("preserves a bound queued state before generic Working and never borrows another run's snapshot", () => {
    const queued = companionWork({ status: "queued", runId: "run-a" });
    expect(companionPendingWork("run-a", queued, true)).toMatchObject({ label: "Queued", detail: "Waiting to start." });
    expect(companionPresentation({ work: companionPendingWork("run-a", queued, true) }).label).toBe("Queued");
    expect(companionPendingWork("run-b", queued, false)).toMatchObject({ label: "Status unavailable", runId: "run-b" });
    expect(companionPendingWork("run-b", queued, true).label).toBe("Working");
    const completed = companionWork({ status: "completed", runId: "run-a", terminalReceipt: receipt() });
    expect(companionPendingWork("run-a", completed, true).state).toBe("working");
  });
  it("requires a complete validated terminal receipt bound to the current completed run", () => {
    expect(companionWork({ status: "completed", runId: "run-a", terminalReceipt: receipt() })).toMatchObject({ state: "completed", completionIdentity: '["run-a","receipt-a"]' });
    for (const terminalReceipt of [undefined, { disposition: "succeeded", verificationState: "verified", source: "outcome_evaluator", executionMode: "live" }, { ...receipt(), runId: "other" }, { ...receipt(), verifiedRequirementCount: 99 }]) {
      expect(companionWork({ status: "completed", runId: "run-a", terminalReceipt })).toMatchObject({ state: "available", label: "Outcome unverified" });
    }
    expect(companionWork({ status: "running", runId: "run-a", terminalReceipt: receipt() }).state).toBe("working");
    expect(companionWork({ status: "done", runId: "run-a" }).state).toBe("blocked");
  });
  it("does not celebrate partial, preview, or legacy completion", () => {
    const partial = receipt({ disposition: "partial", verificationState: "partially_verified", reasonCode: "requirements_unmet", requirementResults: [
      { requirementId: "criterion-a", requirementKind: "criterion", requirementLevel: "required", state: "unverified", verificationMethod: "deterministic", verifierId: null, verificationReceiptId: null },
    ] });
    expect(companionWork({ status: "completed", runId: "run-a", terminalReceipt: partial }).state).not.toBe("completed");
    expect(companionWork({ status: "completed", runId: "run-a" }).label).toBe("Outcome unverified");
    expect(companionWork({ status: "completed", runId: "run-a", terminalReceipt: { ...receipt(), executionMode: "dry_run" } }).state).not.toBe("completed");
  });
  it("keeps eight states and waiting work distinct from live audio foreground", () => {
    const work = companionWork({ status: "waiting_approval", runId: "run-a" });
    expect(companionPresentation({ work, microphoneActive: true })).toMatchObject({ state: "listening", work: { label: "Needs approval" } });
    expect(companionPresentation({ work, microphoneActive: true, playbackActive: true }).state).toBe("responding");
    expect(companionPresentation({ work, speechPreparing: true })).toMatchObject({ state: "working", detail: "Preparing reply audio; playback has not started." });
    expect(companionPresentation({ work }).state).toBe("needs_you");
    expect(companionWork({ status: "reconnecting" }).state).toBe("blocked");
    expect(companionWork({ status: "paused" }).state).toBe("paused");
    expect(companionWork({}).state).toBe("available");
    expect(companionWork({ runId: "unknown-run" }).label).toBe("Status unavailable");
  });
  it("deduplicates verified event identities across poll/rerender and ignores unverified events", () => {
    const ledger = createCompanionReactionLedger();
    const verified = companionWork({ status: "completed", runId: "run-a", terminalReceipt: receipt() });
    expect(ledger.accept(companionWork({ status: "completed", runId: "run-a" }))).toBe(false);
    expect(ledger.accept(verified)).toBe(true);
    expect(ledger.accept({ ...verified })).toBe(false);
    expect(ledger.accept(companionWork({ status: "completed", runId: "run-a", terminalReceipt: receipt({ terminalReceiptId: "receipt-b" }) }))).toBe(true);
  });
  it("rejects superseded, disposed, and A-to-B-to-A preference reads", () => {
    const gate = createCompanionReadGate();
    const first = gate.begin('["tenant-a","actor-a"]');
    const second = gate.begin('["tenant-a","actor-b"]');
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(true);
    const third = gate.begin('["tenant-a","actor-a"]');
    expect(gate.current(first)).toBe(false);
    expect(gate.current(third)).toBe(true);
    gate.invalidate();
    expect(gate.current(third)).toBe(false);
  });
});
