import { z } from "zod";
import { MeetingRecordingNativeError } from "@/lib/capture/meeting-recording-native-contracts";
import { IdempotencyKeyError } from "@/lib/http/idempotency-key";
import { nativeMeetingRecordingSchemas } from "@/lib/mobile/meeting-recording-contracts";

export const nativeRecordingHeaders = { "cache-control": "private, no-store" };
export function privateRecordingResponse(response: Response) { response.headers.set("cache-control", nativeRecordingHeaders["cache-control"]); return response; }
export function nativeRecordingQuery(request: Request) {
  const entries = [...new URL(request.url).searchParams];
  if (entries.length !== new Set(entries.map(([key]) => key)).size) throw new MeetingRecordingNativeError("meeting_recording_query", 400, "Repeated recording query parameters are invalid.");
  return nativeMeetingRecordingSchemas.NativeMeetingRecordingQuery.parse(Object.fromEntries(entries));
}
export function nativeRecordingFailure(error: unknown) {
  if (error instanceof MeetingRecordingNativeError) return Response.json({ error: error.message, code: error.code }, { status: error.status, headers: nativeRecordingHeaders });
  if (error instanceof z.ZodError || error instanceof IdempotencyKeyError) return Response.json({ error: "Invalid native recording request.", code: "meeting_recording_request" }, { status: 400, headers: nativeRecordingHeaders });
  return Response.json({ error: "Recording processing could not be confirmed. Read the exact acceptance before starting another request.", code: "meeting_recording_unavailable" }, { status: 503, headers: nativeRecordingHeaders });
}
