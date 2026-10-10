import { withDatabaseRequestScope } from "@/lib/db/client";
import { listenIngestRequestSchema, listenSegmentFieldsSchema, ListenError } from "@/lib/capture/listen-contracts";
import { authorizeListenIngest, recordListenAdmission } from "@/lib/capture/listen-grants";
import { boundedListenRequest, listenFailure, listenResponse } from "@/lib/capture/listen-http";
import { appendListenSegment, completeListenRecording, listenRecordingStatus, startListenRecording } from "@/lib/capture/listen-store";
import { MAX_CAPTURE_SEGMENT_BYTES } from "@/lib/capture/recordings";
import { CAPTURE_AUDIO_TYPES } from "@/lib/capture/transcription";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(async (request: Request) => {
  try {
    const authority = await authorizeListenIngest(request);
    const multipart = (request.headers.get("content-type") || "").startsWith("multipart/form-data");
    const bounded = await boundedListenRequest(request, multipart ? MAX_CAPTURE_SEGMENT_BYTES + 65536 : 8192);
    if (multipart) {
      const form = await bounded.formData();
      const fields: Record<string, unknown> = {};
      for (const [key, value] of form.entries()) {
        if (key !== "audio") { if (key in fields) throw new ListenError(400, "listen_field_duplicate", "Recording details contain a duplicate field."); fields[key] = value; }
      }
      const input = listenSegmentFieldsSchema.parse(fields);
      const audio = form.get("audio");
      if (!(audio instanceof File) || form.getAll("audio").length !== 1 || !audio.size || audio.size > MAX_CAPTURE_SEGMENT_BYTES) {
        throw new ListenError(413, "listen_audio_size", "A recording chunk must contain between 1 byte and 3 MB of audio.");
      }
      const mimeType = audio.type.split(";", 1)[0].toLowerCase();
      if (!CAPTURE_AUDIO_TYPES.has(mimeType)) throw new ListenError(415, "listen_audio_type", "This audio format is not supported.");
      await recordListenAdmission(authority, "segment", input.recordingId);
      return listenResponse(await appendListenSegment(authority, { ...input, mimeType, audio: new Uint8Array(await audio.arrayBuffer()) }));
    }
    const input = listenIngestRequestSchema.parse(await bounded.json());
    if (input.action === "status") return listenResponse(await listenRecordingStatus(authority.context, input.recordingId));
    await recordListenAdmission(authority, input.action, "recordingId" in input ? input.recordingId : undefined);
    if (input.action === "start") return listenResponse(await startListenRecording(authority, input));
    return listenResponse(await completeListenRecording(authority, input.recordingId, input.segmentCount), 202);
  } catch (error) { return listenFailure(error); }
});
