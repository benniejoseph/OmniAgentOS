import { z } from "zod";
import { IdempotencyKeyError } from "@/lib/http/idempotency-key";
import { NativePrivateActionError } from "@/lib/memory/private-action-contracts";
export const privateCognitionHeaders = { "cache-control": "private, no-store" };
export function privateCognitionResponse(response: Response) { response.headers.set("cache-control", privateCognitionHeaders["cache-control"]); return response; }
export function cognitionQuery(request: Request, allowed: readonly string[] = []) {
  const entries = [...new URL(request.url).searchParams];
  if (entries.some(([name]) => !allowed.includes(name)) || new Set(entries.map(([name]) => name)).size !== entries.length) throw new NativePrivateActionError("knowledge_cognition_query", 400, "Invalid or repeated source-map query parameter.");
  return Object.fromEntries(entries);
}
export async function cognitionDecisionBody(request: Request) {
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > 16_384) throw new NativePrivateActionError("knowledge_cognition_request_size", 413, "Source-map decision is too large.");
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new NativePrivateActionError("knowledge_cognition_request", 400, "Invalid source-map JSON request."); }
}
export function cognitionFailure(error: unknown) {
  if (error instanceof NativePrivateActionError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateCognitionHeaders });
  if (error instanceof z.ZodError || error instanceof IdempotencyKeyError) return Response.json({ error: "Invalid source-map request.", code: "knowledge_cognition_request" }, { status: 400, headers: privateCognitionHeaders });
  return Response.json({ error: "The source-map result could not be confirmed. Read its exact acceptance before submitting another decision.", code: "knowledge_cognition_unavailable" }, { status: 503, headers: privateCognitionHeaders });
}
