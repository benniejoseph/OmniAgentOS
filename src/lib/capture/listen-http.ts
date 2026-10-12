import { ZodError } from "zod";
import { CaptureRecordingError } from "./recordings";
import { ListenError } from "./listen-contracts";
import { SecurityPolicyError } from "@/lib/security/context";

export const listenPrivateHeaders = { "cache-control": "private, no-store" };
export function listenResponse(body: unknown, status = 200) { return Response.json(body, { status, headers: listenPrivateHeaders }); }
export function listenFailure(error: unknown) {
  if (error instanceof ListenError || error instanceof CaptureRecordingError) {
    return listenResponse({ error: error.message, code: error.code }, error.status);
  }
  if (error instanceof SecurityPolicyError) return listenResponse({ error: error.message }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError) return listenResponse({ error: "These conversation details could not be read. Update Asael and try again.", code: "listen_invalid_request" }, 400);
  console.error("Listen request failed.", error instanceof Error ? error.name : "UnknownError");
  return listenResponse({ error: "Conversations are temporarily unavailable. Your saved audio remains on your phone.", code: "listen_unavailable" }, 503);
}

/** Enforce the actual body size even when a chunked sender omits Content-Length. */
export async function boundedListenRequest(request: Request, limit: number) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new ListenError(413, "listen_chunk_too_large", "Each recording chunk must be 3 MB or smaller.");
  if (!request.body) throw new ListenError(400, "listen_body_required", "Recording details are required.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) { await reader.cancel(); throw new ListenError(413, "listen_chunk_too_large", "Each recording chunk must be 3 MB or smaller."); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return new Request(request.url, { method: request.method, headers: request.headers, body: Buffer.concat(chunks) });
}
