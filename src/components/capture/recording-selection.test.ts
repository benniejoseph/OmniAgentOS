import { describe, expect, it } from "vitest";
import { createRecordingSelectionGate, createRecordingVisibilityEpoch, readRecordingMetadata, readRecordingPrivateDetail, recordingIdFromLocation } from "./recording-selection";

const stamp = "2026-10-04T10:00:00.000Z";
const owner = { tenantId: "tenant-a", actorId: "owner-a" };
function metadata(privateAvailable = true) {
  return { id: "outside-six", title: "Exact older recording", status: "ready", language: "en", tags: ["history"], startedAt: stamp,
    completedAt: stamp, durationMs: 2000, byteCount: 30, segmentCount: 1, createdAt: stamp, updatedAt: stamp,
    metadataAvailable: true, segmentMetadataAvailable: true, transcriptAvailable: privateAvailable, audioAvailable: privateAvailable, manageable: privateAvailable,
    segments: [{ id: "segment-a", segmentIndex: 0, mimeType: "audio/webm", durationMs: 2000, byteCount: 30, transcriptionStatus: "completed", createdAt: stamp, updatedAt: stamp }] };
}
const readMetadata = (value = metadata()) => readRecordingMetadata({ recording: value, requestReadContracts: { captureRecordingDetail: "readable_v1" } }, "outside-six");
function privateEnvelope() {
  const source = metadata();
  return { requestReadContracts: { captureRecordingDetail: "exact_v1" }, recording: { ...source, ...owner, transcript: "Full literal <transcript> & source",
    segments: source.segments.map((segment) => ({ ...segment, ...owner, recordingId: source.id, transcript: "Exact segment", audioSha256: "a".repeat(64) })) } };
}

describe("exact recording link admission", () => {
  it("cannot reuse a private read from a prior visible epoch while fresh metadata remains pending", () => {
    const visibility = createRecordingVisibilityEpoch();
    const first = visibility.read(true);
    const accepted = { visibilityEpoch: first.epoch, detail: readRecordingPrivateDetail(privateEnvelope(), readMetadata(), owner) };
    expect(visibility.read(true)).toBe(first);
    const hidden = visibility.read(false), reopened = visibility.read(true);
    expect(hidden.visible).toBe(false);
    expect(reopened.epoch).toBeGreaterThan(first.epoch);
    expect(accepted.visibilityEpoch === reopened.epoch).toBe(false);
  });
  it("accepts an exact bookmark independent of the history window and rejects ambiguous query IDs", () => {
    expect(recordingIdFromLocation("/app/capture?recording=outside-six&keep=yes")).toBe("outside-six");
    expect(recordingIdFromLocation("/app/capture?keep=yes")).toBeUndefined();
    for (const suffix of ["recording=", "recording=a&recording=b", "recording=a%2Fb", "recording=" + "a".repeat(201)]) {
      expect(recordingIdFromLocation("/app/capture?" + suffix)).toBeNull();
    }
    expect(readMetadata().id).toBe("outside-six");
  });
  it("keeps retained metadata readable while refusing any private response admission", () => {
    const read = readMetadata(metadata(false));
    expect(read.segments).toHaveLength(1);
    expect(read.transcriptAvailable).toBe(false);
    expect(() => readRecordingPrivateDetail(privateEnvelope(), read, owner)).toThrow();
  });
  it("rejects raw private fields, duplicated segments and inconsistent or foreign metadata", () => {
    const original = metadata();
    for (const patch of [{ id: "other" }, { transcript: "private" }, { actorId: owner.actorId }, { segments: [...original.segments, ...original.segments], segmentCount: 2 }, { segmentCount: 2 }, { byteCount: -1 }, { manageable: false }]) {
      expect(() => readMetadata({ ...original, ...patch })).toThrow();
    }
  });
  it("binds private content to exact owner, recording and every selected metadata segment", () => {
    const read = readRecordingPrivateDetail(privateEnvelope(), readMetadata(), owner);
    expect(read.transcript).toBe("Full literal <transcript> & source");
    expect(read.segments[0].transcript).toBe("Exact segment");
    expect(read).not.toHaveProperty("metadata");
    const original = privateEnvelope();
    for (const patch of [{ actorId: "other" }, { updatedAt: "2026-10-04T11:00:00.000Z" }, { byteCount: 31 },
      { segments: [{ ...original.recording.segments[0], recordingId: "other" }] },
      { segments: [{ ...original.recording.segments[0], actorId: "other" }] },
      { segments: [{ ...original.recording.segments[0], id: "other" }] },
      { segments: [{ ...original.recording.segments[0], updatedAt: "2026-10-04T11:00:00.000Z" }] },
    ]) expect(() => readRecordingPrivateDetail({ ...original, recording: { ...original.recording, ...patch } }, readMetadata(), owner)).toThrow();
  });
  it("compares the server's safe display projection without changing private identity or transcript", () => {
    const original = privateEnvelope();
    original.recording.title = "  Exact\u202e\nolder recording  ";
    const read = readRecordingPrivateDetail(original, readMetadata(), owner);
    expect(read.title).toBe("Exact older recording");
    expect(read.transcript).toBe(original.recording.transcript);
    expect(() => readRecordingPrivateDetail({ ...original, recording: { ...original.recording, title: "Other recording" } }, readMetadata(), owner)).toThrow();
  });
  it("invalidates late A responses on selection A → B → A, close and disposal", () => {
    const gate = createRecordingSelectionGate();
    const first = gate.begin("a"), second = gate.begin("b"), latest = gate.begin("a");
    expect(first.controller.signal.aborted).toBe(true);
    expect(gate.current(first)).toBe(false);
    expect(gate.current(second)).toBe(false);
    expect(gate.current(latest)).toBe(true);
    gate.clear();
    expect(gate.current(latest)).toBe(false);
  });
});
