import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  usage: vi.fn(),
}));

vi.mock("@/lib/config", () => ({
  DIARIZATION_MODEL: "gpt-4o-transcribe-diarize",
  TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
  hasGoogleMediaKey: () => false,
  hasOpenAIKey: () => true,
}));
vi.mock("@/lib/google/ai", () => ({
  transcribeGoogleAudio: vi.fn(),
}));
vi.mock("@/lib/openai/client", () => ({
  getOpenAIClient: () => ({
    audio: { transcriptions: { create: mocks.create } },
  }),
}));
vi.mock("@/lib/usage/ledger", () => ({
  recordAiUsageSafely: mocks.usage,
}));

import { transcribeCaptureMediaDiarized } from "@/lib/capture/transcription";

beforeEach(() => {
  mocks.create.mockReset();
  mocks.usage.mockReset().mockResolvedValue(undefined);
});

describe("background media diarization", () => {
  it("returns bounded speaker turns with timestamps and language labels", async () => {
    mocks.create.mockResolvedValue({
      duration: 4,
      text: "Hello. Namaste.",
      segments: [
        { id: "1", type: "transcript.text.segment", start: 0, end: 1.5, speaker: "A", text: "Hello." },
        { id: "2", type: "transcript.text.segment", start: 1.5, end: 4, speaker: "B", text: "Namaste." },
      ],
    });
    const media = new File([new Uint8Array([1, 2, 3])], "segment.webm", {
      type: "audio/webm",
    });

    const result = await transcribeCaptureMediaDiarized(
      media,
      ["en-US", "hi-IN"],
      undefined,
      {
        tenantId: "tenant-a",
        actorId: "actor-a",
        sourceStreamId: "capture-recording:a",
        operation: "transcription",
        purpose: "capture.recording.segment.diarize",
        correlationId: "correlation-a",
        credentialSource: "deployment_environment",
      },
    );

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      model: "gpt-4o-transcribe-diarize",
      response_format: "diarized_json",
      chunking_strategy: "auto",
    }), { signal: undefined });
    expect(mocks.create.mock.calls[0][0]).not.toHaveProperty("language");
    expect(result.segments).toEqual([
      expect.objectContaining({ speakerLabel: "A", startMilliseconds: 0, languageTag: "en-US" }),
      expect.objectContaining({ speakerLabel: "B", endMilliseconds: 4_000, languageTag: "en-US" }),
    ]);
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({
      status: "completed",
      model: "gpt-4o-transcribe-diarize",
      usage: { inputBytes: 3 },
    }));
  });
});
