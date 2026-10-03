import { canonicalStatusForTerminalReceipt } from "@/lib/status/canonical";
import { parseCompanionTerminalReceipt } from "./terminal-receipt";

/** Display-only state. Nothing in this adapter authorizes or starts work/audio. */
export type CompanionState = "available" | "listening" | "responding" | "working" | "needs_you" | "blocked" | "completed" | "paused";
export type CompanionWork = Readonly<{
  state: CompanionState;
  label: string;
  detail: string;
  runId?: string;
  completionIdentity?: string;
}>;
const labels: Record<CompanionState, string> = {
  available: "Available", listening: "Listening", responding: "Responding", working: "Working",
  needs_you: "Needs you", blocked: "Blocked / reconnecting", completed: "Completed", paused: "Paused",
};
const idle: CompanionWork = { state: "available", label: "Available", detail: "Ready for your next message." };

export function companionRunSnapshot(value: unknown, expectedRunId: string): CompanionWork {
  if (!value || typeof value !== "object" || Array.isArray(value)) return companionWork({ runId: expectedRunId });
  const run = value as Record<string, unknown>;
  if (run.id !== expectedRunId || typeof run.status !== "string") return companionWork({ runId: expectedRunId });
  return companionWork({ runId: expectedRunId, status: run.status, terminalReceipt: run.terminalReceipt });
}

/** Keep an exact loaded queued/unknown status ahead of the generic request
 * indicator. A stale completed snapshot cannot complete a new pending action. */
export function companionPendingWork(runId: string | undefined, snapshot: CompanionWork | undefined, requestPending: boolean): CompanionWork {
  if (runId && snapshot?.runId === runId && snapshot.state !== "completed") return snapshot;
  return companionWork({ runId, status: requestPending ? "running" : undefined });
}

export function companionWork(input: { status?: string; runId?: string; terminalReceipt?: unknown }): CompanionWork {
  const runId = input.runId || undefined;
  const result = (state: CompanionState, label: string, detail: string): CompanionWork => ({ state, label, detail, ...(runId ? { runId } : {}) });
  if (input.status === "completed") {
    const receipt = parseCompanionTerminalReceipt(input.terminalReceipt);
    const canonical = receipt?.runId === runId
      ? canonicalStatusForTerminalReceipt(receipt, "agent_run") : undefined;
    if (canonical?.status === "succeeded" && receipt) return {
      ...result("completed", "Completed", "The recorded outcome is verified."),
      completionIdentity: JSON.stringify([receipt.runId, receipt.terminalReceiptId]),
    };
    if (canonical?.status === "partial") return result("needs_you", "Partial outcome", "Some work is complete. Review the remaining requirements.");
    if (canonical?.status === "failed") return result("blocked", "Failed outcome", "Review the recorded failure and available recovery controls.");
    if (canonical?.status === "blocked") return result("blocked", "Blocked outcome", "Review the recorded dependency or decision that blocked this work.");
    if (canonical?.status === "canceled") return result("paused", "Canceled", "The recorded outcome is canceled.");
    if (canonical?.status === "preview") return result("available", "Preview only", "This result does not confirm a live outcome.");
    return result("available", "Outcome unverified", "Work ended without a confirmed verified outcome.");
  }
  if (input.status === "waiting_approval") return result("needs_you", "Needs approval", "Review the exact action using the approval controls.");
  if (input.status === "waiting_clarification" || input.status === "review") return result("needs_you", "Needs your review", "Review the draft or provide the requested clarification.");
  if (input.status === "paused") return result("paused", "Paused", "Work is paused. Use its available resume or end controls.");
  if (input.status === "canceled") return result("paused", "Canceled", "The run was canceled.");
  if (input.status === "failed" || input.status === "blocked") return result("blocked", "Needs attention", "Review the error and available recovery controls.");
  if (input.status === "reconnecting") return result("blocked", "Reconnecting", "The connection is recovering; your visible draft is preserved.");
  if (input.status === "queued") return result("working", "Queued", "Waiting to start.");
  if (input.status === "running" || input.status === "resuming") return result("working", "Working", "Work is in progress.");
  if (input.status) return result("blocked", "Status unavailable", "This state does not confirm a completed outcome.");
  return runId ? result("blocked", "Status unavailable", "The current run state is unavailable.") : idle;
}

/** PCM playback wins over an open interruption microphone. A request for speech
 * alone is not playback; a permission request alone is not an open microphone. */
export function companionPresentation(input: {
  work?: CompanionWork; microphoneActive?: boolean; playbackActive?: boolean; speechPreparing?: boolean;
}) {
  const work = input.work ?? idle;
  const state = input.playbackActive ? "responding" : input.microphoneActive ? "listening" : input.speechPreparing ? "working" : work.state;
  return {
    state, label: input.playbackActive || input.microphoneActive || input.speechPreparing ? labels[state] : work.label, work,
    detail: input.playbackActive ? "Reply audio is playing. Use the playback controls to interrupt."
      : input.microphoneActive ? "The microphone is open. Use Stop & review or end voice mode."
      : input.speechPreparing ? "Preparing reply audio; playback has not started." : work.detail,
  };
}

/** This bounded, per-mounted-view ledger is for optional presentation reactions,
 * never run authority. Static ATLAS renders no reaction clips. */
export function createCompanionReactionLedger() {
  const seen = new Set<string>();
  return {
    accept(work: CompanionWork) {
      if (work.state !== "completed" || !work.completionIdentity || seen.has(work.completionIdentity)) return false;
      // Do not evict and replay old events. A new mounted view gets a fresh ledger.
      if (seen.size >= 128) return false;
      seen.add(work.completionIdentity);
      return true;
    },
  };
}

export function createCompanionReadGate() {
  let generation = 0;
  let active: Readonly<{ scope: string; generation: number }> | undefined;
  return {
    begin(scope: string) { active = Object.freeze({ scope, generation: ++generation }); return active; },
    current(token: Readonly<{ scope: string; generation: number }>) { return token === active; },
    invalidate() { active = undefined; generation += 1; },
  };
}

/** Action admission, not an eventual rendered busy flag, invalidates a pending
 * Home read. Even a synchronous action that returns to idle advances this epoch. */
export function createCompanionHomeGate() {
  let epoch = 0;
  return { capture: () => epoch, current: (captured: number) => captured === epoch, invalidate: () => { epoch += 1; } };
}
