import { createCompanionReactionLedger, type CompanionState, type CompanionWork } from "./presentation";
import type { CompanionPreferences } from "./model";

export type AtlasTheme = "light" | "dark";

/** Delivery intensity only. The playback gate still requires a newly verified
 * completion; visibility, motion and asset admission remain independent. */
export function atlasMotionAllowed(intensity: CompanionPreferences["intensity"], state: CompanionState) {
  if (intensity !== "balanced" && intensity !== "expressive") return false;
  if (state === "completed") return true;
  return intensity === "expressive" && (state === "listening" || state === "responding" || state === "working");
}

/** One mounted owner/conversation owns this ledger. Every observation consumes
 * its transition, including hidden/reduced/off/asset-unavailable observations.
 * A first loaded completion is history, not a new completion reaction. */
export function createAtlasPlaybackGate() {
  const receipts = createCompanionReactionLedger();
  const observedActiveRuns = new Set<string>();
  let previousState: CompanionState | undefined;
  return {
    observe(input: { state: CompanionState; work: CompanionWork; eligible: boolean; hasConversation: boolean }) {
      const first = previousState === undefined;
      const changed = input.state !== previousState;
      previousState = input.state;
      const freshReceipt = receipts.accept(input.work);
      const hadActiveRun = Boolean(input.work.runId && observedActiveRuns.has(input.work.runId));
      if (input.work.runId && ["working", "needs_you", "paused"].includes(input.work.state) && observedActiveRuns.size < 128) {
        observedActiveRuns.add(input.work.runId);
      }
      if (first || !input.eligible) return false;
      if (input.state === "completed") return input.hasConversation && freshReceipt && hadActiveRun;
      return changed;
    },
  };
}
