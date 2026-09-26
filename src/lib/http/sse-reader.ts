/**
 * Reads a server-sent event stream with the framing EventSource uses, for
 * clients that stream through fetch: comment lines (heartbeats) are skipped,
 * an `id:` field becomes the last event id once its event is complete, and a
 * multi-line `data:` field is joined. An event cut off by the end of the
 * stream is dropped along with its id, so a client resuming from
 * `cursor.lastEventId` asks again for the event it never finished reading.
 */

export type SseCursor = { lastEventId: string };

export async function readSseEvents<T>(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: T, lastEventId: string) => void,
  cursor: SseCursor = { lastEventId: "" },
) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  let pendingId = cursor.lastEventId;

  const processLine = (line: string) => {
    if (!line) {
      cursor.lastEventId = pendingId;
      const payload = data.join("\n");
      data = [];
      if (payload.trim()) onEvent(JSON.parse(payload) as T, cursor.lastEventId);
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\u0000")) pendingId = value;
  };

  const drain = (final: boolean) => {
    // A trailing CR may be the first half of a CRLF split across chunks.
    const end = !final && buffer.endsWith("\r") ? buffer.length - 1 : buffer.length;
    const lines = buffer.slice(0, end).split(/\r\n|\r|\n/);
    buffer = (lines.pop() ?? "") + buffer.slice(end);
    for (const line of lines) processLine(line);
  };

  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      drain(false);
    }
    buffer += decoder.decode();
    drain(true);
    finished = true;
  } finally {
    if (!finished) void reader.cancel().catch(() => undefined);
  }
}
