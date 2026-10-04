import { z } from "zod";
import { IdempotencyKeyError } from "@/lib/http/idempotency-key";
import { NativePrivateActionError } from "@/lib/memory/private-action-contracts";
export const privateSourceHeaders = { "cache-control": "private, no-store" };
export function privateSourceResponse(response: Response) { response.headers.set("cache-control",privateSourceHeaders["cache-control"]); return response; }
export function sourceDeletionQuery(request: Request) { if ([...new URL(request.url).searchParams].length) throw new NativePrivateActionError("knowledge_source_query",400,"Local source deletion does not accept query parameters."); }
export async function sourceDeletionBody(request: Request) {
  const bytes = await request.arrayBuffer(); if (bytes.byteLength > 8192) throw new NativePrivateActionError("knowledge_source_request_size",413,"Local source deletion request is too large.");
  try { return JSON.parse(new TextDecoder("utf-8",{ fatal: true }).decode(bytes)) as unknown; }
  catch { throw new NativePrivateActionError("knowledge_source_request",400,"Invalid local source deletion JSON."); }
}
export function sourceDeletionFailure(error: unknown) {
  if (error instanceof NativePrivateActionError) return Response.json({ error: error.message, code: error.code },{ status: error.status, headers: privateSourceHeaders });
  if (error instanceof z.ZodError || error instanceof IdempotencyKeyError) return Response.json({ error: "Invalid local source deletion request.", code: "knowledge_source_request" },{ status: 400, headers: privateSourceHeaders });
  return Response.json({ error: "Local source deletion could not be confirmed. Read its exact acceptance before another request.", code: "knowledge_source_unavailable" },{ status: 503, headers: privateSourceHeaders });
}
