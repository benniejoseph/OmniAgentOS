import { createHash, randomUUID } from "node:crypto";
import {
  CaptureAssetError,
  MAX_CAPTURE_ASSET_BYTES,
  listExactCaptureAssetsByMetadata,
  saveCaptureAsset,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import { deleteCaptureAssetWithKnowledge } from "@/lib/capture/deletion";
import { extractCaptureFile } from "@/lib/capture/files";
import type { CaptureAsset } from "@/lib/capture/types";
import { OAuthProviderError } from "@/lib/connectors/oauth-providers";
import { OAuthCredentialError } from "@/lib/connectors/oauth-store";
import { getActiveGoogleWorkspaceAccess } from "@/lib/connectors/google-workspace-access";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueCaptureAssetProcessJob,
  enqueueKnowledgeIngestJob,
} from "@/lib/operations/background-jobs";
import {
  cancelOperationJobByDedupeKey,
  getOperationJob,
  projectOperationJobStatus,
} from "@/lib/operations/job-queue";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

const PICKER_API = "https://photospicker.googleapis.com/v1";
const DEFAULT_ITEM_LIMIT = 12;
export const MAX_GOOGLE_PHOTOS_PICKER_ITEMS = 20;
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_IMPORT_BYTES = 24 * 1024 * 1024;
const GOOGLE_PHOTOS_CAPTURE_SOURCE = "google_photos_picker";
const GOOGLE_PHOTOS_DELETE_BATCH_SIZE = 100;
const GOOGLE_PHOTOS_DELETE_BATCH_LIMIT = 100;

type PickerIdentity = { tenantId: string; actorId: string };
type PickerHandlePayload = {
  version: 1;
  tenantId: string;
  actorId: string;
  sessionId: string;
  issuedAt: number;
  expiresAt: number;
};

type ProviderPickingSession = {
  id: string;
  pickerUri?: string;
  expireTime?: string;
  mediaItemsSet: boolean;
  pollingConfig?: { pollInterval?: string; timeoutIn?: string };
};

type PickedMediaItem = {
  id: string;
  createTime?: string;
  type: "PHOTO" | "VIDEO";
  mediaFile: {
    baseUrl: string;
    mimeType?: string;
    filename?: string;
    mediaFileMetadata?: {
      width?: number;
      height?: number;
      cameraMake?: string;
      cameraModel?: string;
      videoMetadata?: { processingStatus?: string };
    };
  };
};

export type GooglePhotosPickerSession = {
  handle: string;
  pickerUri?: string;
  expiresAt: string;
  mediaItemsSet: boolean;
  pollAfterMs: number;
  timeoutAfterMs: number;
};

export class GooglePhotosPickerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
    public readonly reconnectRequired = false,
  ) {
    super(message);
    this.name = "GooglePhotosPickerError";
  }
}

export function normalizeGooglePhotosItemLimit(value: unknown) {
  if (value === undefined || value === null || value === "") return DEFAULT_ITEM_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_GOOGLE_PHOTOS_PICKER_ITEMS) {
    throw new GooglePhotosPickerError(
      `Choose between 1 and ${MAX_GOOGLE_PHOTOS_PICKER_ITEMS} photos.`,
      400,
      "invalid_item_limit",
    );
  }
  return parsed;
}

export async function createGooglePhotosPickerSession(
  identity: PickerIdentity,
  maxItemCount: number,
  signal?: AbortSignal,
): Promise<GooglePhotosPickerSession> {
  const accessToken = await googlePhotosAccessToken(identity);
  const response = await providerJson(
    `${PICKER_API}/sessions?requestId=${encodeURIComponent(randomUUID())}`,
    accessToken,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pickingConfig: { maxItemCount: String(maxItemCount) } }),
    },
    signal,
  );
  const session = parsePickingSession(response);
  const expiresAt = boundedSessionExpiry(session.expireTime);
  const handle = sealSessionHandle(identity, session.id, expiresAt);
  return publicSession(session, handle, expiresAt);
}

export async function getGooglePhotosPickerSession(
  identity: PickerIdentity,
  handle: string,
  signal?: AbortSignal,
): Promise<GooglePhotosPickerSession> {
  const sealed = openSessionHandle(identity, handle);
  const accessToken = await googlePhotosAccessToken(identity);
  const response = await providerJson(
    `${PICKER_API}/sessions/${encodeURIComponent(sealed.sessionId)}`,
    accessToken,
    { method: "GET" },
    signal,
  );
  const session = parsePickingSession(response);
  if (session.id !== sealed.sessionId) {
    throw new GooglePhotosPickerError(
      "Google Photos returned an invalid picker session.",
      502,
      "invalid_provider_response",
    );
  }
  return publicSession(session, handle, Math.min(sealed.expiresAt, boundedSessionExpiry(session.expireTime)));
}

export async function deleteGooglePhotosPickerSession(
  identity: PickerIdentity,
  handle: string,
  signal?: AbortSignal,
) {
  const sealed = openSessionHandle(identity, handle, { allowRecentlyExpired: true });
  const accessToken = await googlePhotosAccessToken(identity);
  await deleteProviderSession(sealed.sessionId, accessToken, signal);
  return { deleted: true };
}

export async function importGooglePhotosPickerSelection(
  identity: PickerIdentity,
  handle: string,
  executionScope: ExecutionScope,
  signal?: AbortSignal,
) {
  const trustedRequestScope = requirePickerExecutionScope(identity, executionScope);
  const sealed = openSessionHandle(identity, handle);
  const accessToken = await googlePhotosAccessToken(identity);
  const session = parsePickingSession(await providerJson(
    `${PICKER_API}/sessions/${encodeURIComponent(sealed.sessionId)}`,
    accessToken,
    { method: "GET" },
    signal,
  ));
  if (!session.mediaItemsSet) {
    throw new GooglePhotosPickerError(
      "Finish choosing photos before importing them.",
      409,
      "selection_not_ready",
    );
  }

  const selection = await listPickedMediaItems(sealed.sessionId, accessToken, signal);
  const jobs: Array<ReturnType<typeof projectOperationJobStatus>> = [];
  const assets: Array<ReturnType<typeof projectImportedCaptureAsset>> = [];
  const metadataOnly: Array<ReturnType<typeof projectMetadataOnlyImport>> = [];
  const skipped: Array<{ filename: string; code: string; reason: string }> = [];
  let downloadedBytes = 0;

  for (const item of selection.items) {
    signal?.throwIfAborted();
    const itemKey = providerItemKey(item.id);
    if (item.type === "PHOTO") {
      try {
        const itemScope = pickerItemExecutionScope(identity, trustedRequestScope, itemKey);
        let asset = await existingImportedCaptureAsset(identity, itemKey);
        if (!asset) {
          const remainingBytes = MAX_TOTAL_IMPORT_BYTES - downloadedBytes;
          if (remainingBytes <= 0) {
            throw aggregateImportLimitError();
          }
          const maxBytes = Math.min(MAX_CAPTURE_ASSET_BYTES, remainingBytes);
          const downloaded = await downloadSelectedPhoto(
            item,
            accessToken,
            maxBytes,
            signal,
          );
          downloadedBytes += downloaded.bytes.byteLength;
          asset = await saveCaptureAsset({
            tenantId: identity.tenantId,
            actorId: identity.actorId,
            executionScope: itemScope,
            filename: originalFilename(item, downloaded.mimeType),
            mediaType: downloaded.mimeType,
            bytes: downloaded.bytes,
            tags: ["connected-source", "google", "photos", "photo"],
            metadata: captureAssetMetadata(item, itemKey),
          });
        }
        const job = await enqueueCaptureAssetProcessJob({
          tenantId: identity.tenantId,
          actorId: identity.actorId,
          executionScope: itemScope,
          idempotencyKey: captureAssetIdempotencyKey(identity, itemKey),
          request: {
            assetId: asset.id,
            title: safeFilename(item.mediaFile.filename),
            tags: ["connected-source", "google", "photos", "photo"],
          },
        });
        if (asset.ingestJobId && asset.ingestJobId !== job.id) {
          throw new BackgroundJobIdempotencyConflictError("capture.asset.process");
        }
        if (asset.ingestJobId !== job.id) {
          asset = await updateCaptureAssetStatus(
            asset.id,
            { ...identity, executionScope: itemScope },
            {
              status: "queued",
              extractionStatus: "pending",
              ingestJobId: job.id,
              clearExtractionReceipt: true,
            },
          );
        }
        const projectedJob = projectOperationJobStatus(job);
        jobs.push(projectedJob);
        assets.push(projectImportedCaptureAsset(asset, itemKey, projectedJob.id));
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        skipped.push(importFailure(item, error));
      }
      continue;
    }

    try {
      let detectedText = "";
      let visualExtraction: "text_detected" | "metadata_only" = "metadata_only";
      const remainingBytes = MAX_TOTAL_IMPORT_BYTES - downloadedBytes;
      if (remainingBytes > 0) {
        try {
          const preview = await downloadVideoThumbnail(
            item,
            accessToken,
            Math.min(MAX_PREVIEW_BYTES, remainingBytes),
            signal,
          );
          downloadedBytes += preview.bytes.byteLength;
          const extracted = await extractCaptureFile(new File(
            [preview.bytes],
            previewFilename(item, preview.extension),
            { type: preview.mimeType },
          ), {
            tenantId: identity.tenantId,
            actorId: identity.actorId,
            sourceStreamId: `google-photos-picker:${actorSourceKey(identity)}`,
            operation: "ocr",
            purpose: "connector.google_photos.extract",
            credentialSource: "deployment_environment",
          });
          detectedText = extracted.content.trim().slice(0, 100_000);
          visualExtraction = detectedText ? "text_detected" : "metadata_only";
        } catch (error) {
          if (signal?.aborted) throw signal.reason || error;
          // Large video transfer remains out of scope. A bounded thumbnail can
          // enrich metadata when available, without retaining a provider URL.
        }
      }
      const request = knowledgeRequest(
        item,
        identity,
        itemKey,
        detectedText,
        visualExtraction,
      );
      const job = await enqueueKnowledgeIngestJob({
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        executionScope: pickerItemExecutionScope(identity, trustedRequestScope, itemKey),
        idempotencyKey: request.idempotencyKey,
        request: request.document,
      });
      const projectedJob = projectOperationJobStatus(job);
      jobs.push(projectedJob);
      metadataOnly.push(projectMetadataOnlyImport(item, itemKey, projectedJob.id));
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      skipped.push(importFailure(item, error));
    }
  }

  let sessionDeleted = false;
  if (!skipped.length && !selection.truncated) {
    try {
      await deleteProviderSession(sealed.sessionId, accessToken, signal);
      sessionDeleted = true;
    } catch {
      // Durable imports remain valid if provider-side cleanup fails.
    }
  }

  return {
    selected: selection.items.length,
    imported: assets.length + metadataOnly.length,
    assets,
    metadataOnly,
    skipped,
    jobs,
    selectionTruncated: selection.truncated,
    sessionDeleted,
  };
}

export async function deleteImportedGooglePhotos(
  identity: PickerIdentity,
  executionScope: ExecutionScope,
) {
  const trustedScope = requirePickerExecutionScope(identity, executionScope);
  let assetsDeleted = 0;
  let documents = 0;
  let memories = 0;
  let batches = 0;

  while (batches < GOOGLE_PHOTOS_DELETE_BATCH_LIMIT) {
    const assets = await listExactCaptureAssetsByMetadata(identity, {
      field: "importSource",
      value: GOOGLE_PHOTOS_CAPTURE_SOURCE,
      limit: GOOGLE_PHOTOS_DELETE_BATCH_SIZE,
    });
    if (!assets.length) break;
    for (const asset of assets) {
      await cancelCaptureAssetJob(asset.ingestJobId, identity.tenantId);
      const forgotten = deletionCounts(await deleteCaptureAssetWithKnowledge(
        asset,
        {
          ...identity,
          executionScope: trustedScope,
        },
      ));
      assetsDeleted += 1;
      documents += forgotten.documents;
      memories += forgotten.memories;
    }
    batches += 1;
  }

  const remaining = await listExactCaptureAssetsByMetadata(identity, {
    field: "importSource",
    value: GOOGLE_PHOTOS_CAPTURE_SOURCE,
    limit: 1,
  });
  if (remaining.length) {
    throw new GooglePhotosPickerError(
      "Google Photos removal exceeded the safe deletion batch limit.",
      409,
      "photos_delete_incomplete",
    );
  }

  const metadataKnowledge = deletionCounts(await deleteKnowledgeDocumentsBySourcePrefix(
    googlePhotosSourcePrefix(identity),
    {
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      invalidationScope: trustedScope,
    },
  ));
  return {
    assets: assetsDeleted,
    documents: documents + metadataKnowledge.documents,
    memories: memories + metadataKnowledge.memories,
  };
}

function deletionCounts(value: unknown) {
  const counts = record(value);
  const documents = Number(counts.documents);
  const memories = Number(counts.memories);
  if (
    !Number.isSafeInteger(documents) || documents < 0 ||
    !Number.isSafeInteger(memories) || memories < 0
  ) {
    throw new Error("Google Photos deletion returned an invalid retirement count.");
  }
  return { documents, memories };
}

export function googlePhotosPickerErrorResponse(error: unknown) {
  if (error instanceof GooglePhotosPickerError) {
    return Response.json(
      {
        error: error.message,
        code: error.code,
        reconnectRequired: error.reconnectRequired || undefined,
      },
      {
        status: error.status,
        headers: { "cache-control": "private, no-store" },
      },
    );
  }
  return Response.json(
    { error: "Google Photos could not complete this request.", code: "photos_request_failed" },
    { status: 502, headers: { "cache-control": "private, no-store" } },
  );
}

async function googlePhotosAccessToken(identity: PickerIdentity) {
  try {
    const access = await getActiveGoogleWorkspaceAccess({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      capability: "photos.pick",
    });
    return access.accessToken;
  } catch (error) {
    if (
      error instanceof OAuthCredentialError &&
      error.code === "grant_not_found"
    ) {
      throw new GooglePhotosPickerError(
        "Connect Google before choosing photos.",
        409,
        "google_not_connected",
        true,
      );
    }
    if (
      error instanceof OAuthCredentialError &&
      error.code === "capability_not_granted"
    ) {
      throw new GooglePhotosPickerError(
        "Reconnect Google to allow choosing photos.",
        409,
        "photos_scope_required",
        true,
      );
    }
    if (
      error instanceof OAuthCredentialError ||
      error instanceof OAuthProviderError && error.reconnectRequired
    ) {
      throw new GooglePhotosPickerError(
        "Google Photos access expired. Reconnect Google to continue.",
        409,
        "google_reconnect_required",
        true,
      );
    }
    throw new GooglePhotosPickerError(
      "Google Photos is temporarily unavailable. Try again shortly.",
      502,
      "photos_request_failed",
    );
  }
}

async function listPickedMediaItems(sessionId: string, accessToken: string, signal?: AbortSignal) {
  const items: PickedMediaItem[] = [];
  let nextPageToken = "";
  let pages = 0;
  do {
    const url = new URL(`${PICKER_API}/mediaItems`);
    url.searchParams.set("sessionId", sessionId);
    url.searchParams.set("pageSize", String(MAX_GOOGLE_PHOTOS_PICKER_ITEMS));
    if (nextPageToken) url.searchParams.set("pageToken", nextPageToken);
    const response = await providerJson(url.toString(), accessToken, { method: "GET" }, signal);
    const pageItems = Array.isArray(response.mediaItems) ? response.mediaItems : [];
    for (const candidate of pageItems) {
      const item = parsePickedMediaItem(candidate);
      if (item) items.push(item);
      if (items.length > MAX_GOOGLE_PHOTOS_PICKER_ITEMS) break;
    }
    nextPageToken = typeof response.nextPageToken === "string"
      ? response.nextPageToken.slice(0, 2_000)
      : "";
    pages += 1;
  } while (nextPageToken && items.length <= MAX_GOOGLE_PHOTOS_PICKER_ITEMS && pages < 3);

  return {
    items: items.slice(0, MAX_GOOGLE_PHOTOS_PICKER_ITEMS),
    truncated: items.length > MAX_GOOGLE_PHOTOS_PICKER_ITEMS || Boolean(nextPageToken),
  };
}

async function downloadSelectedPhoto(
  item: PickedMediaItem,
  accessToken: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const baseUrl = trustedGoogleMediaBaseUrl(item.mediaFile.baseUrl);
  const downloadUrl = `${baseUrl}=d`;
  let response: Response;
  try {
    response = await fetch(downloadUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "image/*" },
      redirect: "error",
      signal: boundedSignal(signal, 30_000),
    });
  } catch {
    throw new GooglePhotosPickerError(
      "A selected photo could not be downloaded.",
      502,
      "photo_download_failed",
    );
  }
  if (!response.ok) {
    throw new GooglePhotosPickerError(
      "A selected photo could not be downloaded.",
      502,
      "photo_download_failed",
    );
  }
  const responseType = normalizedMediaType(response.headers.get("content-type"));
  const providerType = normalizedMediaType(item.mediaFile.mimeType);
  const mimeType = responseType || providerType;
  if (!mimeType.startsWith("image/")) {
    throw new GooglePhotosPickerError(
      "Google Photos returned an unsupported photo format.",
      415,
      "unsupported_photo",
    );
  }
  try {
    return {
      bytes: await boundedResponseBytes(response, maxBytes),
      mimeType,
    };
  } catch (error) {
    if (
      error instanceof GooglePhotosPickerError &&
      error.code === "preview_too_large" &&
      maxBytes < MAX_CAPTURE_ASSET_BYTES
    ) {
      throw aggregateImportLimitError();
    }
    if (
      error instanceof GooglePhotosPickerError &&
      error.code === "preview_too_large"
    ) {
      throw new GooglePhotosPickerError(
        "This photo exceeds the 20 MB Capture limit.",
        413,
        "photo_too_large",
      );
    }
    throw error;
  }
}

async function downloadVideoThumbnail(
  item: PickedMediaItem,
  accessToken: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  if (item.type === "VIDEO" && item.mediaFile.mediaFileMetadata?.videoMetadata?.processingStatus !== "READY") {
    throw new GooglePhotosPickerError("The selected video is still processing.", 409, "video_processing");
  }
  const baseUrl = trustedGoogleMediaBaseUrl(item.mediaFile.baseUrl);
  const downloadUrl = `${baseUrl}=w1600-h1600-no`;
  let response: Response;
  try {
    response = await fetch(downloadUrl, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "image/*" },
      redirect: "error",
      signal: boundedSignal(signal, 30_000),
    });
  } catch {
    throw new GooglePhotosPickerError("A selected photo preview could not be downloaded.", 502, "preview_download_failed");
  }
  if (!response.ok) {
    throw new GooglePhotosPickerError("A selected photo preview could not be downloaded.", 502, "preview_download_failed");
  }
  const mimeType = String(response.headers.get("content-type") || "").split(";", 1)[0].toLowerCase();
  const extension = previewExtension(mimeType);
  if (!extension) {
    throw new GooglePhotosPickerError("A selected item has an unsupported preview format.", 415, "unsupported_preview");
  }
  return { bytes: await boundedResponseBytes(response, maxBytes), mimeType, extension };
}

function trustedGoogleMediaBaseUrl(value: string) {
  let baseUrl: URL;
  try {
    baseUrl = new URL(value);
  } catch {
    throw new GooglePhotosPickerError(
      "Google Photos returned an unsafe media URL.",
      502,
      "unsafe_media_url",
    );
  }
  if (
    baseUrl.protocol !== "https:" ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.port ||
    baseUrl.search ||
    baseUrl.hash ||
    !(baseUrl.hostname === "googleusercontent.com" || baseUrl.hostname.endsWith(".googleusercontent.com"))
  ) {
    throw new GooglePhotosPickerError(
      "Google Photos returned an unsafe media URL.",
      502,
      "unsafe_media_url",
    );
  }
  return baseUrl.toString();
}

function aggregateImportLimitError() {
  return new GooglePhotosPickerError(
    "This import reached its 24 MB transfer window. Run import again to continue with the remaining photos.",
    413,
    "batch_transfer_limit",
  );
}

async function boundedResponseBytes(response: Response, maxBytes: number) {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) {
    throw new GooglePhotosPickerError("A selected photo exceeds the import limit.", 413, "preview_too_large");
  }
  if (!response.body) {
    throw new GooglePhotosPickerError("A selected photo preview was empty.", 502, "empty_preview");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new GooglePhotosPickerError("A selected photo exceeds the import limit.", 413, "preview_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function knowledgeRequest(
  item: PickedMediaItem,
  identity: PickerIdentity,
  itemKey: string,
  detectedText: string,
  visualExtraction: "text_detected" | "metadata_only",
) {
  const metadata = item.mediaFile.mediaFileMetadata || {};
  const filename = safeFilename(item.mediaFile.filename);
  const actorKey = actorSourceKey(identity);
  const source = `${googlePhotosSourcePrefix(identity)}${itemKey}`;
  const dimensions = metadata.width && metadata.height
    ? `${metadata.width} × ${metadata.height}`
    : "Unknown";
  const camera = [metadata.cameraMake, metadata.cameraModel].filter(Boolean).join(" ") || "Unknown";
  const content = [
    `Google Photos item: ${filename}`,
    `Media type: ${item.type === "VIDEO" ? "Video" : "Photo"}`,
    `Created: ${safeTimestamp(item.createTime)}`,
    `MIME type: ${safeText(item.mediaFile.mimeType, 120) || "Unknown"}`,
    `Dimensions: ${dimensions}`,
    `Camera: ${camera}`,
    detectedText ? `Detected text:\n${detectedText}` : "Detected text: None available",
  ].join("\n");
  return {
    idempotencyKey: `oauth:google:photos:${actorKey}:${itemKey}`,
    document: {
      title: filename,
      content,
      source,
      sourceType: "api" as const,
      tags: ["connected-source", "google", "photos", item.type.toLowerCase()],
      metadata: {
        provider: "google",
        category: "photos",
        providerItemKey: itemKey,
        createdAt: safeTimestamp(item.createTime),
        mediaType: item.type.toLowerCase(),
        mimeType: safeText(item.mediaFile.mimeType, 120),
        filename,
        width: Number(metadata.width || 0),
        height: Number(metadata.height || 0),
        visualExtraction,
      },
      evidenceRefs: [`google-photos:${itemKey}`],
    },
  };
}

function captureAssetMetadata(item: PickedMediaItem, itemKey: string) {
  const metadata = item.mediaFile.mediaFileMetadata || {};
  return {
    importSource: GOOGLE_PHOTOS_CAPTURE_SOURCE,
    provider: "google",
    category: "photos",
    providerItemKey: itemKey,
    providerCreatedAt: safeTimestamp(item.createTime, ""),
    mediaType: "photo",
    width: Number(metadata.width || 0),
    height: Number(metadata.height || 0),
    cameraMake: safeText(metadata.cameraMake, 160),
    cameraModel: safeText(metadata.cameraModel, 160),
  };
}

function projectImportedCaptureAsset(
  asset: CaptureAsset,
  itemKey: string,
  jobId: string,
) {
  return {
    id: asset.id,
    filename: asset.filename,
    mediaType: asset.mediaType,
    byteCount: asset.byteCount,
    status: asset.status,
    extractionStatus: asset.extractionStatus,
    jobId,
    metadata: {
      provider: "google",
      category: "photos",
      mediaType: "photo",
      providerItemKey: itemKey,
      createdAt: safeTimestamp(asset.metadata.providerCreatedAt, ""),
      width: boundedDimension(asset.metadata.width) || 0,
      height: boundedDimension(asset.metadata.height) || 0,
    },
  };
}

function projectMetadataOnlyImport(
  item: PickedMediaItem,
  itemKey: string,
  jobId: string,
) {
  const metadata = item.mediaFile.mediaFileMetadata || {};
  return {
    filename: safeFilename(item.mediaFile.filename),
    jobId,
    metadata: {
      provider: "google",
      category: "photos",
      mediaType: "video",
      providerItemKey: itemKey,
      createdAt: safeTimestamp(item.createTime, ""),
      width: Number(metadata.width || 0),
      height: Number(metadata.height || 0),
      transferState: "metadata_only" as const,
    },
  };
}

function providerItemKey(providerItemId: string) {
  return createHash("sha256").update(providerItemId).digest("hex").slice(0, 40);
}

async function existingImportedCaptureAsset(
  identity: PickerIdentity,
  itemKey: string,
) {
  const candidates = await listExactCaptureAssetsByMetadata(identity, {
    field: "importSource",
    value: GOOGLE_PHOTOS_CAPTURE_SOURCE,
    secondary: { field: "providerItemKey", value: itemKey },
    limit: 2,
  });
  const imported = candidates.filter((asset) =>
    asset.tenantId === identity.tenantId &&
    asset.actorId === identity.actorId &&
    safeText(asset.metadata.importSource, 80) === GOOGLE_PHOTOS_CAPTURE_SOURCE
  );
  if (imported.length > 1) {
    throw new GooglePhotosPickerError(
      "This selected photo has conflicting private imports.",
      409,
      "photo_import_conflict",
    );
  }
  return imported[0];
}

function captureAssetIdempotencyKey(identity: PickerIdentity, itemKey: string) {
  return `oauth:google:photos:asset:${actorSourceKey(identity)}:${itemKey}`;
}

function pickerItemExecutionScope(
  identity: PickerIdentity,
  requestScope: ExecutionScope,
  itemKey: string,
) {
  const correlationId = `google-photos:${createHash("sha256")
    .update(`${identity.tenantId}\0${identity.actorId}\0${itemKey}`)
    .digest("hex")
    .slice(0, 48)}`;
  return createExecutionScope({
    tenantId: requestScope.tenantId,
    initiatingActorId: requestScope.initiatingActorId,
    executingPrincipalType: requestScope.executingPrincipalType,
    executingPrincipalId: requestScope.executingPrincipalId,
    workspaceId: requestScope.workspaceId,
    projectId: requestScope.projectId,
    missionId: requestScope.missionId,
    delegationId: requestScope.delegationId,
    correlationId,
    causationId: requestScope.correlationId,
    contextGrantIds: requestScope.contextGrantIds,
    capabilityGrantIds: requestScope.capabilityGrantIds,
    purpose: "connector.google_photos.persist_selection",
  });
}

function requirePickerExecutionScope(
  identity: PickerIdentity,
  value: ExecutionScope,
) {
  const scope = parsePersistedExecutionScope(value);
  if (!scope) {
    throw new Error("Google Photos mutation requires an authenticated execution scope.");
  }
  assertExecutionScopeTenant(scope, identity.tenantId);
  if (
    scope.initiatingActorId !== identity.actorId ||
    scope.executingPrincipalType !== "user" ||
    scope.executingPrincipalId !== identity.actorId
  ) {
    throw new Error("Google Photos execution scope does not match the authenticated actor.");
  }
  return scope;
}

function importFailure(item: PickedMediaItem, error: unknown) {
  if (error instanceof GooglePhotosPickerError) {
    return {
      filename: safeFilename(item.mediaFile.filename),
      code: error.code,
      reason: error.message,
    };
  }
  if (error instanceof CaptureAssetError) {
    return {
      filename: safeFilename(item.mediaFile.filename),
      code: error.status === 413 ? "photo_too_large" : "asset_save_failed",
      reason: error.status === 413
        ? "This photo exceeds the 20 MB Capture limit."
        : "This photo could not be saved privately.",
    };
  }
  if (error instanceof BackgroundJobIdempotencyConflictError) {
    return {
      filename: safeFilename(item.mediaFile.filename),
      code: "idempotency_conflict",
      reason: "A different import is already bound to this selected item.",
    };
  }
  return {
    filename: safeFilename(item.mediaFile.filename),
    code: "import_failed",
    reason: "This item could not be saved and queued for processing.",
  };
}

async function cancelCaptureAssetJob(jobId: string | undefined, tenantId: string) {
  if (!jobId) return;
  const job = await getOperationJob(jobId, { tenantId });
  if (job?.dedupeKey) {
    await cancelOperationJobByDedupeKey(
      job.dedupeKey,
      "Google Photos import deleted by its owner.",
      { tenantId },
    );
  }
}

function parsePickingSession(value: Record<string, unknown>): ProviderPickingSession {
  const id = safeText(value.id, 1_000);
  if (!id || /[\u0000-\u001f]/.test(id)) {
    throw new GooglePhotosPickerError(
      "Google Photos returned an invalid picker session.",
      502,
      "invalid_provider_response",
    );
  }
  const polling = record(value.pollingConfig);
  return {
    id,
    pickerUri: safePickerUri(value.pickerUri),
    expireTime: safeTimestamp(value.expireTime, ""),
    mediaItemsSet: value.mediaItemsSet === true,
    pollingConfig: {
      pollInterval: safeText(polling.pollInterval, 40),
      timeoutIn: safeText(polling.timeoutIn, 40),
    },
  };
}

function parsePickedMediaItem(value: unknown): PickedMediaItem | undefined {
  const candidate = record(value);
  const mediaFile = record(candidate.mediaFile);
  const metadata = record(mediaFile.mediaFileMetadata);
  const videoMetadata = record(metadata.videoMetadata);
  const id = safeText(candidate.id, 1_000);
  const baseUrl = safeText(mediaFile.baseUrl, 4_000);
  const type = candidate.type === "VIDEO" ? "VIDEO" : candidate.type === "PHOTO" ? "PHOTO" : undefined;
  if (!id || !baseUrl || !type) return undefined;
  return {
    id,
    createTime: safeTimestamp(candidate.createTime, ""),
    type,
    mediaFile: {
      baseUrl,
      mimeType: safeText(mediaFile.mimeType, 120),
      filename: safeFilename(mediaFile.filename),
      mediaFileMetadata: {
        width: boundedDimension(metadata.width),
        height: boundedDimension(metadata.height),
        cameraMake: safeText(metadata.cameraMake, 160),
        cameraModel: safeText(metadata.cameraModel, 160),
        videoMetadata: { processingStatus: safeText(videoMetadata.processingStatus, 40) },
      },
    },
  };
}

async function providerJson(
  url: string,
  accessToken: string,
  init: RequestInit,
  signal?: AbortSignal,
) {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${accessToken}`);
    headers.set("accept", "application/json");
    response = await fetch(url, {
      ...init,
      headers,
      redirect: "error",
      signal: boundedSignal(signal, 20_000),
    });
  } catch {
    throw new GooglePhotosPickerError(
      "Google Photos did not respond in time.",
      504,
      "provider_timeout",
    );
  }
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw providerError(response.status, body);
  return body;
}

async function deleteProviderSession(sessionId: string, accessToken: string, signal?: AbortSignal) {
  await providerJson(
    `${PICKER_API}/sessions/${encodeURIComponent(sessionId)}`,
    accessToken,
    { method: "DELETE" },
    signal,
  );
}

function providerError(status: number, body: Record<string, unknown>) {
  const providerStatus = safeText(record(body.error).status, 80);
  if (providerStatus === "UNAUTHENTICATED" || status === 401) {
    return new GooglePhotosPickerError(
      "Google Photos access expired. Reconnect Google to continue.",
      409,
      "google_reconnect_required",
      true,
    );
  }
  if (providerStatus === "NOT_FOUND" || status === 404) {
    return new GooglePhotosPickerError("This photo selection no longer exists.", 404, "session_not_found");
  }
  if (providerStatus === "FAILED_PRECONDITION" || status === 412) {
    return new GooglePhotosPickerError("Finish choosing photos before importing them.", 409, "selection_not_ready");
  }
  if (providerStatus === "RESOURCE_EXHAUSTED" || status === 429) {
    return new GooglePhotosPickerError("Too many photo selections are open. Try again shortly.", 429, "picker_limit_reached");
  }
  if (providerStatus === "PERMISSION_DENIED" || status === 403) {
    return new GooglePhotosPickerError(
      "Google Photos permission is unavailable. Reconnect Google and confirm the Photos permission.",
      403,
      "photos_permission_denied",
      true,
    );
  }
  if (providerStatus === "INVALID_ARGUMENT" || status === 400) {
    return new GooglePhotosPickerError("Google Photos rejected this selection request.", 400, "invalid_picker_request");
  }
  return new GooglePhotosPickerError("Google Photos could not complete this request.", 502, "provider_error");
}

function sealSessionHandle(identity: PickerIdentity, sessionId: string, expiresAt: number) {
  const payload: PickerHandlePayload = {
    version: 1,
    tenantId: identity.tenantId,
    actorId: identity.actorId,
    sessionId,
    issuedAt: Date.now(),
    expiresAt,
  };
  const sealed = sealJsonPayload(payload, sessionBinding(identity));
  return Buffer.from(JSON.stringify(sealed), "utf8").toString("base64url");
}

function openSessionHandle(
  identity: PickerIdentity,
  handle: string,
  options: { allowRecentlyExpired?: boolean } = {},
) {
  if (!/^[A-Za-z0-9_-]{40,4000}$/.test(handle)) {
    throw new GooglePhotosPickerError("The photo selection handle is invalid.", 400, "invalid_session_handle");
  }
  let payload: PickerHandlePayload;
  try {
    const sealed = JSON.parse(Buffer.from(handle, "base64url").toString("utf8"));
    payload = openJsonPayload(sealed, sessionBinding(identity)) as PickerHandlePayload;
  } catch {
    throw new GooglePhotosPickerError("The photo selection handle is invalid.", 400, "invalid_session_handle");
  }
  const expiredGrace = options.allowRecentlyExpired ? 10 * 60_000 : 0;
  if (
    payload.version !== 1 ||
    payload.tenantId !== identity.tenantId ||
    payload.actorId !== identity.actorId ||
    !safeText(payload.sessionId, 1_000) ||
    !Number.isFinite(payload.issuedAt) ||
    !Number.isFinite(payload.expiresAt) ||
    payload.issuedAt > Date.now() + 60_000 ||
    payload.issuedAt < Date.now() - MAX_SESSION_LIFETIME_MS - 10 * 60_000 ||
    payload.expiresAt + expiredGrace < Date.now()
  ) {
    throw new GooglePhotosPickerError("This photo selection has expired.", 410, "session_expired");
  }
  return payload;
}

function publicSession(
  session: ProviderPickingSession,
  handle: string,
  expiresAt: number,
): GooglePhotosPickerSession {
  return {
    handle,
    pickerUri: session.pickerUri,
    expiresAt: new Date(expiresAt).toISOString(),
    mediaItemsSet: session.mediaItemsSet,
    pollAfterMs: parseProviderDuration(session.pollingConfig?.pollInterval, 3_000, 1_000, 30_000),
    timeoutAfterMs: parseProviderDuration(session.pollingConfig?.timeoutIn, 15 * 60_000, 5_000, 30 * 60_000),
  };
}

function boundedSessionExpiry(value?: string) {
  const providerExpiry = Date.parse(value || "");
  const fallback = Date.now() + 60 * 60_000;
  return Math.min(
    Number.isFinite(providerExpiry) && providerExpiry > Date.now() ? providerExpiry : fallback,
    Date.now() + MAX_SESSION_LIFETIME_MS,
  );
}

function parseProviderDuration(value: string | undefined, fallback: number, min: number, max: number) {
  const match = String(value || "").match(/^(\d+(?:\.\d+)?)s$/);
  const milliseconds = match ? Number(match[1]) * 1_000 : fallback;
  return Math.min(Math.max(Math.round(milliseconds), min), max);
}

function sessionBinding(identity: PickerIdentity) {
  return `google-photos-picker:${identity.tenantId}:${identity.actorId}`;
}

function actorSourceKey(identity: PickerIdentity) {
  return createHash("sha256")
    .update(`${identity.tenantId}:${identity.actorId}`)
    .digest("hex")
    .slice(0, 16);
}

function googlePhotosSourcePrefix(identity: PickerIdentity) {
  return `google:photos:${actorSourceKey(identity)}:`;
}

function boundedSignal(signal: AbortSignal | undefined, timeoutMs: number) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function safePickerUri(value: unknown) {
  const candidate = safeText(value, 4_000);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (
      url.protocol !== "https:" ||
      !(url.hostname === "google.com" || url.hostname.endsWith(".google.com"))
    ) return undefined;
    if (!url.pathname.endsWith("/autoclose")) {
      url.pathname = `${url.pathname.replace(/\/+$/, "")}/autoclose`;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function previewExtension(mimeType: string) {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return undefined;
}

function originalFilename(item: PickedMediaItem, mimeType: string) {
  const filename = safeFilename(item.mediaFile.filename);
  if (/\.[a-zA-Z0-9]{1,20}$/.test(filename)) return filename;
  const extension = originalPhotoExtension(mimeType);
  return extension ? `${filename}.${extension}` : filename;
}

function originalPhotoExtension(mimeType: string) {
  if (mimeType === "image/jpeg" || mimeType === "image/jpg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/heic") return "heic";
  if (mimeType === "image/heif") return "heif";
  if (mimeType === "image/avif") return "avif";
  if (mimeType === "image/gif") return "gif";
  return undefined;
}

function normalizedMediaType(value: unknown) {
  const mediaType = String(value || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase()
    .slice(0, 120);
  return /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/.test(mediaType)
    ? mediaType
    : "";
}

function previewFilename(item: PickedMediaItem, extension: string) {
  const base = safeFilename(item.mediaFile.filename).replace(/\.[^.]+$/, "");
  return `${base || "google-photo"}.${extension}`;
}

function safeFilename(value: unknown) {
  const result = safeText(value, 240)
    .replace(/[\u0000-\u001f/\\]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return result || "Google Photos item";
}

function safeTimestamp(value: unknown, fallback = "Unknown") {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function boundedDimension(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 100_000 ? parsed : undefined;
}

function safeText(value: unknown, max = 2_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
