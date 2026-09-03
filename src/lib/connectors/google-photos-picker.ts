import { createHash, randomUUID } from "node:crypto";
import { extractCaptureFile } from "@/lib/capture/files";
import {
  GOOGLE_PHOTOS_PICKER_SCOPE,
  refreshOAuthAccess,
} from "@/lib/connectors/oauth-providers";
import {
  getOAuthGrantSecrets,
  saveOAuthGrant,
} from "@/lib/connectors/oauth-store";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueKnowledgeIngestJob,
} from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import { openJsonPayload, sealJsonPayload } from "@/lib/security/sealed-payload";

const PICKER_API = "https://photospicker.googleapis.com/v1";
const DEFAULT_ITEM_LIMIT = 12;
export const MAX_GOOGLE_PHOTOS_PICKER_ITEMS = 20;
const MAX_SESSION_LIFETIME_MS = 24 * 60 * 60_000;
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024;
const MAX_TOTAL_PREVIEW_BYTES = 24 * 1024 * 1024;

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
  signal?: AbortSignal,
) {
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
  const skipped: Array<{ filename: string; reason: string }> = [];
  let downloadedBytes = 0;

  for (const item of selection.items) {
    signal?.throwIfAborted();
    let detectedText = "";
    let visualExtraction: "text_detected" | "metadata_only" = "metadata_only";
    const remainingBytes = MAX_TOTAL_PREVIEW_BYTES - downloadedBytes;
    if (remainingBytes > 0) {
      try {
        const preview = await downloadPreview(
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
          sourceStreamId: `google-photos-picker:${sealed.sessionId}`,
          operation: "ocr",
          purpose: "connector.google_photos.extract",
          credentialSource: "deployment_environment",
        });
        detectedText = extracted.content.trim().slice(0, 100_000);
        visualExtraction = detectedText ? "text_detected" : "metadata_only";
      } catch {
        // A selected item remains useful as indexed metadata when its preview
        // is unavailable, too large, still processing, or OCR is not enabled.
      }
    }

    const request = knowledgeRequest(item, identity, detectedText, visualExtraction);
    try {
      const job = await enqueueKnowledgeIngestJob({
        tenantId: identity.tenantId,
        actorId: identity.actorId,
        idempotencyKey: request.idempotencyKey,
        request: request.document,
      });
      jobs.push(projectOperationJobStatus(job));
    } catch (error) {
      skipped.push({
        filename: safeFilename(item.mediaFile.filename),
        reason: error instanceof BackgroundJobIdempotencyConflictError
          ? "A different import for this item is already indexed."
          : "This item could not be queued for indexing.",
      });
    }
  }

  let sessionDeleted = false;
  try {
    await deleteProviderSession(sealed.sessionId, accessToken, signal);
    sessionDeleted = true;
  } catch {
    // Import success must not be discarded if provider-side cleanup fails.
  }

  return {
    selected: selection.items.length,
    imported: jobs.length,
    skipped,
    jobs,
    selectionTruncated: selection.truncated,
    sessionDeleted,
  };
}

export async function deleteImportedGooglePhotos(identity: PickerIdentity) {
  return deleteKnowledgeDocumentsBySourcePrefix(googlePhotosSourcePrefix(identity), {
    tenantId: identity.tenantId,
  });
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
  const secrets = await getOAuthGrantSecrets(identity.tenantId, identity.actorId, "google");
  if (!secrets) {
    throw new GooglePhotosPickerError(
      "Connect Google before choosing photos.",
      409,
      "google_not_connected",
      true,
    );
  }
  if (!secrets.grant.scopes.includes(GOOGLE_PHOTOS_PICKER_SCOPE)) {
    throw new GooglePhotosPickerError(
      "Reconnect Google to allow choosing photos.",
      409,
      "photos_scope_required",
      true,
    );
  }

  const current = typeof secrets.tokens.access_token === "string"
    ? secrets.tokens.access_token
    : "";
  if (current && (!secrets.grant.expiresAt || Date.parse(secrets.grant.expiresAt) > Date.now() + 60_000)) {
    return current;
  }
  const refreshToken = typeof secrets.tokens.refresh_token === "string"
    ? secrets.tokens.refresh_token
    : "";
  if (!refreshToken) {
    throw new GooglePhotosPickerError(
      "Google Photos access expired. Reconnect Google to continue.",
      409,
      "google_reconnect_required",
      true,
    );
  }
  try {
    const refreshed = await refreshOAuthAccess("google", refreshToken);
    await saveOAuthGrant({
      tenantId: identity.tenantId,
      actorId: identity.actorId,
      provider: "google",
      tokens: refreshed,
    });
    return String(refreshed.access_token);
  } catch {
    throw new GooglePhotosPickerError(
      "Google Photos access expired. Reconnect Google to continue.",
      409,
      "google_reconnect_required",
      true,
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

async function downloadPreview(
  item: PickedMediaItem,
  accessToken: string,
  maxBytes: number,
  signal?: AbortSignal,
) {
  if (item.type === "VIDEO" && item.mediaFile.mediaFileMetadata?.videoMetadata?.processingStatus !== "READY") {
    throw new GooglePhotosPickerError("The selected video is still processing.", 409, "video_processing");
  }
  const baseUrl = new URL(item.mediaFile.baseUrl);
  if (
    baseUrl.protocol !== "https:" ||
    !(baseUrl.hostname === "googleusercontent.com" || baseUrl.hostname.endsWith(".googleusercontent.com"))
  ) {
    throw new GooglePhotosPickerError("Google Photos returned an unsafe media URL.", 502, "unsafe_media_url");
  }
  const downloadUrl = `${baseUrl.toString()}${item.type === "VIDEO" ? "=w1600-h1600-no" : "=w2048-h2048"}`;
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
  detectedText: string,
  visualExtraction: "text_detected" | "metadata_only",
) {
  const metadata = item.mediaFile.mediaFileMetadata || {};
  const filename = safeFilename(item.mediaFile.filename);
  const itemKey = createHash("sha256").update(item.id).digest("hex").slice(0, 40);
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
        providerItemId: safeText(item.id, 1_000),
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
