import type { RequestCaptureRecordingMetadataDetail } from "@/lib/capture/types";

export function recordingIdFromLocation(location: string) {
  const params = new URLSearchParams(location.split("?")[1]);
  const values = params.getAll("recording");
  if (!values.length) return undefined;
  return values.length === 1 && /^[a-zA-Z0-9_-]{1,200}$/.test(values[0]) ? values[0] : null;
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(value);
// Mirrors the readable metadata projection; exact-owner storage retains the raw title.
const metadataTitle = (value: string) => value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 240) || "Untitled conversation";
function requireRead(value: unknown): asserts value { if (!value) throw new Error("The exact recording metadata could not be verified."); }

export function readRecordingMetadata(value: unknown, expectedId: string): RequestCaptureRecordingMetadataDetail {
  requireRead(object(value) && object(value.requestReadContracts) && value.requestReadContracts.captureRecordingDetail === "readable_v1" && object(value.recording));
  const r = value.recording;
  requireRead(id(expectedId) && r.id === expectedId && typeof r.title === "string" && r.title.length <= 240 && typeof r.language === "string" &&
    ["recording", "processing", "ready", "failed"].includes(String(r.status)) && Array.isArray(r.tags) && r.tags.length <= 50 && r.tags.every((tag) => typeof tag === "string" && tag.length <= 80) &&
    date(r.startedAt) && (r.completedAt === undefined || date(r.completedAt)) && date(r.createdAt) && date(r.updatedAt) &&
    count(r.durationMs) && count(r.byteCount) && count(r.segmentCount) && r.segmentCount <= 1440 && Array.isArray(r.segments) && r.segments.length <= 1440 &&
    typeof r.metadataAvailable === "boolean" && typeof r.segmentMetadataAvailable === "boolean" && typeof r.transcriptAvailable === "boolean" &&
    r.audioAvailable === r.transcriptAvailable && r.manageable === r.transcriptAvailable && (!r.transcriptAvailable || r.metadataAvailable && r.segmentMetadataAvailable) &&
    !Object.hasOwn(r, "transcript") && !Object.hasOwn(r, "actorId") && !Object.hasOwn(r, "metadata"));
  const segments = r.segments.map((segment) => {
    requireRead(object(segment) && id(segment.id) && count(segment.segmentIndex) && segment.segmentIndex < 1440 && count(segment.durationMs) && count(segment.byteCount) &&
      typeof segment.mimeType === "string" && segment.mimeType.length <= 160 && ["pending", "completed", "failed"].includes(String(segment.transcriptionStatus)) &&
      date(segment.createdAt) && date(segment.updatedAt) && !Object.hasOwn(segment, "transcript") && !Object.hasOwn(segment, "audioSha256"));
    return { id: segment.id, segmentIndex: segment.segmentIndex, durationMs: segment.durationMs, byteCount: segment.byteCount, mimeType: segment.mimeType,
      transcriptionStatus: segment.transcriptionStatus as "pending" | "completed" | "failed", createdAt: segment.createdAt as string, updatedAt: segment.updatedAt as string };
  });
  requireRead(new Set(segments.map((segment) => segment.id)).size === segments.length && new Set(segments.map((segment) => segment.segmentIndex)).size === segments.length &&
    (r.segmentMetadataAvailable ? segments.length === r.segmentCount : segments.length === 0));
  return { id: expectedId, title: r.title, status: r.status as RequestCaptureRecordingMetadataDetail["status"], language: r.language, tags: r.tags as string[],
    startedAt: r.startedAt as string, ...(r.completedAt ? { completedAt: r.completedAt as string } : {}), durationMs: r.durationMs, byteCount: r.byteCount,
    segmentCount: r.segmentCount, createdAt: r.createdAt as string, updatedAt: r.updatedAt as string, segments,
    metadataAvailable: r.metadataAvailable, segmentMetadataAvailable: r.segmentMetadataAvailable, transcriptAvailable: r.transcriptAvailable,
    audioAvailable: r.audioAvailable as boolean, manageable: r.manageable as boolean };
}

/** Private bytes are admitted only after the separately authorized metadata read. */
export function readRecordingPrivateDetail(value: unknown, metadata: RequestCaptureRecordingMetadataDetail, owner: { tenantId: string; actorId: string }) {
  requireRead(metadata.transcriptAvailable && metadata.audioAvailable && object(value) && object(value.requestReadContracts) &&
    value.requestReadContracts.captureRecordingDetail === "exact_v1" && object(value.recording));
  const recording = value.recording;
  requireRead(recording.id === metadata.id && recording.tenantId === owner.tenantId && recording.actorId === owner.actorId &&
    recording.updatedAt === metadata.updatedAt && recording.startedAt === metadata.startedAt && recording.createdAt === metadata.createdAt &&
    recording.completedAt === metadata.completedAt && typeof recording.title === "string" && metadataTitle(recording.title) === metadata.title && recording.status === metadata.status &&
    recording.durationMs === metadata.durationMs && recording.byteCount === metadata.byteCount && recording.segmentCount === metadata.segmentCount &&
    typeof recording.transcript === "string" && Array.isArray(recording.segments) && recording.segments.length === metadata.segments.length);
  const expected = new Map(metadata.segments.map((segment) => [segment.id, segment]));
  const segments = recording.segments.map((segment) => {
    requireRead(object(segment) && id(segment.id));
    const reference = expected.get(segment.id);
    requireRead(reference && segment.tenantId === owner.tenantId && segment.actorId === owner.actorId && segment.recordingId === metadata.id &&
      segment.segmentIndex === reference.segmentIndex && segment.durationMs === reference.durationMs && segment.byteCount === reference.byteCount &&
      segment.mimeType === reference.mimeType && segment.transcriptionStatus === reference.transcriptionStatus &&
      segment.createdAt === reference.createdAt && segment.updatedAt === reference.updatedAt && typeof segment.transcript === "string");
    expected.delete(segment.id);
    return { ...reference, transcript: segment.transcript };
  });
  requireRead(expected.size === 0);
  return { id: metadata.id, title: metadata.title, status: metadata.status, startedAt: metadata.startedAt, completedAt: metadata.completedAt,
    durationMs: metadata.durationMs, segmentCount: metadata.segmentCount, updatedAt: metadata.updatedAt, byteCount: metadata.byteCount,
    transcript: recording.transcript, segments };
}

/** Identity changes and closes invalidate even an older A response after A → B → A. */
export function createRecordingSelectionGate() {
  let current: Readonly<{ id: string; controller: AbortController }> | undefined;
  return {
    begin(selectedId: string) { current?.controller.abort(); current = Object.freeze({ id: selectedId, controller: new AbortController() }); return current; },
    current(token: Readonly<{ id: string; controller: AbortController }>) { return current === token && !token.controller.signal.aborted; },
    clear() { current?.controller.abort(); current = undefined; },
  };
}

/** A visible snapshot is never reused after hiding, even before effects run. */
export function createRecordingVisibilityEpoch() {
  const server = Object.freeze({ visible: false, epoch: 0 });
  let snapshot: Readonly<{ visible: boolean; epoch: number }> = server;
  return {
    server: () => server,
    read(visible: boolean) {
      if (snapshot.visible !== visible) snapshot = Object.freeze({ visible, epoch: snapshot.epoch + 1 });
      return snapshot;
    },
  };
}
