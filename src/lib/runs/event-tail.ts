import type { AgentEvent } from "@/lib/orchestration/types";
import {
  encodeSse,
  SSE_HEARTBEAT_INTERVAL_MS,
  sseResponse,
  startSseHeartbeat,
} from "@/lib/http/sse";
import { agentRunOutcomeEvent } from "@/lib/runs/public";
import { getAgentRun, getAgentRunWorkflowHandoff, listAgentRunEventsAfter } from "@/lib/runs/store";
import { redactSensitive } from "@/lib/security/context";

/**
 * Follows a run that is executing somewhere else, from its persisted event
 * log. A client whose live stream dropped reconnects here with the id of the
 * last event it saw and gets every later step, then the run's outcome.
 */

const TAIL_PAGE_SIZE = 200;
const TAIL_POLL_INTERVAL_MS = 1_000;
// Below the routes' 300 s maxDuration, so the tail ends cleanly and the
// client reconnects instead of the platform cutting the stream.
const TAIL_MAX_DURATION_MS = 240_000;

// The header is sent first, deltas are never persisted, and every outcome is
// read from the stored run, so the tail ends on the state /api/runs/:id
// reports rather than on whichever terminal record it happened to page.
const UNTAILED_EVENT_TYPES: ReadonlySet<string> = new Set([
  "run",
  "delta",
  "done",
  "error",
  "canceled",
  "waiting_approval",
  "clarification",
  "delegated",
]);

const RUN_EVENT_CURSOR = /^\d{1,16}$/;

/** Reads the resume position from `Last-Event-ID`, else `?after=`. */
export function parseRunEventCursor(request: Request): number | undefined {
  for (const candidate of [
    request.headers.get("last-event-id"),
    new URL(request.url).searchParams.get("after"),
  ]) {
    const value = candidate ?? "";
    if (!RUN_EVENT_CURSOR.test(value)) continue;
    const cursor = Number(value);
    if (Number.isSafeInteger(cursor)) return cursor;
  }
  return undefined;
}

export function agentRunTailResponse(input: {
  runId: string;
  tenantId: string;
  threadId?: string;
  afterSeq?: number;
  signal?: AbortSignal;
  headers?: HeadersInit;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  maxDurationMs?: number;
  includeResearchProgress?: boolean;
}) {
  const encoder = new TextEncoder();
  const stop = new AbortController();
  const stopOnAbort = () => stop.abort();
  if (input.signal?.aborted) stop.abort();
  else input.signal?.addEventListener("abort", stopOnAbort, { once: true });
  let stopHeartbeat = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string) => {
        if (stop.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          stop.abort();
        }
      };
      stopHeartbeat = startSseHeartbeat(
        write,
        input.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS,
      );
      try {
        write(encodeSse({
          type: "run",
          runId: input.runId,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        }));
        let cursor = input.afterSeq ?? 0;
        const deadline = Date.now() +
          (input.maxDurationMs ?? TAIL_MAX_DURATION_MS);
        while (!stop.signal.aborted) {
          // Read the run before its log: every step it took before reaching
          // this state is then already on the page read next.
          const run = await getAgentRun(input.runId, {
            tenantId: input.tenantId,
          });
          if (!run) break;
          for (;;) {
            const page = await listAgentRunEventsAfter(input.runId, {
              tenantId: input.tenantId,
              afterSeq: cursor,
              limit: TAIL_PAGE_SIZE,
            });
            for (const record of page) {
              if (typeof record.seq !== "number") continue;
              cursor = Math.max(cursor, record.seq);
              const event = record.payload as AgentEvent;
              if (UNTAILED_EVENT_TYPES.has(event.type)) continue;
              if (event.type === "research_progress" && input.includeResearchProgress === false) continue;
              write(encodeSse(event, { id: record.seq }));
            }
            if (page.length < TAIL_PAGE_SIZE || stop.signal.aborted) break;
          }
          const workflowHandoff = run.status === "completed"
            ? await getAgentRunWorkflowHandoff(run.id, { tenantId: input.tenantId, actorId: run.ownerActorId })
            : undefined;
          const outcome = agentRunOutcomeEvent(run, { workflowHandoff });
          if (outcome) {
            write(encodeSse(outcome));
            break;
          }
          if (Date.now() >= deadline) break;
          await abortableDelay(
            input.pollIntervalMs ?? TAIL_POLL_INTERVAL_MS,
            stop.signal,
          );
        }
      } catch (error) {
        console.warn(JSON.stringify({
          level: "warn",
          event: "agent_run_tail_failed",
          runId: input.runId,
          message: String(redactSensitive(
            error instanceof Error ? error.message : "Unknown tail error.",
          )).slice(0, 300),
        }));
      } finally {
        stopHeartbeat();
        input.signal?.removeEventListener("abort", stopOnAbort);
        stop.abort();
        try {
          controller.close();
        } catch {
          // The client already went away and the stream was canceled.
        }
      }
    },
    cancel() {
      stopHeartbeat();
      stop.abort();
    },
  });

  return sseResponse(stream, input.headers);
}

function abortableDelay(ms: number, signal: AbortSignal) {
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
