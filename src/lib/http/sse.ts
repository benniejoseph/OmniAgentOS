import type { AgentEvent } from "@/lib/orchestration/types";

/**
 * A comment line every 15 seconds keeps idle proxies and load balancers from
 * closing a stream while the agent waits on a slow model or tool call.
 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
export const SSE_HEARTBEAT = ": keep-alive\n\n";

/**
 * `id` is the event's position in its run stream. A client that loses the
 * connection resumes from the last id it saw through `Last-Event-ID`.
 */
export function encodeSse(event: AgentEvent, options: { id?: number } = {}) {
  const id = options.id === undefined ? "" : `id: ${options.id}\n`;
  return `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function sseResponse(
  stream: ReadableStream<Uint8Array>,
  headers: HeadersInit = {},
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Content-Type", "text/event-stream; charset=utf-8");
  responseHeaders.set("Cache-Control", "no-cache, no-transform");
  responseHeaders.set("Connection", "keep-alive");
  // Reverse proxies such as nginx buffer responses unless told not to, which
  // would hold every event until the run ends.
  responseHeaders.set("X-Accel-Buffering", "no");
  return new Response(stream, { headers: responseHeaders });
}

/** Writes a heartbeat comment on an interval; returns the function that stops it. */
export function startSseHeartbeat(
  write: (chunk: string) => void,
  intervalMs = SSE_HEARTBEAT_INTERVAL_MS,
) {
  const timer = setInterval(() => write(SSE_HEARTBEAT), intervalMs);
  return () => clearInterval(timer);
}
