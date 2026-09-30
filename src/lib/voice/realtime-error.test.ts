import { describe, expect, it } from "vitest";
import { nativeRealtimeVoiceSessionFinishRequestSchema } from "@/lib/mobile/contracts";
import { classifyRealtimeError } from "@/lib/voice/realtime-error";

const providerError = (error: unknown) => ({ type: "error", event_id: "event_1", error });

describe("realtime provider errors", () => {
  it("ends the session only for an error it cannot continue after", () => {
    expect(classifyRealtimeError(providerError({
      type: "invalid_request_error",
      code: "session_expired",
      message: "Your session hit the maximum duration.",
    }))).toEqual({ code: "session_expired", fatal: true, emptyCommit: false });

    for (const error of [
      { type: "server_error", message: "The server had an error." },
      { type: "invalid_request_error", code: "invalid_value", message: "Invalid value." },
    ]) {
      expect(classifyRealtimeError(providerError(error)).fatal, error.type).toBe(false);
    }
  });

  it("recognizes a commit that turn detection had already made", () => {
    expect(classifyRealtimeError(providerError({
      type: "invalid_request_error",
      code: "input_audio_buffer_commit_empty",
      message: "Error committing input audio buffer: buffer too small.",
    }))).toEqual({ code: "input_audio_buffer_commit_empty", fatal: false, emptyCommit: true });
  });

  it("keeps only a code a receipt may hold, never the message", () => {
    const codes = [
      providerError({ type: "server_error", code: null, message: "Call Sam at 555-0100." }),
      providerError({ type: " Server_Error ", message: "x" }),
      providerError({ type: "server_error", code: "Call Sam at 555-0100", message: "x" }),
      providerError({ code: "x".repeat(65), message: "x" }),
      providerError("session_expired"),
      { type: "error" },
      null,
    ].map((event) => classifyRealtimeError(event).code);

    expect(codes).toEqual(["server_error", "server_error", "server_error", "unknown", "unknown", "unknown", "unknown"]);
    for (const providerErrorCode of [...codes, "session_expired", "input_audio_buffer_commit_empty"]) {
      expect(nativeRealtimeVoiceSessionFinishRequestSchema.safeParse({
        sessionId: "33333333-3333-4333-8333-333333333333",
        conversationId: "22222222-2222-4222-8222-222222222222",
        outcome: "failed",
        durationMilliseconds: 1_000,
        turnCount: 0,
        reconnectCount: 0,
        transcriptCharacters: 0,
        confidenceBand: "unavailable",
        confidenceSampleCount: 0,
        reviewRequired: true,
        reviewAttested: false,
        providerErrorCode,
      }).success, providerErrorCode).toBe(true);
    }
  });
});
