import { ASSISTANT_MODES, legacyAgentMode, type AgentMode } from "@/lib/orchestration/modes";
import type { AgentEvent } from "@/lib/orchestration/types";

/** Projection only; the stored run and its effective policy are never rewritten. */
export function assistantEventForClient(event: AgentEvent, nativeVersion?: number): AgentEvent {
  return nativeVersion !== undefined && nativeVersion < 63 && event.type === "harness"
    ? { ...event, mode: legacyAgentMode(event.mode) }
    : event;
}

/** A queued prompt's mode is an immutable execution pin, never a display alias. */
export function assistantModeRequiresUpgrade(mode: AgentMode, nativeVersion?: number): boolean {
  return nativeVersion !== undefined && nativeVersion < 63 && ASSISTANT_MODES.some(value => value === mode);
}
