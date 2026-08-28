import {
  CAPTURE_AUDIO_TYPES,
  captureTranscriptionConfigured,
  transcribeCaptureAudio,
} from "@/lib/capture/transcription";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

async function POSTHandler(request: Request) {
  try {
    await authorizeRequest({ request, action: "write.memory", resourceType: "knowledge", metadata: { operation: "transcribe" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  if (!captureTranscriptionConfigured()) return Response.json({ error: "Voice transcription is not configured." }, { status: 503 });
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
  if (!CAPTURE_AUDIO_TYPES.has(baseType)) return Response.json({ error: "Unsupported audio format." }, { status: 415 });

  const startedAt = Date.now();
  try {
    const { text, model, fallbackUsed } = await transcribeCaptureAudio(audio, request.signal);
    await recordRuntimeEventSafely({ category: "api", action: "media.transcription", resourceType: "capture", durationMs: Date.now() - startedAt, message: fallbackUsed ? "Voice transcription completed through fallback." : "Voice transcription completed.", metadata: { model, fallbackUsed, bytes: audio.size } });
    return Response.json({ text, model, fallbackUsed }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Transcription failed." }, { status: 502 });
  }
}
