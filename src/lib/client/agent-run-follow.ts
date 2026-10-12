import { readSseEvents, type SseCursor } from "@/lib/http/sse-reader";

/**
 * Follows a run after its live stream dropped. The run keeps executing on the
 * server, so the client reconnects to the run's event log from the last event
 * it saw and hands every later event to the same handler, until one settles
 * the run, the caller stops, or the server no longer shows the run to this
 * user.
 */

export const AGENT_RUN_RECONNECT_DELAYS_MS: readonly number[] = [
  1_000,
  2_000,
  4_000,
  8_000,
  8_000,
];
const AGENT_RUN_FOLLOW_BUDGET_MS = 30 * 60_000;

export type AgentRunFollowOutcome =
  /** An event settled the run. */
  | "settled"
  /** The caller aborted. */
  | "stopped"
  /** Signed out, no longer allowed to read the run, or no such run. */
  | "unavailable"
  /** The reconnect budget ran out before the run settled. */
  | "timed_out";

export async function followAgentRunStream<T>(input: {
  runId: string;
  cursor: SseCursor;
  signal: AbortSignal;
  onEvent: (event: T) => void;
  isSettled: () => boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  budgetMs?: number;
}): Promise<AgentRunFollowOutcome> {
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = input.sleep ?? abortableSleep;
  const now = input.now ?? Date.now;
  const deadline = now() + (input.budgetMs ?? AGENT_RUN_FOLLOW_BUDGET_MS);
  // Attempts in a row that brought no new event. Progress starts the backoff
  // over, so a long run that keeps working is followed at full speed.
  let idleAttempts = 0;
  for (;;) {
    if (input.isSettled()) return "settled";
    const delay = AGENT_RUN_RECONNECT_DELAYS_MS[
      Math.min(idleAttempts, AGENT_RUN_RECONNECT_DELAYS_MS.length - 1)
    ];
    if (now() + delay >= deadline) return "timed_out";
    await sleep(delay, input.signal);
    if (input.signal.aborted) return "stopped";

    const seen = input.cursor.lastEventId;
    let response: Response;
    try {
      response = await fetchImpl(
        `/api/runs/${encodeURIComponent(input.runId)}/stream`,
        {
          headers: {
            accept: "text/event-stream",
            ...(seen ? { "last-event-id": seen } : {}),
          },
          cache: "no-store",
          signal: input.signal,
        },
      );
    } catch {
      if (input.signal.aborted) return "stopped";
      idleAttempts += 1;
      continue;
    }
    if ([401, 403, 404].includes(response.status)) {
      void response.body?.cancel().catch(() => undefined);
      return "unavailable";
    }
    if (!response.ok || !response.body) {
      void response.body?.cancel().catch(() => undefined);
      idleAttempts += 1;
      continue;
    }

    const handler = { failed: false, error: undefined as unknown };
    try {
      await readSseEvents<T>(response.body, (event) => {
        try {
          input.onEvent(event);
        } catch (error) {
          handler.failed = true;
          handler.error = error;
          throw error;
        }
      }, input.cursor);
    } catch {
      // A failing handler is the caller's to report. Anything else is the
      // connection dropping again, and the next attempt resumes from the
      // cursor.
      if (handler.failed) throw handler.error;
      if (input.signal.aborted) return "stopped";
    }
    idleAttempts = input.cursor.lastEventId === seen ? idleAttempts + 1 : 0;
  }
}

function abortableSleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
