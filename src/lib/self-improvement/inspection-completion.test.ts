import { describe, expect, it, vi } from "vitest";
import { createInspectionCompletionGate, inspectionCompletionReceiptSchema, type InspectionReadReceipt } from "./inspection-completion";
import { selfImprovementSha256 } from "./contracts";

const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
const read = (path: string, index = 0): InspectionReadReceipt => ({ executionId: `read-${index}`, path, inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64) });
const plan = { decision: "repair", plan: { summary: "Handle empty values.", sourcePaths: ["src/feature.ts"], focusedTestPaths: ["src/regression.test.ts"], adjacentTestPaths: ["src/feature.test.ts", "src/other.test.ts"], acceptanceCriteria: ["Empty values have a fallback."] } };
function fixture(paths = ["src/feature.ts"]) {
  const reads = paths.map(read), assertCurrent = vi.fn(async () => undefined);
  const gate = createInspectionCompletionGate({ runId, sessionId, assertCurrent, readReceipts: async () => reads });
  return { reads, gate, assertCurrent };
}
const assess = (gate: ReturnType<typeof fixture>["gate"], text = JSON.stringify(plan), canCorrect = true) => gate.assessFinal({ text, incomplete: false, canCorrect });

describe("receipt-bound inspection completion", () => {
  it("accepts the observed seven-criterion plan shape with verified source and adjacent reads", async () => {
    // Synthetic paths and prose preserve the public failure's seven distinct
    // requirements without importing owner/project records or private evidence.
    const document = { decision: "repair", plan: {
      summary: "Reject graph duplication that exceeds the edge limit before changing the graph.",
      sourcePaths: ["src/graph.ts"], newSourcePaths: [],
      focusedTestPaths: ["src/graph-duplicate-limit.test.ts"],
      adjacentTestPaths: ["src/graph.test.ts", "src/graph-history.test.ts"],
      acceptanceCriteria: [
        "Build a valid graph with nine sources, nine outputs and all 81 source-to-output edges; schema and graph validation must pass.",
        "Duplicating all 18 nodes rejects the resulting 162 edges before ID allocation; preserve the input graph, nested data and selection.",
        "With exactly one edge removed, duplication reaches exactly 160 edges and remains valid, with the existing offsets, copied titles and independent nested configs.",
        "Selecting eight sources and all outputs duplicates only 72 internal edges, producing a valid graph with 35 nodes and 153 edges.",
        "Copied internal edges use fresh unique IDs and remapped endpoints; edges involving unselected nodes are not duplicated.",
        "Keep the existing 50-node limit and its rejection behavior; all existing adjacent tests continue to pass unchanged.",
        "A rejected duplication leaves history untouched; a successful duplication records one entry and undo/redo restores the exact before/after graphs.",
      ],
    } };
    const { gate, reads } = fixture(["src/graph.ts", "src/graph.test.ts"]);
    const assessment = await assess(gate, JSON.stringify(document), false);
    expect(assessment.receipt).toMatchObject({ outcome: "accepted", reason: "complete", correctionUsed: false, result: document, reads });
    expect(assessment.feedback).toBeUndefined();
    expect(gate.accepted()).toEqual(assessment.receipt);
    expect(inspectionCompletionReceiptSchema.parse(assessment.receipt)).toEqual(assessment.receipt);
  });
  it("keeps optional failure diagnostics out of legacy seals and successful context receipts", async () => {
    const reads = [read("src/feature.ts")];
    const gate = createInspectionCompletionGate({ runId, sessionId, assertCurrent: async () => undefined, readReceipts: async () => reads,
      contextReads: async () => [{ kind: "adjacent_test", path: "src/feature.test.ts", startLine: 1, lineCount: 200, sourceExecutionId: "read-0", discoveryExecutionId: "discovery" }] });
    const legacy = (await fixture().gate.beforeTurn())!.receipt;
    expect(inspectionCompletionReceiptSchema.parse(legacy)).toEqual(legacy);
    expect(legacy.workflowContext).toBeUndefined();
    await gate.beforeTurn(); reads.push(read("src/feature.test.ts", 1));
    const collected = await gate.finishContext(["read-1"]);
    expect(collected.outcome).toBe("context_collected");
    expect(Object.keys(collected.workflowContext!)).toEqual(["origin", "requests", "executionIds"]);
    const { receiptSha256: _oldSeal, ...body } = collected;
    void _oldSeal;
    for (const diagnostic of [
      { failureStage: "after_checkpoint", failedExecutionId: "read-1", refusal: "evidence_unavailable" },
      { failedExecutionId: "read-1", refusal: "evidence_unavailable" },
      { failureStage: "raw exception text", refusal: "evidence_unavailable" },
    ]) {
      const changed = { ...body, workflowContext: { ...body.workflowContext, ...diagnostic } };
      expect(inspectionCompletionReceiptSchema.safeParse({ ...changed, receiptSha256: selfImprovementSha256("inspection_completion", changed) }).success).toBe(false);
    }
  });
  it("reminds once before the next existing turn, then accepts one actual adjacent read without dropping other validation targets", async () => {
    const { gate, reads } = fixture();
    expect((await gate.beforeTurn())?.receipt.outcome).toBe("reminder");
    expect(await gate.beforeTurn()).toBeUndefined();
    const missing = await assess(gate);
    expect(missing.receipt).toMatchObject({ outcome: "needs_reads", correctionUsed: true, adjacentCandidates: plan.plan.adjacentTestPaths });
    reads.push(read("src/feature.test.ts", 1));
    const accepted = await assess(gate);
    expect(accepted.receipt).toMatchObject({ outcome: "accepted", result: plan });
    expect(accepted.receipt.result?.decision === "repair" && accepted.receipt.result.plan.adjacentTestPaths).toEqual(plan.plan.adjacentTestPaths);
    expect(inspectionCompletionReceiptSchema.safeParse(accepted.receipt).success).toBe(true);
  });
  it("has only one semantic completion opportunity", async () => {
    const { gate } = fixture();
    expect((await assess(gate)).feedback).toBeTruthy();
    expect(await assess(gate)).toMatchObject({ receipt: { outcome: "rejected", reason: "missing_plan_reads", correctionUsed: true } });
    expect((await assess(gate)).feedback).toBeUndefined();
  });
  it("stops on a known authority loss even after its once-only reminder", async () => {
    const { gate, assertCurrent } = fixture();
    expect(await gate.beforeTurn()).toMatchObject({ stop: false, receipt: { outcome: "reminder" } });
    assertCurrent.mockRejectedValueOnce(new Error("The owner paused this cycle."));
    expect(await gate.beforeTurn()).toMatchObject({ stop: true, receipt: { outcome: "rejected", reason: "evidence_unavailable" } });
    expect(assertCurrent).toHaveBeenCalledTimes(2);
  });
  it("does not offer correction without ordinary budget headroom", async () => {
    const { gate } = fixture();
    expect(await assess(gate, JSON.stringify(plan), false)).toMatchObject({ receipt: { outcome: "rejected", reason: "completion_budget_unavailable", correctionUsed: false } });
  });
  it("requires every source and at least one declared adjacent read, not an unrelated test", async () => {
    const { gate } = fixture(["src/other.test.ts"]);
    expect((await assess(gate)).receipt).toMatchObject({ outcome: "needs_reads", missingSourcePaths: ["src/feature.ts"] });
    const unrelated = fixture(["src/feature.ts", "src/unrelated.test.ts"]);
    expect((await assess(unrelated.gate)).receipt.outcome).toBe("needs_reads");
  });
  it.each(["AGENTS.md", "docs/architecture.md", "src/config.ts"])("does not count %s as no-change implementation evidence", async path => {
    const { gate } = fixture([path, "src/feature.test.ts"]);
    expect((await assess(gate, JSON.stringify({ decision: "no_change", summary: "No issue." }), false)).receipt.outcome).toBe("rejected");
  });
  it("accepts no_change only with implementation and test evidence", async () => {
    const { gate } = fixture(["src/feature.ts", "src/feature.test.ts"]);
    expect((await assess(gate, JSON.stringify({ decision: "no_change", summary: "No issue." }))).receipt.outcome).toBe("accepted");
  });
  it("rejects unavailable evidence, truncated/deferred runs, and concatenated result narration", async () => {
    const { gate, assertCurrent } = fixture(["src/feature.ts", "src/feature.test.ts"]);
    expect((await gate.assessFinal({ text: JSON.stringify(plan), incomplete: true, canCorrect: true })).receipt.reason).toBe("incomplete_run");
    expect((await assess(gate, `${JSON.stringify(plan)}\n${JSON.stringify(plan)}`)).receipt.reason).toBe("invalid_result");
    assertCurrent.mockRejectedValueOnce(new Error("Scope changed"));
    expect((await assess(gate)).receipt.reason).toBe("evidence_unavailable");
  });
  it("rejects a changed receipt or typed result hash", async () => {
    const { gate } = fixture(["src/feature.ts", "src/feature.test.ts"]);
    const { receipt } = await assess(gate);
    expect(inspectionCompletionReceiptSchema.safeParse({ ...receipt, reads: [] }).success).toBe(false);
    expect(inspectionCompletionReceiptSchema.safeParse({ ...receipt, resultSha256: "f".repeat(64) }).success).toBe(false);
  });
  it("emits a bounded rejection instead of a storage-truncated receipt", async () => {
    const { gate, reads } = fixture(["src/feature.ts", "src/feature.test.ts"]);
    reads.push(...Array.from({ length: 46 }, (_, i) => read(`src/${"界".repeat(480)}${i}.ts`, i + 2)));
    const { receipt } = await assess(gate);
    expect(receipt).toMatchObject({ outcome: "rejected", reason: "evidence_unavailable", reads: [] });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(48 * 1024);
  });
});
