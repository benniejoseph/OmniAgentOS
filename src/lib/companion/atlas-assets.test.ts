import { describe, expect, it } from "vitest";
import { atlasMotionAllowed, createAtlasPlaybackGate } from "./atlas-assets";
import { companionWork, type CompanionState, type CompanionWork } from "./presentation";

const states: CompanionState[] = ["available", "listening", "responding", "working", "needs_you", "blocked", "completed", "paused"];

function completed(runId: string, receiptId = "receipt-a"): CompanionWork {
  // The caller supplies only the verified projection from companionWork; its
  // receipt validation already has independent domain regressions.
  return { state: "completed", label: "Completed", detail: "Verified", runId, completionIdentity: JSON.stringify([runId, receiptId]) };
}
function observe(gate: ReturnType<typeof createAtlasPlaybackGate>, work: CompanionWork, options: { eligible?: boolean; hasConversation?: boolean; state?: CompanionState } = {}) {
  return gate.observe({ state: options.state ?? work.state, work, eligible: options.eligible ?? true, hasConversation: options.hasConversation ?? true });
}

describe("one-shot ATLAS admission", () => {
  it("keeps quiet static, balanced result-focused and expressive limited to truthful active states", () => {
    const admitted = (intensity: "quiet" | "balanced" | "expressive") => states.filter((state) => atlasMotionAllowed(intensity, state));
    expect(admitted("quiet")).toEqual([]);
    expect(admitted("balanced")).toEqual(["completed"]);
    expect(admitted("expressive")).toEqual(["listening", "responding", "working", "completed"]);
  });

  it("does not replay a suppressed transition or completion when intensity increases", () => {
    const gate = createAtlasPlaybackGate();
    const working = companionWork({ status: "running", runId: "run-style" });
    expect(observe(gate, companionWork({}), { eligible: false })).toBe(false);
    expect(observe(gate, working, { eligible: atlasMotionAllowed("balanced", "working") })).toBe(false);
    expect(observe(gate, working, { eligible: atlasMotionAllowed("expressive", "working") })).toBe(false);
    const receipt = completed("run-style");
    expect(observe(gate, receipt, { eligible: atlasMotionAllowed("quiet", "completed") })).toBe(false);
    expect(observe(gate, receipt, { eligible: atlasMotionAllowed("expressive", "completed") })).toBe(false);
    expect(observe(gate, completed("run-style", "new-receipt"), { eligible: atlasMotionAllowed("balanced", "completed") })).toBe(true);
  });

  it("primes a mounted receipt and an asynchronously loaded historical receipt without celebrating", () => {
    const mounted = createAtlasPlaybackGate();
    expect(observe(mounted, completed("run-a"))).toBe(false);
    expect(observe(mounted, completed("run-a"))).toBe(false);
    const loading = createAtlasPlaybackGate();
    expect(observe(loading, companionWork({}))).toBe(false);
    expect(observe(loading, companionWork({ runId: "run-a" }))).toBe(true);
    expect(observe(loading, completed("run-a"))).toBe(false);
  });

  it("admits only a new verified receipt for an observed exact active run and conversation", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({ status: "running", runId: "run-a" }));
    expect(observe(gate, completed("other-run"))).toBe(false);
    expect(observe(gate, completed("run-a"))).toBe(true);
    expect(observe(gate, completed("run-a"))).toBe(false);
    expect(observe(gate, completed("run-a", "receipt-b"), { hasConversation: false })).toBe(false);
    expect(observe(gate, completed("run-a", "receipt-b"))).toBe(false);
    const otherOwner = createAtlasPlaybackGate();
    expect(observe(otherOwner, completed("run-a", "receipt-b"))).toBe(false);
  });

  it("consumes hidden/quiet/reduced/offscreen or unavailable-asset receipts permanently", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({ status: "running", runId: "run-a" }));
    expect(observe(gate, completed("run-a"), { eligible: false })).toBe(false);
    expect(observe(gate, completed("run-a"))).toBe(false);
    expect(observe(gate, completed("run-a", "receipt-b"), { state: "responding" })).toBe(true);
    expect(observe(gate, completed("run-a", "receipt-b"))).toBe(false);
  });

  it("does not replay a state when visibility, theme, manifest, preferences or audio return", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({}));
    const working = companionWork({ status: "running", runId: "run-a" });
    expect(observe(gate, working)).toBe(true);
    expect(observe(gate, working)).toBe(false);
    expect(observe(gate, working, { eligible: false })).toBe(false);
    expect(observe(gate, working)).toBe(false);
    expect(observe(gate, working, { state: "listening", eligible: false })).toBe(false);
    expect(observe(gate, working, { state: "listening" })).toBe(false);
  });

  it("cannot celebrate legacy done/completed text or an unverified work projection", () => {
    const gate = createAtlasPlaybackGate();
    observe(gate, companionWork({ status: "running", runId: "run-a" }));
    expect(observe(gate, companionWork({ status: "completed", runId: "run-a" }))).toBe(true); // Available state only.
    expect(observe(gate, { state: "completed", label: "Done", detail: "HTTP 200", runId: "run-a" })).toBe(false);
  });
});
