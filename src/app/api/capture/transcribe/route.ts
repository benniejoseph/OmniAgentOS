import { TRANSCRIPTION_MODEL, hasOpenAIKey } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { getOpenAIClient } from "@/lib/openai/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const allowedAudioTypes = new Set(["audio/webm", "audio/mp4", "audio/mpeg", "audio/wav", "audio/x-wav", "audio/ogg"]);

async function POSTHandler(request: Request) {
  try {
    await authorizeRequest({ request, action: "write.memory", resourceType: "knowledge", metadata: { operation: "transcribe" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  if (!hasOpenAIKey()) return Response.json({ error: "Voice transcription is not configured." }, { status: 503 });
  if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("multipart/form-data")) {
    return Response.json({ error: "Audio transcription requires multipart form data." }, { status: 415 });
  }
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_AUDIO_BYTES + 1_000_000) {
    return Response.json({ error: "Audio recordings must be 10 MB or smaller." }, { status: 413 });
  }
  let form: FormData;
  try { form = await request.formData(); } catch { return Response.json({ error: "The audio payload could not be read." }, { status: 400 }); }
  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.size) return Response.json({ error: "No audio recording was provided." }, { status: 400 });
  if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "Audio recordings must be 10 MB or smaller." }, { status: 413 });
  const baseType = audio.type.split(";", 1)[0].toLowerCase();
  if (!allowedAudioTypes.has(baseType)) return Response.json({ error: "Unsupported audio format." }, { status: 415 });

  try {
    const result = await getOpenAIClient().audio.transcriptions.create({ file: audio, model: TRANSCRIPTION_MODEL });
    const text = result.text.trim().slice(0, 100_000);
    if (!text) return Response.json({ error: "No speech could be recognized in this recording." }, { status: 422 });
    return Response.json({ text, model: TRANSCRIPTION_MODEL }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Transcription failed." }, { status: 502 });
  }
}
