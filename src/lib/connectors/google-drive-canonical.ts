import { createHash, randomUUID } from "node:crypto";
import {
  claimCanonicalSourceSyncPage,
  canonicalSourceSyncFailureStage,
  commitCanonicalSourceSyncPage,
  failSourceSyncPage,
  pinCanonicalSourceSyncBackfillFence,
  sourceSyncFailureSha256,
  type CanonicalSourceSyncPrepareMutationContext,
  type ClaimedCanonicalSourceSyncPage,
  type ClaimedSourceSyncPage,
  type SourceSyncCanonicalRolloutBinding,
  type SourceSyncFailureCode,
  type SourceSyncDiagnosticStage,
  type SourceSyncPageManifestItem,
  type SourceSyncStreamIdentity,
} from "@/lib/connectors/source-sync-checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  buildSourceAdapterDeleteV1,
  buildSourceAdapterUpsertV1,
  buildSourceItemV1,
  buildSourceRevisionV1,
  deriveSourceItemIdV1,
  SOURCE_CONTRACT_SCHEMA_VERSION,
  sourceContractSha256,
} from "@/lib/sources/contracts";

const DRIVE_API_ORIGIN = "https://www.googleapis.com";
const DRIVE_PAGE_SIZE = 10;
const CANONICAL_DEADLINE_MS = 20_000;
const EMPTY_CONTENT_SHA256 = createHash("sha256").update("").digest("hex");

export const GOOGLE_DRIVE_CANONICAL_CAPABILITY_ID =
  "source.google-drive.canonical-metadata";
export const GOOGLE_DRIVE_CANONICAL_ROLLOUT_GENERATION = 2;
export const GOOGLE_DRIVE_CANONICAL_ENGINE_VERSION = "source-sync.p2.2b";
export const GOOGLE_DRIVE_CANONICAL_ADAPTER_ID =
  "google-drive.metadata-canonical";
export const GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION =
  "google-drive.metadata-canonical.v1";
export const GOOGLE_DRIVE_CANONICAL_ROLLOUT_MODE = "canary" as const;

const GOOGLE_DRIVE_CANONICAL_PURPOSE_ID =
  "connector.google-drive.metadata-settlement";
const GOOGLE_DRIVE_CANONICAL_RETENTION_POLICY_ID =
  "retention.connection-lifetime";
const GOOGLE_DRIVE_CANONICAL_EXTRACTOR_ID = "google-drive.metadata";
const GOOGLE_DRIVE_CANONICAL_MEDIA_TYPE =
  "application/x.asael-source-metadata";

export const GOOGLE_DRIVE_CANONICAL_ADAPTER_CONFIG_SHA256 =
  sourceContractSha256({
    schemaVersion: 1,
    capabilityId: GOOGLE_DRIVE_CANONICAL_CAPABILITY_ID,
    rolloutGeneration: GOOGLE_DRIVE_CANONICAL_ROLLOUT_GENERATION,
    engineVersion: GOOGLE_DRIVE_CANONICAL_ENGINE_VERSION,
    adapterId: GOOGLE_DRIVE_CANONICAL_ADAPTER_ID,
    adapterVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
    sourceContractSchemaVersion: SOURCE_CONTRACT_SCHEMA_VERSION,
    provider: "google",
    sourceId: "drive",
    pageSize: DRIVE_PAGE_SIZE,
    backfill: "files.list",
    changes: "changes.list",
    includeItemsFromAllDrives: true,
    includeRemoved: true,
    persistence: "canonical-hash-only-metadata",
    sourceBindingPolicy: {
      context: "personal-no-workspace-project-or-mission",
      visibility: "user_private",
      sensitivity: "confidential",
      permissionGrantIds: "exact-connection-id",
      allowedPurposeIds: [GOOGLE_DRIVE_CANONICAL_PURPOSE_ID],
      retentionPolicyId: GOOGLE_DRIVE_CANONICAL_RETENTION_POLICY_ID,
      retentionExpiresAt: null,
    },
    revisionSemantics: {
      sourceKind: "file",
      retainedContent: "empty",
      contentSha256: EMPTY_CONTENT_SHA256,
      contentByteLength: 0,
      mediaType: GOOGLE_DRIVE_CANONICAL_MEDIA_TYPE,
      evidenceUnits: 0,
    },
    readAuthority: "legacy-rag",
  });

export const GOOGLE_DRIVE_CANONICAL_ROLLOUT_BINDING:
  SourceSyncCanonicalRolloutBinding = Object.freeze({
    capabilityId: GOOGLE_DRIVE_CANONICAL_CAPABILITY_ID,
    contractVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
    mode: GOOGLE_DRIVE_CANONICAL_ROLLOUT_MODE,
  });

type GoogleDriveCanonicalInput = Readonly<{
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

type CanonicalDriveMetadata = Readonly<{
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  capturedAt: string;
  metadataSha256: string;
}>;

type ObservedDriveItem = Readonly<{
  manifest: SourceSyncPageManifestItem;
  metadata?: CanonicalDriveMetadata;
}>;

type ObservedDrivePage = Readonly<{
  items: ObservedDriveItem[];
  next: {
    phase: "backfill" | "changes";
    cursor: { pageToken?: string; fenceToken: string };
  };
  observedAt: string;
}>;

/**
 * Settles at most one small Drive metadata page into the canonical source
 * ledger. It is inactive unless the exact tenant capability generation is
 * active, and it never changes the legacy connector cursor or served RAG.
 */
export async function observeGoogleDriveCanonicalMetadata(
  input: GoogleDriveCanonicalInput,
) {
  const accessToken = requiredProviderValue(input.accessToken);
  const identity = canonicalIdentity(input);
  const claim = await claimCanonicalSourceSyncPage(
    identity,
    GOOGLE_DRIVE_CANONICAL_ROLLOUT_BINDING,
  );
  if (claim.status !== "claimed") return claim;

  let page = claim.page;
  const signal = boundedSignal(input.abortSignal);
  let stage: SourceSyncDiagnosticStage = "pin_fence";
  try {
    if (page.phase === "backfill" && !page.requestCursor?.fenceToken) {
      const fenceToken = await fetchStartPageToken(accessToken, signal);
      page = await pinCanonicalSourceSyncBackfillFence(
        page,
        fenceToken,
        GOOGLE_DRIVE_CANONICAL_ROLLOUT_BINDING,
      );
    }

    stage = "observe_page";
    const observed = page.phase === "backfill"
      ? await observeBackfillPage(accessToken, page, signal)
      : await observeChangesPage(accessToken, page, signal);
    stage = "commit_page";
    return await commitCanonicalSourceSyncPage({
      page,
      rolloutBinding: GOOGLE_DRIVE_CANONICAL_ROLLOUT_BINDING,
      items: observed.items.map((item) => item.manifest),
      next: observed.next,
      observedAt: observed.observedAt,
      prepareMutation: async ({
        sql,
        page: transactionPage,
        item,
        ordinal,
        order,
      }) => {
        const observedItem = observed.items[ordinal];
        if (
          !observedItem ||
          observedItem.manifest.manifestItemSha256 !== item.manifestItemSha256
        ) {
          throw new Error("Drive canonical page material no longer matches its manifest.");
        }
        return prepareMutation(sql, transactionPage, observedItem, order);
      },
    });
  } catch (error) {
    const code = failureCode(error, signal);
    const diagnosticStage = canonicalSourceSyncFailureStage(error) || stage;
    console.warn(JSON.stringify({
      level: "warn",
      event: "google_drive.canonical_metadata.failed",
      phase: page.phase,
      stage: diagnosticStage,
      code,
      diagnostic: safeFailureDiagnostic(error),
    }));
    await failSourceSyncPage({
      page,
      code,
      failureSha256: sourceSyncFailureSha256(error),
      diagnosticStage,
    }).catch(() => undefined);
    throw new GoogleDriveCanonicalError(code);
  }
}

async function fetchStartPageToken(
  accessToken: string,
  signal: AbortSignal,
) {
  const url = driveUrl("/drive/v3/changes/startPageToken");
  url.searchParams.set("supportsAllDrives", "true");
  const response = await googleJson(url, accessToken, signal);
  return requiredProviderValue(response.body.startPageToken);
}

async function observeBackfillPage(
  accessToken: string,
  page: ClaimedSourceSyncPage,
  signal: AbortSignal,
): Promise<ObservedDrivePage> {
  const fenceToken = requiredProviderValue(page.requestCursor?.fenceToken);
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
  const items = uniqueObservedItems(
    providerArray(response.body.files).map((value) =>
      backfillObservedItem(providerRecord(value), page)
    ),
  );
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
  const pageToken = requiredProviderValue(page.requestCursor?.pageToken);
  const fenceToken = requiredProviderValue(page.requestCursor?.fenceToken);
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
  const items = uniqueObservedItems(
    providerArray(response.body.changes).flatMap((value) => {
      const change = providerRecord(value);
      const changeType = optionalProviderValue(change.changeType);
      if (changeType === "drive") return [];
      if (changeType && changeType !== "file") {
        throw new GoogleDriveProviderError("invalid_provider_response");
      }
      return [changesObservedItem(change, page)];
    }),
  );
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
          pageToken: requiredProviderValue(newStartPageToken),
          fenceToken: requiredProviderValue(newStartPageToken),
        },
      };
  return {
    items,
    next,
    observedAt: pageObservedAt(items, response.responseObservedAt),
  };
}

function backfillObservedItem(
  file: Record<string, unknown>,
  page: ClaimedSourceSyncPage,
): ObservedDriveItem {
  const externalItemId = requiredProviderValue(file.id);
  const providerItemKeySha256 = providerItemKey(externalItemId);
  const metadata = normalizedMetadata(file, providerItemKeySha256);
  const observedAt = metadata.capturedAt;
  const providerRevisionKeySha256 = sourceContractSha256({
    providerItemKeySha256,
    metadataSha256: metadata.metadataSha256,
    observedAt,
  });
  return {
    metadata,
    manifest: manifestItem({
      page,
      operation: "upsert",
      providerItemKeySha256,
      providerRevisionKeySha256,
      observedAt,
    }),
  };
}

function changesObservedItem(
  change: Record<string, unknown>,
  page: ClaimedSourceSyncPage,
): ObservedDriveItem {
  const externalItemId = requiredProviderValue(change.fileId);
  const changeObservedAt = providerTimestamp(requiredProviderValue(change.time));
  const fileValue = change.file;
  const file = fileValue === null || fileValue === undefined
    ? undefined
    : providerRecord(fileValue);
  const removed = change.removed === true;
  if (!removed && !file) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  if (file?.id && requiredProviderValue(file.id) !== externalItemId) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }

  const trashed = file?.trashed === true;
  const operation = removed || trashed ? "delete" as const : "upsert" as const;
  const providerItemKeySha256 = providerItemKey(externalItemId);
  const metadata = operation === "upsert" && file
    ? normalizedMetadata(file, providerItemKeySha256, changeObservedAt)
    : undefined;
  const providerRevisionKeySha256 = sourceContractSha256({
    providerItemKeySha256,
    changeObservedAt,
    removed,
    trashed,
    metadataSha256: metadata?.metadataSha256 || null,
  });
  return {
    ...(metadata ? { metadata } : {}),
    manifest: manifestItem({
      page,
      operation,
      providerItemKeySha256,
      providerRevisionKeySha256,
      observedAt: changeObservedAt,
      ...(operation === "delete"
        ? {
            deleteReasonCode: removed
              ? "source_missing" as const
              : "provider_deleted" as const,
          }
        : {}),
    }),
  };
}

function normalizedMetadata(
  file: Record<string, unknown>,
  providerItemKeySha256: string,
  observedAtInput?: string,
): CanonicalDriveMetadata {
  const sourceCreatedAt = optionalProviderTimestamp(file.createdTime);
  const sourceUpdatedAt = optionalProviderTimestamp(file.modifiedTime);
  const capturedAt = latestTimestamp(
    observedAtInput,
    sourceUpdatedAt,
    sourceCreatedAt,
  );
  const metadataSha256 = sourceContractSha256({
    schemaVersion: 1,
    providerItemKeySha256,
    version: optionalProviderValue(file.version) || null,
    headRevisionKeySha256: optionalHashedProviderValue(file.headRevisionId),
    mimeTypeSha256: optionalHashedProviderValue(file.mimeType),
    sourceCreatedAt,
    sourceUpdatedAt,
    trashed: file.trashed === true,
    providerContentChecksumSha256: optionalHashedProviderValue(file.md5Checksum),
    providerContentByteLength: optionalProviderValue(file.size) || null,
  });
  return { sourceCreatedAt, sourceUpdatedAt, capturedAt, metadataSha256 };
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
    adapterId: GOOGLE_DRIVE_CANONICAL_ADAPTER_ID,
    adapterVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
    adapterConfigSha256: GOOGLE_DRIVE_CANONICAL_ADAPTER_CONFIG_SHA256,
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

async function prepareMutation(
  sql: CanonicalSourceSyncPrepareMutationContext["sql"],
  page: ClaimedCanonicalSourceSyncPage,
  observed: ObservedDriveItem,
  order: CanonicalSourceSyncPrepareMutationContext["order"],
) {
  const binding = sourceBinding(page);
  const sourceItemId = deriveSourceItemIdV1({
    tenantId: binding.tenantId,
    ownerActorId: binding.ownerActorId,
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    missionId: binding.missionId,
    connectionId: binding.connectionId,
    providerItemKeySha256: observed.manifest.providerItemKeySha256,
  });
  const currentRevisionRows = await sql`
    SELECT current_revision_id
    FROM omni_source_items
    WHERE tenant_id = ${binding.tenantId}
      AND id = ${sourceItemId}
      AND owner_actor_id = ${binding.ownerActorId}
      AND connection_id = ${binding.connectionId}
    LIMIT 2
  `;
  if (currentRevisionRows.length > 1) {
    throw new Error("Drive canonical source identity is not unique.");
  }
  const currentRevisionId = currentRevisionRows[0]?.current_revision_id
    ? String(currentRevisionRows[0].current_revision_id)
    : null;

  if (observed.manifest.operation === "delete") {
    const output = buildSourceAdapterDeleteV1({
      adapterId: GOOGLE_DRIVE_CANONICAL_ADAPTER_ID,
      adapterVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
      adapterConfigSha256: GOOGLE_DRIVE_CANONICAL_ADAPTER_CONFIG_SHA256,
      adapterEventKeySha256: observed.manifest.adapterEventKeySha256,
      observedAt: observed.manifest.observedAt,
      ...binding,
      sourceItemId,
      sourceKind: "file",
      providerItemKeySha256: observed.manifest.providerItemKeySha256,
      lastKnownSourceRevisionId: currentRevisionId,
      deleteReason: observed.manifest.deleteReasonCode === "provider_deleted"
        ? "provider_deleted"
        : "source_missing",
    });
    return { executionScope: page.identity.executionScope, order, output };
  }

  if (!observed.metadata || !observed.manifest.providerRevisionKeySha256) {
    throw new Error("Drive canonical upsert is missing normalized metadata.");
  }
  const extractorIdentity = {
    extractorId: GOOGLE_DRIVE_CANONICAL_EXTRACTOR_ID,
    extractorVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
    extractorConfigSha256: GOOGLE_DRIVE_CANONICAL_ADAPTER_CONFIG_SHA256,
    modelVersionId: null,
  };
  const sourceItem = buildSourceItemV1({
    ...binding,
    sourceKind: "file",
    providerItemKeySha256: observed.manifest.providerItemKeySha256,
    metadataSha256: observed.metadata.metadataSha256,
    sourceCreatedAt: observed.metadata.sourceCreatedAt,
    sourceUpdatedAt: observed.metadata.sourceUpdatedAt,
    capturedAt: observed.metadata.capturedAt,
    extractorIdentity,
  });
  const sourceRevision = buildSourceRevisionV1({
    ...binding,
    sourceItemId: sourceItem.sourceItemId,
    previousSourceRevisionId: currentRevisionId,
    sourceKind: "file",
    providerItemKeySha256: observed.manifest.providerItemKeySha256,
    providerRevisionKeySha256:
      observed.manifest.providerRevisionKeySha256,
    contentSha256: EMPTY_CONTENT_SHA256,
    contentByteLength: 0,
    mediaType: GOOGLE_DRIVE_CANONICAL_MEDIA_TYPE,
    metadataSha256: observed.metadata.metadataSha256,
    sourceCreatedAt: observed.metadata.sourceCreatedAt,
    sourceUpdatedAt: observed.metadata.sourceUpdatedAt,
    capturedAt: observed.metadata.capturedAt,
    extractorIdentity,
  });
  const output = buildSourceAdapterUpsertV1({
    adapterId: GOOGLE_DRIVE_CANONICAL_ADAPTER_ID,
    adapterVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
    adapterConfigSha256: GOOGLE_DRIVE_CANONICAL_ADAPTER_CONFIG_SHA256,
    adapterEventKeySha256: observed.manifest.adapterEventKeySha256,
    observedAt: observed.manifest.observedAt,
    sourceItem,
    sourceRevision,
    evidenceUnits: [],
  });
  return { executionScope: page.identity.executionScope, order, output };
}

function sourceBinding(page: ClaimedSourceSyncPage) {
  return {
    tenantId: page.identity.tenantId,
    ownerActorId: page.identity.ownerActorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    connectionId: page.identity.connectionId,
    visibility: "user_private" as const,
    sensitivity: "confidential" as const,
    permissionGrantIds: [page.identity.connectionId],
    allowedPurposeIds: [GOOGLE_DRIVE_CANONICAL_PURPOSE_ID],
    retentionPolicyId: GOOGLE_DRIVE_CANONICAL_RETENTION_POLICY_ID,
    retentionExpiresAt: null,
  };
}

function canonicalIdentity(
  input: GoogleDriveCanonicalInput,
): SourceSyncStreamIdentity {
  return {
    tenantId: input.tenantId,
    ownerActorId: input.actorId,
    connectionId: input.connectionId,
    provider: "google",
    sourceId: "drive",
    engineVersion: GOOGLE_DRIVE_CANONICAL_ENGINE_VERSION,
    adapterId: GOOGLE_DRIVE_CANONICAL_ADAPTER_ID,
    adapterVersionId: GOOGLE_DRIVE_CANONICAL_ADAPTER_VERSION,
    adapterConfigSha256: GOOGLE_DRIVE_CANONICAL_ADAPTER_CONFIG_SHA256,
    authorizationGeneration: input.authorizationGeneration,
    rolloutGeneration: GOOGLE_DRIVE_CANONICAL_ROLLOUT_GENERATION,
    rolloutCapabilityId: GOOGLE_DRIVE_CANONICAL_CAPABILITY_ID,
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "connector.google.drive.canonical",
      correlationId: `google-drive-canonical:${randomUUID()}`,
      contextGrantIds: [input.connectionId],
      purpose: GOOGLE_DRIVE_CANONICAL_PURPOSE_ID,
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
    body: providerRecord(body),
    ...(responseObservedAt
      ? { responseObservedAt: providerTimestamp(responseObservedAt) }
      : {}),
  };
}

function providerItemKey(externalItemId: string) {
  return sourceContractSha256({ externalItemId });
}

function uniqueObservedItems(items: ObservedDriveItem[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.manifest.adapterEventKeySha256)) return false;
    seen.add(item.manifest.adapterEventKeySha256);
    return true;
  });
}

function pageObservedAt(
  items: ObservedDriveItem[],
  responseObservedAt?: string,
) {
  const latestItemTimestamp = items
    .map((item) => item.manifest.observedAt)
    .sort()
    .at(-1);
  if (latestItemTimestamp) return latestItemTimestamp;
  if (responseObservedAt) return responseObservedAt;
  throw new GoogleDriveProviderError("invalid_provider_response");
}

function latestTimestamp(...values: Array<string | null | undefined>) {
  const timestamps = values.filter((value): value is string => Boolean(value));
  if (!timestamps.length) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return timestamps.sort().at(-1)!;
}

function optionalHashedProviderValue(value: unknown) {
  const normalized = optionalProviderValue(value);
  return normalized ? sourceContractSha256({ value: normalized }) : null;
}

function providerRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return value as Record<string, unknown>;
}

function providerArray(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > DRIVE_PAGE_SIZE) {
    throw new GoogleDriveProviderError("invalid_provider_response");
  }
  return value;
}

function requiredProviderValue(value: unknown) {
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
  return requiredProviderValue(value);
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
  const deadline = AbortSignal.timeout(CANONICAL_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
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

function safeFailureDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") {
    return { name: "UnknownError" };
  }
  const record = error as Record<string, unknown>;
  return {
    name: safeDiagnosticIdentifier(record.name, "UnknownError"),
    ...(safeDiagnosticIdentifier(record.code) ? {
      databaseCode: safeDiagnosticIdentifier(record.code),
    } : {}),
    ...(safeDiagnosticIdentifier(record.constraint) ? {
      constraint: safeDiagnosticIdentifier(record.constraint),
    } : {}),
    ...(safeDiagnosticIdentifier(record.table) ? {
      table: safeDiagnosticIdentifier(record.table),
    } : {}),
    ...(safeDiagnosticIdentifier(record.routine) ? {
      routine: safeDiagnosticIdentifier(record.routine),
    } : {}),
  };
}

function safeDiagnosticIdentifier(value: unknown, fallback?: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:-]{1,120}$/.test(normalized)
    ? normalized
    : fallback;
}

class GoogleDriveProviderError extends Error {
  constructor(readonly code: SourceSyncFailureCode) {
    super("Google Drive canonical provider operation failed.");
    this.name = "GoogleDriveProviderError";
  }
}

class GoogleDriveCanonicalError extends Error {
  constructor(readonly code: SourceSyncFailureCode) {
    super("Google Drive canonical metadata settlement failed.");
    this.name = "GoogleDriveCanonicalError";
  }
}
