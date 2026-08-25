import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { synthesizeGoogleSpeech } from "@/lib/google/ai";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({ text: z.string().trim().min(1).max(5_000) }).strict();

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "synthesize_speech" } }); }
  catch (error) { return forbiddenResponse(error); }
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Add text between 1 and 5,000 characters." }, { status: 400 });
  const startedAt = Date.now();
  try {
    const audio = await synthesizeGoogleSpeech(parsed.data.text, request.signal);
    await recordRuntimeEventSafely({ category: "api", action: "media.speech", tenantId: context.tenantId, actorId: context.actorId, resourceType: "media", durationMs: Date.now() - startedAt, message: "Speech synthesis completed.", metadata: { provider: "google", characters: parsed.data.text.length } });
    return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": String(audio.length), "cache-control": "private, no-store", "content-disposition": "inline; filename=asael-response.mp3" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Speech synthesis failed." }, { status: 502 });
  }
}
