import { randomUUID } from "node:crypto";
import {
  claimSourceSyncPage,
  commitSourceSyncPage,
  failSourceSyncPage,
  pinSourceSyncBackfillFence,
  sourceSyncFailureSha256,
  type ClaimedSourceSyncPage,
  type SourceSyncFailureCode,
  type SourceSyncPageManifestItem,
  type SourceSyncStreamIdentity,
} from "@/lib/connectors/source-sync-checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const DRIVE_API_ORIGIN = "https://www.googleapis.com";
const DRIVE_PAGE_SIZE = 100;
const SHADOW_DEADLINE_MS = 45_000;

export const GOOGLE_DRIVE_SHADOW_ROLLOUT_GENERATION = 1;
export const GOOGLE_DRIVE_SHADOW_ENGINE_VERSION = "source-sync.p2.2a";
export const GOOGLE_DRIVE_SHADOW_ADAPTER_VERSION =
  "google-drive.metadata-shadow.v1";

const GOOGLE_DRIVE_SHADOW_ADAPTER_CONFIG_SHA256 = sourceContractSha256({
  provider: "google",
  sourceId: "drive",
  pageSize: DRIVE_PAGE_SIZE,
  backfill: "files.list",
  changes: "changes.list",
  includeItemsFromAllDrives: true,
  includeRemoved: true,
  persistence: "hash-only-shadow",
});

type GoogleDriveShadowInput = Readonly<{
  accessToken: string;
  tenantId: string;
  actorId: string;
  connectionId: string;
  authorizationGeneration: number;
  abortSignal?: AbortSignal;
}>;

type GoogleJsonResponse = Readonly<{
  body: Record<string, unknown>;
  responseObservedAt?: string;
}>;

type ObservedDrivePage = Readonly<{
  items: SourceSyncPageManifestItem[];
  next: {
    phase: "backfill" | "changes";
    cursor: { pageToken?: string; fenceToken: string };
  };
  observedAt: string;
}>;

/**
 * Observes at most one Drive metadata page. It cannot ingest, delete, or alter
 * the legacy connector cursor; its only durable output is a hash-only shadow
 * manifest plus the next sealed shadow cursor.
 */
export async function observeGoogleDriveShadow(input: GoogleDriveShadowInput) {
  const accessToken = requiredProviderValue(input.accessToken, "access token");
  const identity = shadowIdentity(input);
  const claim = await claimSourceSyncPage(identity);
  if (claim.status !== "claimed") return claim;

  let page = claim.page;
  const signal = boundedSignal(input.abortSignal);
  try {
    if (page.phase === "backfill" && !page.requestCursor?.fenceToken) {
      const fenceToken = await fetchStartPageToken(accessToken, signal);
      page = await pinSourceSyncBackfillFence(page, fenceToken);
    }

    const observed = page.phase === "backfill"
      ? await observeBackfillPage(accessToken, page, signal)
      : await observeChangesPage(accessToken, page, signal);
    return await commitSourceSyncPage({
      page,
      items: observed.items,
      next: observed.next,
      observedAt: observed.observedAt,
    });
  } catch (error) {
    const code = failureCode(error, signal);
    await failSourceSyncPage({
      page,
      code,
      failureSha256: sourceSyncFailureSha256(error),
    }).catch(() => undefined);
    throw new GoogleDriveShadowError(code);
  }
}

async function fetchStartPageToken(
  accessToken: string,
  signal: AbortSignal,
) {
  const url = driveUrl("/drive/v3/changes/startPageToken");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleJson(url, accessToken, signal);
  return requiredProviderValue(
    response.body.startPageToken,
    "start page token",
  );
}

async function observeBackfillPage(
  accessToken: string,
  page: ClaimedSourceSyncPage,
  signal: AbortSignal,
): Promise<ObservedDrivePage> {
  const fenceToken = requiredProviderValue(
    page.requestCursor?.fenceToken,
    "pinned change fence",
  );
  const url = driveUrl("/drive/v3/files");
  url.searchParams.set("pageSize", String(DRIVE_PAGE_SIZE));
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("corpora", "user");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set("q", "trashed = false");
  url.searchParams.set("orderBy", "modifiedTime,name");
  url.searchParams.set(
    "fields",
    "nextPageToken,incompleteSearch,files(id,version,headRevisionId,mimeType,createdTime,modifiedTime,trashed,md5Checksum,size)",
  );
  if (page.requestCursor?.pageToken) {
    url.searchParams.set("pageToken", page.requestCursor.pageToken);
  }

  const response = await googleJson(url, accessToken, signal);
  if (response.body.incompleteSearch === true) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  const files = providerArray(response.body.files, "files");
  const items = uniqueManifestItems(files.map((value) =>
    backfillManifestItem(providerRecord(value, "file"), page)
  ));
  const nextPageToken = optionalProviderValue(response.body.nextPageToken);
  return {
    items,
    next: nextPageToken
      ? {
          phase: "backfill",
          cursor: { pageToken: nextPageToken, fenceToken },
        }
      : {
          phase: "changes",
          cursor: { pageToken: fenceToken, fenceToken },
        },
    observedAt: pageObservedAt(items, response.responseObservedAt),
  };
}

async function observeChangesPage(
  accessToken: string,
  page: ClaimedSourceSyncPage,
  signal: AbortSignal,
): Promise<ObservedDrivePage> {
  const pageToken = requiredProviderValue(
    page.requestCursor?.pageToken,
    "changes page token",
  );
  const fenceToken = requiredProviderValue(
    page.requestCursor?.fenceToken,
    "changes fence token",
  );
  const url = driveUrl("/drive/v3/changes");
  url.searchParams.set("pageToken", pageToken);
  url.searchParams.set("pageSize", String(DRIVE_PAGE_SIZE));
  url.searchParams.set("spaces", "drive");
  url.searchParams.set("includeRemoved", "true");
  url.searchParams.set("includeItemsFromAllDrives", "true");
  url.searchParams.set("supportsAllDrives", "true");
  url.searchParams.set(
    "fields",
    "nextPageToken,newStartPageToken,changes(changeType,fileId,removed,time,file(id,version,headRevisionId,mimeType,createdTime,modifiedTime,trashed,md5Checksum,size))",
  );

  const response = await googleJson(url, accessToken, signal);
  const changes = providerArray(response.body.changes, "changes");
  const items = uniqueManifestItems(changes.flatMap((value) => {
    const change = providerRecord(value, "change");
    const changeType = optionalProviderValue(change.changeType);
    if (changeType === "drive") return [];
    if (changeType && changeType !== "file") {
      throw new GoogleDriveProviderError("invalid_provider_response");
    }
    return [changesManifestItem(change, page)];
  }));
  const nextPageToken = optionalProviderValue(response.body.nextPageToken);
  const newStartPageToken = optionalProviderValue(
    response.body.newStartPageToken,
  );
  const next = nextPageToken
    ? {
        phase: "changes" as const,
        cursor: { pageToken: nextPageToken, fenceToken },
      }
    : {
        phase: "changes" as const,
        cursor: {
          pageToken: requiredProviderValue(
            newStartPageToken,
            "new start page token",
          ),
          fenceToken: requiredProviderValue(
            newStartPageToken,
            "new start page token",
          ),
        },
      };
  return {
    items,
    next,
    observedAt: pageObservedAt(items, response.responseObservedAt),
  };
}

function backfillManifestItem(
  file: Record<string, unknown>,
  page: ClaimedSourceSyncPage,
): SourceSyncPageManifestItem {
  const externalItemId = requiredProviderValue(file.id, "file ID");
  const observedAt = providerTimestamp(
    optionalProviderValue(file.modifiedTime) ||
      requiredProviderValue(file.createdTime, "file timestamp"),
  );
  const providerItemKeySha256 = providerItemKey(externalItemId);
  const providerRevisionKeySha256 = sourceContractSha256(
    revisionProjection(file, externalItemId, observedAt),
  );
  return manifestItem({
    page,
    operation: "upsert",
    providerItemKeySha256,
    providerRevisionKeySha256,
    observedAt,
  });
}

function changesManifestItem(
  change: Record<string, unknown>,
  page: ClaimedSourceSyncPage,
): SourceSyncPageManifestItem {
  const externalItemId = requiredProviderValue(change.fileId, "file ID");
  const observedAt = providerTimestamp(
    requiredProviderValue(change.time, "change timestamp"),
  );
  const fileValue = change.file;
  const file = fileValue === null || fileValue === undefined
    ? undefined
    : providerRecord(fileValue, "change file");
  const removed = change.removed === true;
  if (!removed && !file) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  if (file?.id && requiredProviderValue(file.id, "change file ID") !== externalItemId) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  const trashed = file?.trashed === true;
  const operation = removed || trashed ? "delete" as const : "upsert" as const;
  const providerItemKeySha256 = providerItemKey(externalItemId);
  const providerRevisionKeySha256 = sourceContractSha256({
    changeObservedAt: observedAt,
    removed,
    revision: file
      ? revisionProjection(file, externalItemId, observedAt)
      : null,
  });
  return manifestItem({
    page,
    operation,
    providerItemKeySha256,
    providerRevisionKeySha256,
    observedAt,
    ...(operation === "delete"
      ? { deleteReasonCode: removed ? "source_missing" as const : "provider_deleted" as const }
      : {}),
  });
}

function manifestItem(input: {
  page: ClaimedSourceSyncPage;
  operation: "upsert" | "delete";
  providerItemKeySha256: string;
  providerRevisionKeySha256: string;
  observedAt: string;
  deleteReasonCode?: "provider_deleted" | "source_missing";
}): SourceSyncPageManifestItem {
  const adapterEventKeySha256 = sourceContractSha256({
    provider: "google",
    sourceId: "drive",
    connectionId: input.page.identity.connectionId,
    adapterVersionId: input.page.identity.adapterVersionId,
    adapterConfigSha256: input.page.identity.adapterConfigSha256,
    authorizationGeneration: input.page.identity.authorizationGeneration,
    rolloutGeneration: input.page.identity.rolloutGeneration,
    phase: input.page.phase,
    operation: input.operation,
    providerItemKeySha256: input.providerItemKeySha256,
    providerRevisionKeySha256: input.providerRevisionKeySha256,
    observedAt: input.observedAt,
    deleteReasonCode: input.deleteReasonCode || null,
  });
  const manifestItemSha256 = sourceContractSha256({
    operation: input.operation,
    providerItemKeySha256: input.providerItemKeySha256,
    providerRevisionKeySha256: input.providerRevisionKeySha256,
    adapterEventKeySha256,
    observedAt: input.observedAt,
    deleteReasonCode: input.deleteReasonCode || null,
  });
  return {
    operation: input.operation,
    providerItemKeySha256: input.providerItemKeySha256,
    providerRevisionKeySha256: input.providerRevisionKeySha256,
    adapterEventKeySha256,
    observedAt: input.observedAt,
    manifestItemSha256,
    ...(input.deleteReasonCode
      ? { deleteReasonCode: input.deleteReasonCode }
      : {}),
  };
}

function revisionProjection(
  file: Record<string, unknown>,
  externalItemId: string,
  observedAt: string,
) {
  return {
    externalItemId,
    observedAt,
    version: optionalProviderValue(file.version) || null,
    headRevisionId: optionalProviderValue(file.headRevisionId) || null,
    mimeType: optionalProviderValue(file.mimeType) || null,
    createdTime: optionalProviderTimestamp(file.createdTime),
    modifiedTime: optionalProviderTimestamp(file.modifiedTime),
    trashed: file.trashed === true,
    md5Checksum: optionalProviderValue(file.md5Checksum) || null,
    size: optionalProviderValue(file.size) || null,
  };
}

function providerItemKey(externalItemId: string) {
  return sourceContractSha256({ externalItemId });
}

function uniqueManifestItems(items: SourceSyncPageManifestItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.adapterEventKeySha256)) return false;
    seen.add(item.adapterEventKeySha256);
    return true;
  });
}

function shadowIdentity(
  input: GoogleDriveShadowInput,
): SourceSyncStreamIdentity {
  return {
    tenantId: input.tenantId,
    ownerActorId: input.actorId,
    connectionId: input.connectionId,
    provider: "google",
    sourceId: "drive",
    engineVersion: GOOGLE_DRIVE_SHADOW_ENGINE_VERSION,
    adapterVersionId: GOOGLE_DRIVE_SHADOW_ADAPTER_VERSION,
    adapterConfigSha256: GOOGLE_DRIVE_SHADOW_ADAPTER_CONFIG_SHA256,
    authorizationGeneration: input.authorizationGeneration,
    rolloutGeneration: GOOGLE_DRIVE_SHADOW_ROLLOUT_GENERATION,
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "connector.google.drive.shadow",
      correlationId: `google-drive-shadow:${randomUUID()}`,
      contextGrantIds: [input.connectionId],
      purpose: "connector.google.drive.shadow_observe",
    }),
  };
}

async function googleJson(
  url: URL,
  accessToken: string,
  signal: AbortSignal,
): Promise<GoogleJsonResponse> {
  if (url.protocol !== "https:" || url.origin !== DRIVE_API_ORIGIN) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
      signal,
    });
  } catch {
    throw new GoogleDriveProviderError(
      signal.aborted ? "request_aborted" : "provider_unavailable",
    );
  }
  if (!response.ok) {
    throw new GoogleDriveProviderError(httpFailureCode(response.status));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  const responseObservedAt = response.headers.get("date");
  return {
    body: providerRecord(body, "response"),
    ...(responseObservedAt
      ? { responseObservedAt: providerTimestamp(responseObservedAt) }
      : {}),
  };
}

function httpFailureCode(status: number): SourceSyncFailureCode {
  if (status === 401) return "provider_unauthorized";
  if (status === 403) return "provider_forbidden";
  if (status === 410) return "cursor_expired";
  if (status === 429) return "provider_rate_limited";
  if (status === 408 || status >= 500) return "provider_unavailable";
  return "invalid_provider_response";
}

function failureCode(
  error: unknown,
  signal: AbortSignal,
): SourceSyncFailureCode {
  if (signal.aborted) return "request_aborted";
  if (error instanceof GoogleDriveProviderError) return error.code;
  if (error instanceof Error && error.name === "SourceSyncLeaseError") {
    return "lease_lost";
  }
  if (
    error instanceof Error &&
    error.name === "SourceSyncAuthorizationError"
  ) {
    return "provider_unauthorized";
  }
  return "unexpected_failure";
}

function pageObservedAt(
  items: SourceSyncPageManifestItem[],
  responseObservedAt?: string,
) {
  const latestItemTimestamp = items
    .map((item) => item.observedAt)
    .sort()
    .at(-1);
  if (latestItemTimestamp) return latestItemTimestamp;
  if (responseObservedAt) return responseObservedAt;
  throw new GoogleDriveProviderError("invalid_provider_response");
}

function providerRecord(value: unknown, _field: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return value as Record<string, unknown>;
}

function providerArray(value: unknown, _field: string) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DRIVE_PAGE_SIZE) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return value;
}

function requiredProviderValue(value: unknown, _field: string) {
  const normalized = typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value.trim()
      : "";
  if (!normalized || normalized.length > 8_000) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return normalized;
}

function optionalProviderValue(value: unknown) {
  if (value === null || value === undefined || value === "") return undefined;
  return requiredProviderValue(value, "provider value");
}

function providerTimestamp(value: string) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return timestamp.toISOString();
}

function optionalProviderTimestamp(value: unknown) {
  const normalized = optionalProviderValue(value);
  return normalized ? providerTimestamp(normalized) : null;
}

function driveUrl(pathname: string) {
  return new URL(pathname, DRIVE_API_ORIGIN);
}

function boundedSignal(signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(SHADOW_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

class GoogleDriveProviderError extends Error {
  constructor(readonly code: SourceSyncFailureCode) {
    super("Google Drive shadow provider operation failed.");
    this.name = "GoogleDriveProviderError";
  }
}

class GoogleDriveShadowError extends Error {
  constructor(readonly code: SourceSyncFailureCode) {
    super("Google Drive shadow observation failed.");
    this.name = "GoogleDriveShadowError";
  }
}
