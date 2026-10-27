import { describe, expect, it, vi } from "vitest";
import { createForgeHandoff, forgeEffectSchema, forgeHandoffReceiptSchema, type ForgeEffect, type ForgeReadReceipt } from "./forge-handoff";

const runId = "11111111-1111-4111-8111-111111111111", sessionId = `app_build_${"a".repeat(48)}`;
const plan = { summary: "Synthetic fallback", sourcePaths: ["src/feature.ts", "src/other.ts"], newSourcePaths: [], focusedTestPaths: ["src/feature.test.ts"], adjacentTestPaths: ["src/adjacent.test.ts"], acceptanceCriteria: ["Observable fallback"] };
const read: ForgeReadReceipt = { executionId: "read", path: "src/feature.ts", sha256: "a".repeat(64), inputSha256: "b".repeat(64), scopeSha256: "c".repeat(64), startLine: 1, endLine: 20, totalLines: 20 };
const effect: ForgeEffect = { executionId: "effect", toolId: "app.projects.builder.file.update", path: "src/feature.test.ts", previousSha256: null, sha256: "d".repeat(64), inputSha256: "e".repeat(64), scopeSha256: "f".repeat(64) };
function fixture(phase: "reproduce" | "implement" = "reproduce") {
  const assertCurrent = vi.fn(async () => undefined);
  return { assertCurrent, gate: createForgeHandoff({ runId, sessionId, plan: { phase, plan, expectedHashes: { "src/feature.ts": "a".repeat(64), "src/other.ts": "a".repeat(64), "src/feature.test.ts": "d".repeat(64) } }, assertCurrent, verifyRead: async () => read }) };
}
describe("saved-plan Forge handoff", () => {
  it("seeds exact primary anchors without claiming every selected file was read", () => {
    const { gate } = fixture();
    expect(gate.requests.map(item => item.path)).toEqual(["src/feature.ts", "src/adjacent.test.ts"]);
    gate.begin(); const receipt = gate.finishContext([read]);
    expect(receipt.reads.map(item => item.path)).toEqual(["src/feature.ts"]);
    expect(() => gate.begin()).toThrow("cannot replay");
    expect(fixture("implement").gate.requests.map(item => item.path)).toEqual(["src/feature.ts", "src/adjacent.test.ts", "src/feature.test.ts"]);
  });
  it("does not turn proposed text or an absent context episode into completion", () => {
    const { gate } = fixture(); expect(gate.finish([], "no_changes").reason).toBe("evidence_unavailable");
    const next = fixture().gate; next.begin(); next.finishContext([read]);
    expect(next.finish([])).toMatchObject({ outcome: "incomplete", reason: "no_changes", effects: [] });
  });
  it("accepts actual effect metadata and rejects altered sealed data", () => {
    const { gate } = fixture(); gate.begin(); gate.finishContext([read]);
    const receipt = gate.finish([effect]); expect(receipt.outcome).toBe("completed");
    expect(forgeHandoffReceiptSchema.safeParse({ ...receipt, effects: [{ ...effect, path: "src/foreign.ts" }] }).success).toBe(false);
  });
  it("retains known authority refusal after context rather than allowing another turn", async () => {
    const { gate, assertCurrent } = fixture(); gate.begin(); gate.finishContext([read]);
    assertCurrent.mockRejectedValueOnce(new Error("private internal message"));
    expect(await gate.beforeTurn()).toMatchObject({ outcome: "incomplete", reason: "authority_unavailable" });
    expect(JSON.stringify(gate.receipt())).not.toContain("private internal");
    expect(gate.modelAttempted()).toBe(false);
    expect(gate.finish([effect]).outcome).toBe("incomplete");
  });
  it("keeps partial context and no-replay semantics after budget refusal", () => {
    const { gate } = fixture(); gate.begin(); gate.finishContext([read], "budget_unavailable");
    expect(gate.finish([effect])).toMatchObject({ outcome: "incomplete", reason: "budget_unavailable", reads: [read], effects: [] });
    expect(() => gate.begin()).toThrow();
  });
  it("returns a bounded incomplete receipt for oversized legal effect metadata without losing model-attempt state", () => {
    const { gate } = fixture(); gate.begin(); gate.finishContext([read]); gate.modelStarting();
    const effects = Array.from({ length: 48 }, (_, index) => ({ ...effect, executionId: `effect-${index}`, path: `src/${"界".repeat(450)}-${index}.ts` }));
    expect(effects.every(value => forgeEffectSchema.safeParse(value).success)).toBe(true);
    const receipt = gate.finish(effects);
    expect(receipt).toMatchObject({ outcome: "incomplete", reason: "evidence_unavailable", reads: [], effects: [], runId, sessionId });
    expect(forgeHandoffReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(receipt), "utf8")).toBeLessThan(48 * 1024);
    expect(gate.modelAttempted()).toBe(true);
  });
});
