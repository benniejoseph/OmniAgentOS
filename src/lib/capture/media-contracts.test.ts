import { describe, expect, it } from "vitest";
import {
  captureMediaOutputSchema,
  captureMediaProcessingRequestSchema,
  mediaArtifactId,
  mediaCitationForTurn,
  mediaTurnId,
  withCaptureMediaOutputDigest,
  type CaptureMediaTurn,
} from "@/lib/capture/media-contracts";

const sourceAudioSha256 = "a".repeat(64);

function turn(overrides: Partial<CaptureMediaTurn> = {}): CaptureMediaTurn {
  const content = {
    segmentId: "capture_segment_1",
    segmentIndex: 0,
    sourceAudioSha256,
    startMilliseconds: 1_000,
    endMilliseconds: 4_000,
    languageTag: "en-US",
    speaker: { label: "A", identity: "diarized" as const },
    text: "We will send the renewal plan tomorrow.",
    ...overrides,
  };
  return { ...content, turnId: mediaTurnId(content) };
}

function output() {
  const transcriptTurn = turn();
  const citation = mediaCitationForTurn(transcriptTurn);
  return withCaptureMediaOutputDigest({
    schemaVersion: 1,
    tenantId: "tenant-a",
    ownerActorId: "actor-a",
    recordingId: "capture_recording_a",
    meetingId: "meeting:11111111-1111-4111-8111-111111111111",
    mediaRevision: 1,
    mediaRevisionId: "capture_recording_a:media:v1",
    sourceAudioManifestSha256: "b".repeat(64),
    transcriptionModel: "gpt-4o-transcribe-diarize",
    extractionModel: "gpt-5-mini",
    languageTags: ["en-US"],
    turns: [transcriptTurn],
    chapters: [{
      chapterId: mediaArtifactId("chapter", { title: "Renewal", citation }),
      title: "Renewal",
      text: "The renewal plan and delivery timing were discussed.",
      startMilliseconds: 1_000,
      endMilliseconds: 4_000,
      citations: [citation],
    }],
    summary: {
      text: "The team committed to sending the renewal plan tomorrow.",
      citations: [citation],
    },
    actionItems: [{
      actionItemId: mediaArtifactId("action", { text: transcriptTurn.text }),
      text: "Send the renewal plan tomorrow.",
      ownershipEvidence: "unconfirmed",
      dueDateEvidence: "unconfirmed",
      citations: [citation],
    }],
    decisions: [],
    warnings: [],
    rawAudioRetention: { mode: "retain" },
    processedAt: "2026-09-07T12:00:00.000Z",
  });
}

describe("capture media processing contracts", () => {
  it("accepts digest-bound timestamped and diarized extraction output", () => {
    expect(captureMediaOutputSchema.parse(output())).toMatchObject({
      languageTags: ["en-US"],
      summary: { citations: [{ speakerLabel: "A", startMilliseconds: 1_000 }] },
    });
  });

  it("rejects extraction citations that do not exactly match a transcript turn", () => {
    const valid = output();
    expect(() => captureMediaOutputSchema.parse({
      ...valid,
      summary: {
        ...valid.summary,
        citations: [{ ...valid.summary.citations[0], startMilliseconds: 2_000 }],
      },
    })).toThrow(/citation|digest/i);
  });

  it("requires explicit identity evidence for named speakers and owners", () => {
    const transcriptTurn = turn({
      speaker: { label: "A", identity: "known", displayName: "Bennie" },
    } as Partial<CaptureMediaTurn>);
    expect(() => captureMediaOutputSchema.parse({
      ...output(),
      turns: [transcriptTurn],
    })).toThrow(/participant|citation|digest/i);
  });

  it("validates speaker mappings and raw-audio retention without ambiguity", () => {
    expect(captureMediaProcessingRequestSchema.parse({
      schemaVersion: 1,
      recordingId: "capture_recording_a",
      languageHints: ["en-US", "hi-IN"],
      speakerMappings: [{
        speakerLabel: "A",
        participantId: "participant-a",
        displayName: "Asha",
        confirmation: "user_confirmed",
      }],
      rawAudioRetention: { mode: "delete_after_processing" },
    }).rawAudioRetention.mode).toBe("delete_after_processing");

    expect(() => captureMediaProcessingRequestSchema.parse({
      schemaVersion: 1,
      recordingId: "capture_recording_a",
      languageHints: [],
      speakerMappings: [],
      rawAudioRetention: {
        mode: "delete_after_processing",
        retainUntil: "2026-09-08T12:00:00.000Z",
      },
    })).toThrow(/retention deadline/i);
  });
});
