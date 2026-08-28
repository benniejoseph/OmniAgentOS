export type CaptureRecordingStatus =
  | "recording"
  | "processing"
  | "ready"
  | "failed";

export type CaptureTranscriptionStatus =
  | "pending"
  | "completed"
  | "failed";

export type CaptureRecording = {
  id: string;
  tenantId: string;
  actorId: string;
  title: string;
  status: CaptureRecordingStatus;
  language: string;
  tags: string[];
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  byteCount: number;
  segmentCount: number;
  transcript: string;
  source: string;
  knowledgeDocumentId?: string;
  ingestJobId?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CaptureSegment = {
  id: string;
  tenantId: string;
  actorId: string;
  recordingId: string;
  segmentIndex: number;
  mimeType: string;
  byteCount: number;
  durationMs: number;
  audioSha256: string;
  transcript: string;
  transcriptionStatus: CaptureTranscriptionStatus;
  transcriptionModel?: string;
  transcriptionError?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CaptureRecordingDetail = CaptureRecording & {
  segments: CaptureSegment[];
};

export type CaptureAssetStatus = "stored" | "queued" | "indexed" | "unsupported" | "failed";

export type CaptureAsset = {
  id: string;
  tenantId: string;
  actorId: string;
  filename: string;
  mediaType: string;
  extension: string;
  byteCount: number;
  contentSha256: string;
  storageKind: "database" | "filesystem";
  status: CaptureAssetStatus;
  extractionStatus: "pending" | "completed" | "unsupported" | "failed";
  ingestJobId?: string;
  knowledgeDocumentId?: string;
  error?: string;
  tags: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};
