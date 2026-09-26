import type { AgentEvent } from "@/lib/orchestration/types";

/**
 * Stream positions of persisted run events, keyed by the event object the
 * writer was handed. The run store records the position when it persists an
 * event, and the SSE transport reads it back for the `id:` line, so the
 * position travels with the event without widening the public event shape.
 */
const cursors = new WeakMap<object, number>();

export function recordRunEventCursor(
  event: AgentEvent,
  seq: number | undefined,
) {
  if (typeof seq === "number" && Number.isSafeInteger(seq) && seq > 0) {
    cursors.set(event, seq);
  }
}

export function runEventCursor(event: AgentEvent): number | undefined {
  return cursors.get(event);
}

/** Carries a persisted event's position over to a decorated copy of it. */
export function withRunEventCursor<T extends AgentEvent>(
  from: AgentEvent,
  to: T,
): T {
  const seq = cursors.get(from);
  if (seq !== undefined) cursors.set(to, seq);
  return to;
}
