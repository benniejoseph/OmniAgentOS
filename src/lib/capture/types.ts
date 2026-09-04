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

export type RequestCaptureRecordingSummary = {
  id: string;
  title: string;
  status: CaptureRecordingStatus;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  segmentCount: number;
  updatedAt: string;
  metadataDetailAvailable: boolean;
  detailAvailable: boolean;
  manageable: boolean;
};

export type RequestCaptureSegmentSummary = {
  id: string;
  segmentIndex: number;
  mimeType: string;
  durationMs: number;
  byteCount: number;
  transcriptionStatus: CaptureTranscriptionStatus;
  createdAt: string;
  updatedAt: string;
};

export type RequestCaptureRecordingMetadataDetail = {
  id: string;
  title: string;
  status: CaptureRecordingStatus;
  language: string;
  tags: string[];
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  byteCount: number;
  segmentCount: number;
  createdAt: string;
  updatedAt: string;
  segments: RequestCaptureSegmentSummary[];
  metadataAvailable: boolean;
  segmentMetadataAvailable: boolean;
  transcriptAvailable: boolean;
  audioAvailable: boolean;
  manageable: boolean;
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

export type RequestCaptureAsset = CaptureAsset & {
  contentAvailable: boolean;
  indexable: boolean;
  manageable: boolean;
};
