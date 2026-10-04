import { describe, expect, it } from "vitest";
import { buildMeetingRecordingIntent, meetingRecordingProcessRequestSchema, meetingRecordingReviewPinSchema, meetingRecordingAcceptanceSchema } from "@/lib/capture/meeting-recording-native-contracts";
import { recordingFixture, recordingPin, recordingRequest, recordingScope, recordingKey } from "@/lib/capture/meeting-recording-native.test-fixtures";
describe("native recording immutable reviewed intent", () => {
  it("binds explicit consent/source state and stable request semantics without timestamps", () => {
    const value = recordingFixture(); expect(meetingRecordingAcceptanceSchema.parse(value.acceptance)).toEqual(value.acceptance);
    expect(buildMeetingRecordingIntent({ scope: recordingScope, request: recordingRequest, idempotencyKey: recordingKey })).toEqual(value.intent);
    expect(buildMeetingRecordingIntent({ scope: recordingScope, request: { ...recordingRequest, languageHints: ["fr"] }, idempotencyKey: recordingKey })).not.toEqual(value.intent);
    expect(meetingRecordingReviewPinSchema.safeParse({ ...recordingPin, meetingRevision: 2 }).success).toBe(false);
    expect(meetingRecordingAcceptanceSchema.safeParse({ ...value.acceptance, operationJobId: "other-job" }).success).toBe(false);
  });
  it("refuses retention changes, unknown fields, silent normalization and cross-workspace intent", () => {
    for (const request of [{ ...recordingRequest, rawAudioRetention: { mode: "delete_after_processing" } }, { ...recordingRequest, retry: true },
      { ...recordingRequest, languageHints: [" en-US"] }, { ...recordingRequest, languageHints: ["en-US", "en-US"] }]) {
      expect(meetingRecordingProcessRequestSchema.safeParse(request).success).toBe(false);
    }
    expect(() => buildMeetingRecordingIntent({ scope: { ...recordingScope, workspaceId: "workspace:other" }, request: recordingRequest, idempotencyKey: recordingKey })).toThrow();
  });
});
