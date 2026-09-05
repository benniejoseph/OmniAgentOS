import { createHash, randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  openJsonPayload,
  sealJsonPayload,
  type SealedPayload,
} from "@/lib/security/sealed-payload";
import {
  sourceAdapterOutputV1Schema,
  sourceContractIdSchema,
  sourceContractSha256,
  sourceContractSha256Schema,
  type SourceAdapterOutputV1,
} from "@/lib/sources/contracts";
import {
  applyPreparedCanonicalSourceMutation,
  type CanonicalSourceMutationResult,
  type CanonicalSourceOrder,
  type PreparedCanonicalSourceMutation,
} from "@/lib/sources/convergence-store";
import type { SourceSqlClient } from "@/lib/sources/store";
import { getDataPath } from "@/lib/storage/paths";
import { updateJsonFile } from "@/lib/storage/json";

const SOURCE_SYNC_SCHEMA_VERSION = 1;
const LEASE_DURATION_MS = 60_000;
const MAX_PAGE_ITEMS = 1_000;
const MAX_PAGE_ATTEMPTS = 5;
const MAX_CURSOR_CHARACTERS = 4_000;
const CANONICAL_DRIVE_PURPOSE_ID =
  "connector.google-drive.metadata-settlement";
const CANONICAL_DRIVE_RETENTION_POLICY_ID =
  "retention.connection-lifetime";
const CANONICAL_DRIVE_EXTRACTOR_ID = "google-drive.metadata";
const CANONICAL_DRIVE_MEDIA_TYPE =
  "application/x.asael-source-metadata";
const CANONICAL_DRIVE_EMPTY_CONTENT_SHA256 = createHash("sha256")
  .update("")
  .digest("hex");

export type SourceSyncPhase = "backfill" | "changes";
export type SourceSyncOperation = "upsert" | "delete";
export type SourceSyncFailureCode =
  | "cursor_expired"
  | "invalid_provider_response"
  | "lease_lost"
  | "provider_forbidden"
  | "provider_rate_limited"
  | "provider_unauthorized"
  | "provider_unavailable"
  | "request_aborted"
  | "store_unavailable"
  | "unexpected_failure";

export type SourceSyncStreamIdentity = Readonly<{
  tenantId: string;
  ownerActorId: string;
  connectionId: string;
  provider: "google";
  sourceId: string;
  engineVersion: string;
  adapterVersionId: string;
  adapterConfigSha256: string;
  authorizationGeneration: number;
  rolloutGeneration: number;
  rolloutCapabilityId?: string;
  adapterId?: string;
  executionScope: ExecutionScope;
}>;

export type SourceSyncCanonicalRolloutBinding = Readonly<{
  capabilityId: string;
  contractVersionId: string;
  mode: "canary" | "enabled";
}>;

export type SourceSyncCursor = Readonly<{
  pageToken?: string;
  fenceToken?: string;
}>;

export type SourceSyncPageManifestItem = Readonly<{
  operation: SourceSyncOperation;
  providerItemKeySha256: string;
  providerRevisionKeySha256?: string;
  adapterEventKeySha256: string;
  observedAt: string;
  manifestItemSha256: string;
  deleteReasonCode?: "provider_deleted" | "source_missing";
}>;

export type ClaimedSourceSyncPage = Readonly<{
  checkpointId: string;
  identity: SourceSyncStreamIdentity;
  phase: SourceSyncPhase;
  pageSequence: number;
  requestCursor?: SourceSyncCursor;
  leaseOwnerId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  attempts: number;
  rolloutLifecycleRevision?: number;
}>;

export type ClaimedCanonicalSourceSyncPage = ClaimedSourceSyncPage & Readonly<{
  identity: SourceSyncStreamIdentity & Readonly<{
    rolloutCapabilityId: string;
    adapterId: string;
  }>;
  rolloutLifecycleRevision: number;
}>;

export type SourceSyncPageClaim =
  | { status: "claimed"; page: ClaimedSourceSyncPage }
  | { status: "busy" | "blocked" };

export type CanonicalSourceSyncPageClaim =
  | { status: "claimed"; page: ClaimedCanonicalSourceSyncPage }
  | { status: "busy" | "blocked" };

export type NextSourceSyncPage = Readonly<{
  phase: SourceSyncPhase;
  cursor: SourceSyncCursor;
}>;

export type CanonicalSourceSyncPrepareMutationContext = Readonly<{
  sql: SourceSqlClient;
  page: ClaimedCanonicalSourceSyncPage;
  item: SourceSyncPageManifestItem;
  ordinal: number;
  order: CanonicalSourceOrder;
}>;

export type CanonicalSourceSyncPrepareMutation = (
  context: CanonicalSourceSyncPrepareMutationContext,
) => PreparedCanonicalSourceMutation | Promise<PreparedCanonicalSourceMutation>;

export type CanonicalSourceSyncFailureStage =
  | "lock_stream"
  | "assert_authorization"
  | "assert_rollout"
  | "renew_lease"
  | "persist_manifest"
  | "assert_manifest"
  | "prepare_mutation"
  | "apply_mutation"
  | "settle_item"
  | "commit_checkpoint"
  | "persist_next_checkpoint"
  | "assert_next_checkpoint"
  | "append_settlement_event";

export type SourceSyncDiagnosticStage =
  | "pin_fence"
  | "observe_page"
  | "commit_page"
  | CanonicalSourceSyncFailureStage;

const canonicalSourceSyncFailureStages = new WeakMap<
  object,
  CanonicalSourceSyncFailureStage
>();

export function canonicalSourceSyncFailureStage(error: unknown) {
  return error && typeof error === "object"
    ? canonicalSourceSyncFailureStages.get(error)
    : undefined;
}

type SourceSyncSqlClient = ReturnType<typeof getSql>;

type StoredCheckpoint = {
  id: string;
  schemaVersion: number;
  tenantId: string;
  ownerActorId: string;
  connectionId: string;
  provider: "google";
  sourceId: string;
  engineVersion: string;
  adapterVersionId: string;
  adapterConfigSha256: string;
  authorizationGeneration: number;
  rolloutGeneration: number;
  rolloutCapabilityId?: string;
  adapterId?: string;
  rolloutLifecycleRevision?: number;
  phase: SourceSyncPhase;
  pageSequence: number;
  requestCursorSealed?: SealedPayload;
  requestCursorSha256?: string;
  fenceCursorSha256?: string;
  observedAt?: string;
  manifestSha256?: string;
  itemCount?: number;
  status: "open" | "leased" | "observed" | "committed" | "dead_letter" | "superseded";
  leaseOwnerId?: string;
  leaseExpiresAt?: string;
  leaseGeneration: number;
  attempts: number;
  failureCode?: SourceSyncFailureCode;
  failureSha256?: string;
  committedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type StoredPageItem = SourceSyncPageManifestItem & {
  id: string;
  checkpointId: string;
  tenantId: string;
  ownerActorId: string;
  connectionId: string;
  provider: "google";
  sourceId: string;
  engineVersion: string;
  authorizationGeneration: number;
  rolloutGeneration: number;
  phaseRank: number;
  pageSequence: number;
  ordinal: number;
  outcome: "shadow_observed";
  attempts: number;
  createdAt: string;
  updatedAt: string;
};

type PendingCanonicalPageItem = Omit<StoredPageItem, "outcome"> & {
  outcome: "pending";
};

type SourceSyncLedger = {
  checkpoints: StoredCheckpoint[];
  items: StoredPageItem[];
};

const sourceSyncFile = () => getDataPath("source-sync-checkpoints.json");

export async function claimSourceSyncPage(
  identityInput: SourceSyncStreamIdentity,
): Promise<SourceSyncPageClaim> {
  const identity = validatedIdentity(identityInput);
  assertLegacySourceSyncGeneration(identity);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(
      identity.tenantId,
      () => claimSourceSyncPageDb(identity),
    );
  }
  return claimSourceSyncPageFile(identity);
}

export async function claimCanonicalSourceSyncPage(
  identityInput: SourceSyncStreamIdentity,
  rolloutBindingInput: SourceSyncCanonicalRolloutBinding,
): Promise<CanonicalSourceSyncPageClaim> {
  const identity = canonicalIdentity(identityInput);
  const rolloutBinding = validatedCanonicalRolloutBinding(
    rolloutBindingInput,
    identity,
  );
  requireCanonicalPostgres();
  await ensureDatabaseSchema();
  const claim = await runWithDatabaseTenantScope(
    identity.tenantId,
    () => claimSourceSyncPageDb(identity, rolloutBinding),
  );
  if (claim.status !== "claimed") return claim;
  return {
    status: "claimed",
    page: validatedCanonicalClaim(
      claim.page as ClaimedCanonicalSourceSyncPage,
    ),
  };
}

export async function pinSourceSyncBackfillFence(
  page: ClaimedSourceSyncPage,
  fenceTokenInput: string,
): Promise<ClaimedSourceSyncPage> {
  assertLegacySourceSyncGeneration(page.identity);
  if (page.phase !== "backfill") {
    throw new SourceSyncLeaseError("Only a backfill page can pin a start-page fence.");
  }
  const fenceToken = boundedCursor(fenceTokenInput, "Drive start-page token");
  const cursor = validatedCursor({
    pageToken: page.requestCursor?.pageToken,
    fenceToken,
  });
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(
      page.identity.tenantId,
      () => pinSourceSyncBackfillFenceDb(page, cursor),
    );
  }
  return pinSourceSyncBackfillFenceFile(page, cursor);
}

export async function pinCanonicalSourceSyncBackfillFence(
  pageInput: ClaimedCanonicalSourceSyncPage,
  fenceTokenInput: string,
  rolloutBindingInput: SourceSyncCanonicalRolloutBinding,
): Promise<ClaimedCanonicalSourceSyncPage> {
  const page = validatedCanonicalClaim(pageInput);
  const rolloutBinding = validatedCanonicalRolloutBinding(
    rolloutBindingInput,
    page.identity,
  );
  if (page.phase !== "backfill") {
    throw new SourceSyncLeaseError(
      "Only a backfill page can pin a start-page fence.",
    );
  }
  const fenceToken = boundedCursor(fenceTokenInput, "Drive start-page token");
  const cursor = validatedCursor({
    pageToken: page.requestCursor?.pageToken,
    fenceToken,
  });
  requireCanonicalPostgres();
  await ensureDatabaseSchema();
  return runWithDatabaseTenantScope(
    page.identity.tenantId,
    () => pinCanonicalSourceSyncBackfillFenceDb(
      page,
      cursor,
      rolloutBinding,
    ),
  );
}

export async function commitSourceSyncPage(input: {
  page: ClaimedSourceSyncPage;
  items: readonly SourceSyncPageManifestItem[];
  next: NextSourceSyncPage;
  observedAt: string;
}) {
  const page = validatedClaim(input.page);
  assertLegacySourceSyncGeneration(page.identity);
  if (!page.requestCursor?.fenceToken) {
    throw new Error("Source sync pages must retain their pinned change fence.");
  }
  const items = validatedManifest(input.items);
  const next = validatedNextPage(input.next);
  const manifestSha256 = sourceContractSha256(
    items.map((item, ordinal) => ({ ordinal, ...item })),
  );
  const observedAt = canonicalSourceSyncTimestamp(input.observedAt);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(
      page.identity.tenantId,
      () => commitSourceSyncPageDb({
        page,
        items,
        next,
        manifestSha256,
        observedAt,
      }),
    );
  }
  return commitSourceSyncPageFile({
    page,
    items,
    next,
    manifestSha256,
    observedAt,
  });
}

export async function commitCanonicalSourceSyncPage(input: {
  page: ClaimedCanonicalSourceSyncPage;
  rolloutBinding: SourceSyncCanonicalRolloutBinding;
  items: readonly SourceSyncPageManifestItem[];
  next: NextSourceSyncPage;
  observedAt: string;
  prepareMutation: CanonicalSourceSyncPrepareMutation;
}) {
  const page = validatedCanonicalClaim(input.page);
  const rolloutBinding = validatedCanonicalRolloutBinding(
    input.rolloutBinding,
    page.identity,
  );
  if (!page.requestCursor?.fenceToken) {
    throw new Error("Source sync pages must retain their pinned change fence.");
  }
  if (typeof input.prepareMutation !== "function") {
    throw new Error("Canonical source sync requires a mutation preparer.");
  }
  const items = validatedManifest(input.items);
  const next = validatedNextPage(input.next);
  const manifestSha256 = sourceContractSha256(
    items.map((item, ordinal) => ({ ordinal, ...item })),
  );
  const observedAt = canonicalSourceSyncTimestamp(input.observedAt);

  requireCanonicalPostgres();
  await ensureDatabaseSchema();
  return runWithDatabaseTenantScope(
    page.identity.tenantId,
    () => commitCanonicalSourceSyncPageDb({
      page,
      rolloutBinding,
      items,
      next,
      manifestSha256,
      observedAt,
      prepareMutation: input.prepareMutation,
    }),
  );
}

export async function failSourceSyncPage(input: {
  page: ClaimedSourceSyncPage;
  code: SourceSyncFailureCode;
  failureSha256: string;
  diagnosticStage?: SourceSyncDiagnosticStage;
}) {
  const page = validatedClaim(input.page);
  const code = sourceSyncFailureCode(input.code);
  const failureSha256 = sourceContractSha256Schema.parse(input.failureSha256);
  const diagnosticStage = input.diagnosticStage;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(
      page.identity.tenantId,
      () => failSourceSyncPageDb({ page, code, failureSha256, diagnosticStage }),
    );
  }
  assertLegacySourceSyncGeneration(page.identity);
  return failSourceSyncPageFile({ page, code, failureSha256 });
}

export function sourceSyncFailureSha256(error: unknown) {
  return sourceContractSha256({
    name: error instanceof Error ? error.name.slice(0, 120) : "unknown",
    message: error instanceof Error
      ? error.message.slice(0, 2_000)
      : String(error).slice(0, 2_000),
  });
}

async function claimSourceSyncPageDb(
  identity: SourceSyncStreamIdentity,
  canonicalRollout?: SourceSyncCanonicalRolloutBinding,
): Promise<SourceSyncPageClaim> {
  return await getSql().transaction(async (sql: SourceSyncSqlClient) => {
    await lockStream(sql, identity);
    await assertCurrentAuthorization(sql, identity);
    const rolloutLifecycleRevision = canonicalRollout
      ? await assertActiveCanonicalRollout(sql, identity, canonicalRollout)
      : undefined;
    let rows = await sql`
      SELECT *
      FROM omni_source_sync_page_checkpoints
      WHERE tenant_id = ${identity.tenantId}
        AND owner_actor_id = ${identity.ownerActorId}
        AND connection_id = ${identity.connectionId}
        AND provider = ${identity.provider}
        AND source_id = ${identity.sourceId}
        AND engine_version = ${identity.engineVersion}
        AND adapter_version_id = ${identity.adapterVersionId}
        AND adapter_config_sha256 = ${identity.adapterConfigSha256}
        AND authorization_generation = ${identity.authorizationGeneration}
        AND rollout_generation = ${identity.rolloutGeneration}
        AND rollout_capability_id IS NOT DISTINCT FROM
          ${identity.rolloutCapabilityId || null}
        AND adapter_id IS NOT DISTINCT FROM ${identity.adapterId || null}
        AND (
          status = 'open'
          OR (
            status = 'leased'
            AND lease_expires_at <= clock_timestamp()
          )
        )
      ORDER BY page_sequence ASC
      LIMIT 1
      FOR UPDATE
    `;

    if (!rows.length) {
      const latest = await sql`
        SELECT status
        FROM omni_source_sync_page_checkpoints
        WHERE tenant_id = ${identity.tenantId}
          AND owner_actor_id = ${identity.ownerActorId}
          AND connection_id = ${identity.connectionId}
          AND provider = ${identity.provider}
          AND source_id = ${identity.sourceId}
          AND engine_version = ${identity.engineVersion}
          AND adapter_version_id = ${identity.adapterVersionId}
          AND adapter_config_sha256 = ${identity.adapterConfigSha256}
          AND authorization_generation = ${identity.authorizationGeneration}
          AND rollout_generation = ${identity.rolloutGeneration}
          AND rollout_capability_id IS NOT DISTINCT FROM
            ${identity.rolloutCapabilityId || null}
          AND adapter_id IS NOT DISTINCT FROM ${identity.adapterId || null}
        ORDER BY page_sequence DESC
        LIMIT 1
      `;
      if (!latest.length) {
        const initial = initialCheckpoint(
          identity,
          await databaseTimestamp(sql),
        );
        await insertCheckpointDb(sql, initial);
        rows = await sql`
          SELECT *
          FROM omni_source_sync_page_checkpoints
          WHERE tenant_id = ${identity.tenantId}
            AND id = ${initial.id}
            AND owner_actor_id = ${identity.ownerActorId}
            AND connection_id = ${identity.connectionId}
            AND provider = ${identity.provider}
            AND source_id = ${identity.sourceId}
            AND authorization_generation = ${identity.authorizationGeneration}
            AND rollout_generation = ${identity.rolloutGeneration}
          LIMIT 1
          FOR UPDATE
        `;
      } else {
        return {
          status: latest[0].status === "dead_letter" ? "blocked" : "busy",
        };
      }
    }

    const checkpoint = checkpointFromRow(rows[0], identity);
    if (checkpoint.attempts >= MAX_PAGE_ATTEMPTS) {
      const failureSha256 = sourceContractSha256({ reason: "attempt_limit" });
      const exhaustedPage = checkpoint.status === "leased"
        ? claimFromCheckpoint(checkpoint, identity)
        : undefined;
      if (canonicalRollout) {
        await sql`
          UPDATE omni_source_sync_page_checkpoints
          SET status = 'dead_letter',
              lease_owner_id = NULL,
              lease_expires_at = NULL,
              rollout_lifecycle_revision = COALESCE(
                rollout_lifecycle_revision,
                ${rolloutLifecycleRevision!}
              ),
              failure_code = 'unexpected_failure',
              failure_sha256 = ${failureSha256},
              updated_at = clock_timestamp()
          WHERE tenant_id = ${identity.tenantId}
            AND id = ${checkpoint.id}
            AND owner_actor_id = ${identity.ownerActorId}
            AND connection_id = ${identity.connectionId}
            AND provider = ${identity.provider}
            AND source_id = ${identity.sourceId}
            AND authorization_generation = ${identity.authorizationGeneration}
            AND rollout_generation = ${identity.rolloutGeneration}
            AND rollout_capability_id = ${canonicalRollout.capabilityId}
            AND adapter_id = ${identity.adapterId!}
        `;
      } else {
        await sql`
          UPDATE omni_source_sync_page_checkpoints
          SET status = 'dead_letter',
              lease_owner_id = NULL,
              lease_expires_at = NULL,
              failure_code = 'unexpected_failure',
              failure_sha256 = ${failureSha256},
              updated_at = clock_timestamp()
          WHERE tenant_id = ${identity.tenantId}
            AND id = ${checkpoint.id}
            AND owner_actor_id = ${identity.ownerActorId}
            AND connection_id = ${identity.connectionId}
            AND provider = ${identity.provider}
            AND source_id = ${identity.sourceId}
            AND authorization_generation = ${identity.authorizationGeneration}
            AND rollout_generation = ${identity.rolloutGeneration}
        `;
      }
      if (exhaustedPage) {
        await appendFailureEvent(
          sql,
          exhaustedPage,
          "unexpected_failure",
          failureSha256,
          "dead_letter",
        );
      }
      return { status: "blocked" };
    }

    const leaseOwnerId = randomUUID();
    const claimed = canonicalRollout
      ? await sql`
        UPDATE omni_source_sync_page_checkpoints
        SET status = 'leased',
            lease_owner_id = ${leaseOwnerId},
            lease_expires_at =
              clock_timestamp() + INTERVAL '60 seconds',
            lease_generation = lease_generation + 1,
            attempts = attempts + 1,
            rollout_lifecycle_revision = ${rolloutLifecycleRevision!},
            failure_code = NULL,
            failure_sha256 = NULL,
            updated_at = clock_timestamp()
        WHERE tenant_id = ${identity.tenantId}
          AND id = ${checkpoint.id}
          AND owner_actor_id = ${identity.ownerActorId}
          AND connection_id = ${identity.connectionId}
          AND provider = ${identity.provider}
          AND source_id = ${identity.sourceId}
          AND authorization_generation = ${identity.authorizationGeneration}
          AND rollout_generation = ${identity.rolloutGeneration}
          AND rollout_capability_id = ${canonicalRollout.capabilityId}
          AND adapter_id = ${identity.adapterId!}
          AND (
            status = 'open'
            OR (
              status = 'leased'
              AND lease_expires_at <= clock_timestamp()
            )
          )
        RETURNING *
      `
      : await sql`
        UPDATE omni_source_sync_page_checkpoints
        SET status = 'leased',
            lease_owner_id = ${leaseOwnerId},
            lease_expires_at =
              clock_timestamp() + INTERVAL '60 seconds',
            lease_generation = lease_generation + 1,
            attempts = attempts + 1,
            failure_code = NULL,
            failure_sha256 = NULL,
            updated_at = clock_timestamp()
        WHERE tenant_id = ${identity.tenantId}
          AND id = ${checkpoint.id}
          AND owner_actor_id = ${identity.ownerActorId}
          AND connection_id = ${identity.connectionId}
          AND provider = ${identity.provider}
          AND source_id = ${identity.sourceId}
          AND authorization_generation = ${identity.authorizationGeneration}
          AND rollout_generation = ${identity.rolloutGeneration}
          AND (
            status = 'open'
            OR (
              status = 'leased'
              AND lease_expires_at <= clock_timestamp()
            )
          )
        RETURNING *
      `;
    if (claimed.length !== 1) return { status: "busy" };
    const claimedCheckpoint = checkpointFromRow(claimed[0], identity);
    return {
      status: "claimed",
      page: canonicalRollout
        ? canonicalClaimFromCheckpoint(claimedCheckpoint, identity)
        : claimFromCheckpoint(claimedCheckpoint, identity),
    };
  }) as SourceSyncPageClaim;
}

async function pinSourceSyncBackfillFenceDb(
  page: ClaimedSourceSyncPage,
  cursor: SourceSyncCursor,
) {
  const sealed = sealCursor(page.checkpointId, page.identity, cursor);
  const rows = await getSql()`
    UPDATE omni_source_sync_page_checkpoints
    SET request_cursor_sealed = ${sealed}::jsonb,
        request_cursor_sha256 = ${requestCursorHash(cursor)},
        fence_cursor_sha256 = ${cursor.fenceToken ? cursorHash(cursor.fenceToken) : null},
        updated_at = clock_timestamp()
    WHERE tenant_id = ${page.identity.tenantId}
      AND id = ${page.checkpointId}
      AND owner_actor_id = ${page.identity.ownerActorId}
      AND connection_id = ${page.identity.connectionId}
      AND provider = ${page.identity.provider}
      AND source_id = ${page.identity.sourceId}
      AND authorization_generation = ${page.identity.authorizationGeneration}
      AND rollout_generation = ${page.identity.rolloutGeneration}
      AND status = 'leased'
      AND lease_owner_id = ${page.leaseOwnerId}
      AND lease_generation = ${page.leaseGeneration}
      AND lease_expires_at > clock_timestamp()
    RETURNING *
  `;
  if (rows.length !== 1) throw new SourceSyncLeaseError();
  return claimFromCheckpoint(
    checkpointFromRow(rows[0], page.identity),
    page.identity,
  );
}

async function pinCanonicalSourceSyncBackfillFenceDb(
  page: ClaimedCanonicalSourceSyncPage,
  cursor: SourceSyncCursor,
  rolloutBinding: SourceSyncCanonicalRolloutBinding,
): Promise<ClaimedCanonicalSourceSyncPage> {
  const sealed = sealCursor(page.checkpointId, page.identity, cursor);
  const pinned = await getSql().transaction(async (sql: SourceSyncSqlClient) => {
    await lockStream(sql, page.identity);
    await assertCurrentAuthorization(sql, page.identity);
    await assertActiveCanonicalRollout(
      sql,
      page.identity,
      rolloutBinding,
      page.rolloutLifecycleRevision,
    );
    const rows = await sql`
      UPDATE omni_source_sync_page_checkpoints
      SET request_cursor_sealed = ${sealed}::jsonb,
          request_cursor_sha256 = ${requestCursorHash(cursor)},
          fence_cursor_sha256 = ${cursor.fenceToken ? cursorHash(cursor.fenceToken) : null},
          lease_expires_at = clock_timestamp() + INTERVAL '5 minutes',
          updated_at = clock_timestamp()
      WHERE tenant_id = ${page.identity.tenantId}
        AND id = ${page.checkpointId}
        AND owner_actor_id = ${page.identity.ownerActorId}
        AND connection_id = ${page.identity.connectionId}
        AND provider = ${page.identity.provider}
        AND source_id = ${page.identity.sourceId}
        AND authorization_generation = ${page.identity.authorizationGeneration}
        AND rollout_generation = ${page.identity.rolloutGeneration}
        AND rollout_capability_id = ${rolloutBinding.capabilityId}
        AND adapter_id = ${page.identity.adapterId}
        AND rollout_lifecycle_revision = ${page.rolloutLifecycleRevision}
        AND status = 'leased'
        AND lease_owner_id = ${page.leaseOwnerId}
        AND lease_generation = ${page.leaseGeneration}
        AND lease_expires_at > clock_timestamp()
      RETURNING *
    `;
    if (rows.length !== 1) throw new SourceSyncLeaseError();
    return canonicalClaimFromCheckpoint(
      checkpointFromRow(rows[0], page.identity),
      page.identity,
    );
  });
  return validatedCanonicalClaim(
    pinned as ClaimedCanonicalSourceSyncPage,
  );
}

async function commitSourceSyncPageDb(input: {
  page: ClaimedSourceSyncPage;
  items: SourceSyncPageManifestItem[];
  next: NextSourceSyncPage;
  manifestSha256: string;
  observedAt: string;
}) {
  const { page, items, next, manifestSha256, observedAt } = input;
  return await getSql().transaction(async (sql: SourceSyncSqlClient) => {
    await lockStream(sql, page.identity);
    await assertCurrentAuthorization(sql, page.identity);
    const active = await sql`
      SELECT *
      FROM omni_source_sync_page_checkpoints
      WHERE tenant_id = ${page.identity.tenantId}
        AND id = ${page.checkpointId}
        AND owner_actor_id = ${page.identity.ownerActorId}
        AND connection_id = ${page.identity.connectionId}
        AND provider = ${page.identity.provider}
        AND source_id = ${page.identity.sourceId}
        AND authorization_generation = ${page.identity.authorizationGeneration}
        AND rollout_generation = ${page.identity.rolloutGeneration}
        AND status = 'leased'
        AND lease_owner_id = ${page.leaseOwnerId}
        AND lease_generation = ${page.leaseGeneration}
        AND lease_expires_at > clock_timestamp()
      LIMIT 1
      FOR UPDATE
    `;
    if (active.length !== 1) throw new SourceSyncLeaseError();
    assertStoredClaim(checkpointFromRow(active[0], page.identity), page);

    const now = await databaseTimestamp(sql);
    const storedItems = pageItems(page, items, now);
    if (storedItems.length) {
      await sql`
        INSERT INTO omni_source_sync_page_items (
          id, schema_version, tenant_id, checkpoint_id, owner_actor_id,
          connection_id, provider, source_id, engine_version,
          authorization_generation, rollout_generation, phase_rank,
          page_sequence, ordinal, operation, provider_item_key_sha256,
          provider_revision_key_sha256, adapter_event_key_sha256, observed_at,
          manifest_item_sha256, outcome, source_item_id, source_revision_id,
          adapter_output_id, adapter_output_sha256, delete_reason_code,
          last_known_revision_id, attempts, error_code, error_sha256,
          next_retry_at, applied_at, created_at, updated_at
        )
        SELECT
          id, schema_version, tenant_id, checkpoint_id, owner_actor_id,
          connection_id, provider, source_id, engine_version,
          authorization_generation, rollout_generation, phase_rank,
          page_sequence, ordinal, operation, provider_item_key_sha256,
          provider_revision_key_sha256, adapter_event_key_sha256, observed_at,
          manifest_item_sha256, outcome, source_item_id, source_revision_id,
          adapter_output_id, adapter_output_sha256, delete_reason_code,
          last_known_revision_id, attempts, error_code, error_sha256,
          next_retry_at, applied_at, created_at, updated_at
        FROM jsonb_to_recordset(${dbPageItems(storedItems)}::jsonb) AS item(
          id text, schema_version integer, tenant_id text, checkpoint_id text,
          owner_actor_id text, connection_id text, provider text,
          source_id text, engine_version text, authorization_generation bigint,
          rollout_generation bigint, phase_rank integer, page_sequence bigint,
          ordinal integer, operation text, provider_item_key_sha256 text,
          provider_revision_key_sha256 text, adapter_event_key_sha256 text,
          observed_at timestamptz, manifest_item_sha256 text, outcome text,
          source_item_id text, source_revision_id text, adapter_output_id text,
          adapter_output_sha256 text, delete_reason_code text,
          last_known_revision_id text, attempts integer, error_code text,
          error_sha256 text, next_retry_at timestamptz, applied_at timestamptz,
          created_at timestamptz, updated_at timestamptz
        )
        ON CONFLICT (id) DO NOTHING
      `;
      await assertStoredPageItems(sql, page, storedItems);
    }

    const committed = await sql`
      UPDATE omni_source_sync_page_checkpoints
      SET observed_at = ${observedAt},
          manifest_sha256 = ${manifestSha256},
          item_count = ${items.length},
          status = 'committed',
          lease_owner_id = NULL,
          lease_expires_at = NULL,
          failure_code = NULL,
          failure_sha256 = NULL,
          committed_at = ${now},
          updated_at = ${now}
      WHERE tenant_id = ${page.identity.tenantId}
        AND id = ${page.checkpointId}
        AND owner_actor_id = ${page.identity.ownerActorId}
        AND connection_id = ${page.identity.connectionId}
        AND provider = ${page.identity.provider}
        AND source_id = ${page.identity.sourceId}
        AND authorization_generation = ${page.identity.authorizationGeneration}
        AND rollout_generation = ${page.identity.rolloutGeneration}
        AND status = 'leased'
        AND lease_owner_id = ${page.leaseOwnerId}
        AND lease_generation = ${page.leaseGeneration}
        AND lease_expires_at > clock_timestamp()
      RETURNING id
    `;
    if (committed.length !== 1) throw new SourceSyncLeaseError();

    const nextCheckpoint = checkpointForNextPage(page, next, now);
    await insertCheckpointDb(sql, nextCheckpoint);
    await assertNextCheckpoint(sql, nextCheckpoint, page.identity);
    await appendPageObservedEvent(sql, page, items, manifestSha256);
    return {
      status: "shadow_observed" as const,
      checkpointId: page.checkpointId,
      manifestSha256,
      itemCount: items.length,
    };
  });
}

async function commitCanonicalSourceSyncPageDb(input: {
  page: ClaimedCanonicalSourceSyncPage;
  rolloutBinding: SourceSyncCanonicalRolloutBinding;
  items: SourceSyncPageManifestItem[];
  next: NextSourceSyncPage;
  manifestSha256: string;
  observedAt: string;
  prepareMutation: CanonicalSourceSyncPrepareMutation;
}) {
  const {
    page,
    rolloutBinding,
    items,
    next,
    manifestSha256,
    observedAt,
    prepareMutation,
  } = input;
  let stage: CanonicalSourceSyncFailureStage = "lock_stream";
  try {
    return await getSql().transaction(async (sql: SourceSyncSqlClient) => {
      await lockStream(sql, page.identity);
      stage = "assert_authorization";
      await assertCurrentAuthorization(sql, page.identity);
      stage = "assert_rollout";
      await assertActiveCanonicalRollout(
        sql,
        page.identity,
        rolloutBinding,
        page.rolloutLifecycleRevision,
      );

      stage = "renew_lease";
      const active = await sql`
      UPDATE omni_source_sync_page_checkpoints
      SET lease_expires_at = clock_timestamp() + INTERVAL '5 minutes',
          updated_at = clock_timestamp()
      WHERE tenant_id = ${page.identity.tenantId}
        AND id = ${page.checkpointId}
        AND owner_actor_id = ${page.identity.ownerActorId}
        AND connection_id = ${page.identity.connectionId}
        AND provider = ${page.identity.provider}
        AND source_id = ${page.identity.sourceId}
        AND engine_version = ${page.identity.engineVersion}
        AND adapter_version_id = ${page.identity.adapterVersionId}
        AND adapter_config_sha256 = ${page.identity.adapterConfigSha256}
        AND authorization_generation = ${page.identity.authorizationGeneration}
        AND rollout_generation = ${page.identity.rolloutGeneration}
        AND rollout_capability_id = ${rolloutBinding.capabilityId}
        AND adapter_id = ${page.identity.adapterId}
        AND rollout_lifecycle_revision = ${page.rolloutLifecycleRevision}
        AND status = 'leased'
        AND lease_owner_id = ${page.leaseOwnerId}
        AND lease_generation = ${page.leaseGeneration}
        AND lease_expires_at > clock_timestamp()
      RETURNING *
    `;
      if (active.length !== 1) throw new SourceSyncLeaseError();
      const checkpoint = checkpointFromRow(active[0], page.identity);
      assertStoredClaim(checkpoint, page);
      const renewedPage = canonicalClaimFromCheckpoint(checkpoint, page.identity);

      const now = await databaseTimestamp(sql);
      const pendingItems = canonicalPendingPageItems(page, items, now);
      if (pendingItems.length) {
        stage = "persist_manifest";
        await insertCanonicalPendingPageItems(sql, pendingItems);
        stage = "assert_manifest";
        await assertStoredCanonicalPageItems(sql, page, pendingItems, "pending");
      }

      const results: CanonicalSourceMutationResult[] = [];
      for (const [ordinal, item] of items.entries()) {
        const order = canonicalSourceOrder(page, ordinal);
        stage = "prepare_mutation";
        const prepared = validatedPreparedCanonicalMutation(
          await prepareMutation(Object.freeze({
            sql,
            page: renewedPage,
            item,
            ordinal,
            order,
          })),
          page,
          item,
          order,
        );
        stage = "apply_mutation";
        const result = await applyPreparedCanonicalSourceMutation(sql, prepared);
        stage = "settle_item";
        await settleCanonicalPageItem(
          sql,
          pendingItems[ordinal],
          prepared.output,
          result,
          now,
        );
        results.push(result);
      }

      stage = "commit_checkpoint";
      const committed = await sql`
      UPDATE omni_source_sync_page_checkpoints
      SET observed_at = ${observedAt},
          manifest_sha256 = ${manifestSha256},
          item_count = ${items.length},
          status = 'committed',
          lease_owner_id = NULL,
          lease_expires_at = NULL,
          failure_code = NULL,
          failure_sha256 = NULL,
          committed_at = ${now},
          updated_at = ${now}
      WHERE tenant_id = ${page.identity.tenantId}
        AND id = ${page.checkpointId}
        AND owner_actor_id = ${page.identity.ownerActorId}
        AND connection_id = ${page.identity.connectionId}
        AND provider = ${page.identity.provider}
        AND source_id = ${page.identity.sourceId}
        AND engine_version = ${page.identity.engineVersion}
        AND adapter_version_id = ${page.identity.adapterVersionId}
        AND adapter_config_sha256 = ${page.identity.adapterConfigSha256}
        AND authorization_generation = ${page.identity.authorizationGeneration}
        AND rollout_generation = ${page.identity.rolloutGeneration}
        AND rollout_capability_id = ${rolloutBinding.capabilityId}
        AND adapter_id = ${page.identity.adapterId}
        AND rollout_lifecycle_revision = ${page.rolloutLifecycleRevision}
        AND status = 'leased'
        AND lease_owner_id = ${page.leaseOwnerId}
        AND lease_generation = ${page.leaseGeneration}
        AND lease_expires_at > clock_timestamp()
      RETURNING id
    `;
      if (committed.length !== 1) throw new SourceSyncLeaseError();

      const nextCheckpoint = checkpointForNextPage(page, next, now);
      stage = "persist_next_checkpoint";
      await insertCheckpointDb(sql, nextCheckpoint);
      stage = "assert_next_checkpoint";
      await assertNextCheckpoint(sql, nextCheckpoint, page.identity);
      stage = "append_settlement_event";
      await appendCanonicalPageSettledEvent(
        sql,
        page,
        rolloutBinding,
        items,
        results,
        manifestSha256,
      );
      return canonicalPageCommitResult(
        page,
        items.length,
        results,
        manifestSha256,
      );
    });
  } catch (error) {
    if (error && typeof error === "object") {
      canonicalSourceSyncFailureStages.set(error, stage);
    }
    throw error;
  }
}

async function failSourceSyncPageDb(input: {
  page: ClaimedSourceSyncPage;
  code: SourceSyncFailureCode;
  failureSha256: string;
  diagnosticStage?: SourceSyncDiagnosticStage;
}) {
  const { page, code, failureSha256, diagnosticStage } = input;
  return await getSql().transaction(async (sql: SourceSyncSqlClient) => {
    await lockStream(sql, page.identity);
    const status = page.attempts >= MAX_PAGE_ATTEMPTS
      ? "dead_letter"
      : "open";
    const rows = isCanonicalIdentity(page.identity)
      ? await sql`
        UPDATE omni_source_sync_page_checkpoints
        SET status = ${status},
            lease_owner_id = NULL,
            lease_expires_at = NULL,
            rollout_lifecycle_revision = CASE
              WHEN ${status} = 'open' THEN NULL
              ELSE rollout_lifecycle_revision
            END,
            failure_code = ${code},
            failure_sha256 = ${failureSha256},
            updated_at = clock_timestamp()
        WHERE tenant_id = ${page.identity.tenantId}
          AND id = ${page.checkpointId}
          AND owner_actor_id = ${page.identity.ownerActorId}
          AND connection_id = ${page.identity.connectionId}
          AND provider = ${page.identity.provider}
          AND source_id = ${page.identity.sourceId}
          AND authorization_generation = ${page.identity.authorizationGeneration}
          AND rollout_generation = ${page.identity.rolloutGeneration}
          AND rollout_capability_id = ${page.identity.rolloutCapabilityId}
          AND adapter_id = ${page.identity.adapterId}
          AND rollout_lifecycle_revision = ${page.rolloutLifecycleRevision!}
          AND status = 'leased'
          AND lease_owner_id = ${page.leaseOwnerId}
          AND lease_generation = ${page.leaseGeneration}
          AND lease_expires_at > clock_timestamp()
        RETURNING id
      `
      : await sql`
        UPDATE omni_source_sync_page_checkpoints
        SET status = ${status},
            lease_owner_id = NULL,
            lease_expires_at = NULL,
            failure_code = ${code},
            failure_sha256 = ${failureSha256},
            updated_at = clock_timestamp()
        WHERE tenant_id = ${page.identity.tenantId}
          AND id = ${page.checkpointId}
          AND owner_actor_id = ${page.identity.ownerActorId}
          AND connection_id = ${page.identity.connectionId}
          AND provider = ${page.identity.provider}
          AND source_id = ${page.identity.sourceId}
          AND authorization_generation = ${page.identity.authorizationGeneration}
          AND rollout_generation = ${page.identity.rolloutGeneration}
          AND status = 'leased'
          AND lease_owner_id = ${page.leaseOwnerId}
          AND lease_generation = ${page.leaseGeneration}
          AND lease_expires_at > clock_timestamp()
        RETURNING id
      `;
    if (rows.length !== 1) return { status: "lease_lost" as const };
    await appendFailureEvent(
      sql,
      page,
      code,
      failureSha256,
      status,
      diagnosticStage,
    );
    return { status };
  });
}

async function claimSourceSyncPageFile(
  identity: SourceSyncStreamIdentity,
): Promise<SourceSyncPageClaim> {
  let result: SourceSyncPageClaim = { status: "busy" };
  let exhaustedPage: ClaimedSourceSyncPage | undefined;
  let exhaustedFailureSha256: string | undefined;
  await updateJsonFile<SourceSyncLedger>(
    sourceSyncFile(),
    { checkpoints: [], items: [] },
    (ledger) => {
      const now = new Date();
      let checkpoint = ledger.checkpoints
        .filter((candidate) => sameStream(candidate, identity))
        .filter((candidate) =>
          candidate.status === "open" ||
          (
            candidate.status === "leased" &&
            Boolean(candidate.leaseExpiresAt) &&
            Date.parse(candidate.leaseExpiresAt!) <= now.getTime()
          )
        )
        .sort((left, right) => left.pageSequence - right.pageSequence)[0];
      if (!checkpoint) {
        const latest = ledger.checkpoints
          .filter((candidate) => sameStream(candidate, identity))
          .sort((left, right) => right.pageSequence - left.pageSequence)[0];
        if (latest) {
          result = {
            status: latest.status === "dead_letter" ? "blocked" : "busy",
          };
          return ledger;
        }
        checkpoint = initialCheckpoint(identity);
        ledger.checkpoints.push(checkpoint);
      }
      if (checkpoint.attempts >= MAX_PAGE_ATTEMPTS) {
        if (checkpoint.status === "leased") {
          exhaustedPage = claimFromCheckpoint(checkpoint, identity);
        }
        exhaustedFailureSha256 = sourceContractSha256({
          reason: "attempt_limit",
        });
        checkpoint.status = "dead_letter";
        checkpoint.leaseOwnerId = undefined;
        checkpoint.leaseExpiresAt = undefined;
        checkpoint.failureCode = "unexpected_failure";
        checkpoint.failureSha256 = exhaustedFailureSha256;
        checkpoint.updatedAt = now.toISOString();
        result = { status: "blocked" };
        return ledger;
      }
      checkpoint.status = "leased";
      checkpoint.leaseOwnerId = randomUUID();
      checkpoint.leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS).toISOString();
      checkpoint.leaseGeneration += 1;
      checkpoint.attempts += 1;
      checkpoint.failureCode = undefined;
      checkpoint.failureSha256 = undefined;
      checkpoint.updatedAt = now.toISOString();
      result = {
        status: "claimed",
        page: claimFromCheckpoint(checkpoint, identity),
      };
      return ledger;
    },
  );
  if (exhaustedPage && exhaustedFailureSha256) {
    await appendFailureEvent(
      undefined,
      exhaustedPage,
      "unexpected_failure",
      exhaustedFailureSha256,
      "dead_letter",
    ).catch(() => undefined);
  }
  return result;
}

async function pinSourceSyncBackfillFenceFile(
  page: ClaimedSourceSyncPage,
  cursor: SourceSyncCursor,
) {
  let updated: ClaimedSourceSyncPage | undefined;
  await updateJsonFile<SourceSyncLedger>(
    sourceSyncFile(),
    { checkpoints: [], items: [] },
    (ledger) => {
      const checkpoint = ledger.checkpoints.find((candidate) =>
        matchesClaim(candidate, page)
      );
      if (!checkpoint || leaseExpired(checkpoint)) {
        throw new SourceSyncLeaseError();
      }
      checkpoint.requestCursorSealed = sealCursor(
        checkpoint.id,
        page.identity,
        cursor,
      );
      checkpoint.requestCursorSha256 = requestCursorHash(cursor);
      checkpoint.fenceCursorSha256 = cursor.fenceToken
        ? cursorHash(cursor.fenceToken)
        : undefined;
      checkpoint.updatedAt = new Date().toISOString();
      updated = claimFromCheckpoint(checkpoint, page.identity);
      return ledger;
    },
  );
  if (!updated) throw new SourceSyncLeaseError();
  return updated;
}

async function commitSourceSyncPageFile(input: {
  page: ClaimedSourceSyncPage;
  items: SourceSyncPageManifestItem[];
  next: NextSourceSyncPage;
  manifestSha256: string;
  observedAt: string;
}) {
  const { page, items, next, manifestSha256, observedAt } = input;
  const now = new Date().toISOString();
  await updateJsonFile<SourceSyncLedger>(
    sourceSyncFile(),
    { checkpoints: [], items: [] },
    (ledger) => {
      const checkpoint = ledger.checkpoints.find((candidate) =>
        matchesClaim(candidate, page)
      );
      if (!checkpoint || leaseExpired(checkpoint)) {
        throw new SourceSyncLeaseError();
      }
      const storedItems = pageItems(page, items, now);
      for (const item of storedItems) {
        const existing = ledger.items.find((candidate) => candidate.id === item.id);
        if (existing && sourceContractSha256(existing) !== sourceContractSha256(item)) {
          throw new Error("Source sync manifest item identity is already bound.");
        }
        if (!existing) ledger.items.push(item);
      }
      checkpoint.observedAt = observedAt;
      checkpoint.manifestSha256 = manifestSha256;
      checkpoint.itemCount = items.length;
      checkpoint.status = "committed";
      checkpoint.leaseOwnerId = undefined;
      checkpoint.leaseExpiresAt = undefined;
      checkpoint.failureCode = undefined;
      checkpoint.failureSha256 = undefined;
      checkpoint.committedAt = now;
      checkpoint.updatedAt = now;
      const nextCheckpoint = checkpointForNextPage(page, next, now);
      const existingNext = ledger.checkpoints.find(
        (candidate) => candidate.id === nextCheckpoint.id,
      );
      if (
        existingNext &&
        sourceContractSha256(existingNext) !== sourceContractSha256(nextCheckpoint)
      ) {
        throw new Error("Source sync next-page identity is already bound.");
      }
      if (!existingNext) ledger.checkpoints.push(nextCheckpoint);
      return ledger;
    },
  );
  await appendPageObservedEvent(undefined, page, items, manifestSha256).catch(
    () => undefined,
  );
  return {
    status: "shadow_observed" as const,
    checkpointId: page.checkpointId,
    manifestSha256,
    itemCount: items.length,
  };
}

async function failSourceSyncPageFile(input: {
  page: ClaimedSourceSyncPage;
  code: SourceSyncFailureCode;
  failureSha256: string;
}) {
  const { page, code, failureSha256 } = input;
  const status = page.attempts >= MAX_PAGE_ATTEMPTS ? "dead_letter" : "open";
  let updated = false;
  await updateJsonFile<SourceSyncLedger>(
    sourceSyncFile(),
    { checkpoints: [], items: [] },
    (ledger) => {
      const checkpoint = ledger.checkpoints.find((candidate) =>
        matchesClaim(candidate, page)
      );
      if (!checkpoint) return ledger;
      checkpoint.status = status;
      checkpoint.leaseOwnerId = undefined;
      checkpoint.leaseExpiresAt = undefined;
      checkpoint.failureCode = code;
      checkpoint.failureSha256 = failureSha256;
      checkpoint.updatedAt = new Date().toISOString();
      updated = true;
      return ledger;
    },
  );
  if (!updated) return { status: "lease_lost" as const };
  await appendFailureEvent(
    undefined,
    page,
    code,
    failureSha256,
    status,
  ).catch(() => undefined);
  return { status };
}

function initialCheckpoint(
  identity: SourceSyncStreamIdentity,
  observedNow = new Date().toISOString(),
): StoredCheckpoint {
  const now = canonicalSourceSyncTimestamp(observedNow);
  return {
    id: checkpointId(identity, 0),
    schemaVersion: SOURCE_SYNC_SCHEMA_VERSION,
    tenantId: identity.tenantId,
    ownerActorId: identity.ownerActorId,
    connectionId: identity.connectionId,
    provider: identity.provider,
    sourceId: identity.sourceId,
    engineVersion: identity.engineVersion,
    adapterVersionId: identity.adapterVersionId,
    adapterConfigSha256: identity.adapterConfigSha256,
    authorizationGeneration: identity.authorizationGeneration,
    rolloutGeneration: identity.rolloutGeneration,
    ...(identity.rolloutCapabilityId
      ? { rolloutCapabilityId: identity.rolloutCapabilityId }
      : {}),
    ...(identity.adapterId ? { adapterId: identity.adapterId } : {}),
    phase: "backfill",
    pageSequence: 0,
    status: "open",
    leaseGeneration: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function checkpointForNextPage(
  page: ClaimedSourceSyncPage,
  next: NextSourceSyncPage,
  now: string,
): StoredCheckpoint {
  const pageSequence = page.pageSequence + 1;
  const id = checkpointId(page.identity, pageSequence);
  const cursor = validatedCursor(next.cursor);
  return {
    id,
    schemaVersion: SOURCE_SYNC_SCHEMA_VERSION,
    tenantId: page.identity.tenantId,
    ownerActorId: page.identity.ownerActorId,
    connectionId: page.identity.connectionId,
    provider: page.identity.provider,
    sourceId: page.identity.sourceId,
    engineVersion: page.identity.engineVersion,
    adapterVersionId: page.identity.adapterVersionId,
    adapterConfigSha256: page.identity.adapterConfigSha256,
    authorizationGeneration: page.identity.authorizationGeneration,
    rolloutGeneration: page.identity.rolloutGeneration,
    ...(page.identity.rolloutCapabilityId
      ? { rolloutCapabilityId: page.identity.rolloutCapabilityId }
      : {}),
    ...(page.identity.adapterId ? { adapterId: page.identity.adapterId } : {}),
    phase: next.phase,
    pageSequence,
    requestCursorSealed: sealCursor(id, page.identity, cursor),
    requestCursorSha256: requestCursorHash(cursor),
    fenceCursorSha256: cursor.fenceToken
      ? cursorHash(cursor.fenceToken)
      : undefined,
    status: "open",
    leaseGeneration: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function insertCheckpointDb(
  sql: SourceSyncSqlClient,
  checkpoint: StoredCheckpoint,
) {
  await sql`
    INSERT INTO omni_source_sync_page_checkpoints (
      id, schema_version, tenant_id, owner_actor_id, connection_id, provider,
      source_id, engine_version, adapter_version_id, adapter_config_sha256,
      authorization_generation, rollout_generation, rollout_capability_id,
      adapter_id, rollout_lifecycle_revision, phase, page_sequence,
      request_cursor_sealed, request_cursor_sha256, fence_cursor_sha256,
      observed_at, manifest_sha256, item_count, status, lease_owner_id,
      lease_expires_at, lease_generation, attempts, failure_code,
      failure_sha256, committed_at, created_at, updated_at
    ) VALUES (
      ${checkpoint.id}, ${checkpoint.schemaVersion}, ${checkpoint.tenantId},
      ${checkpoint.ownerActorId}, ${checkpoint.connectionId},
      ${checkpoint.provider}, ${checkpoint.sourceId}, ${checkpoint.engineVersion},
      ${checkpoint.adapterVersionId}, ${checkpoint.adapterConfigSha256},
      ${checkpoint.authorizationGeneration}, ${checkpoint.rolloutGeneration},
      ${checkpoint.rolloutCapabilityId || null}, ${checkpoint.adapterId || null},
      ${checkpoint.rolloutLifecycleRevision || null}, ${checkpoint.phase},
      ${checkpoint.pageSequence},
      ${checkpoint.requestCursorSealed || null}::jsonb,
      ${checkpoint.requestCursorSha256 || null},
      ${checkpoint.fenceCursorSha256 || null},
      ${checkpoint.observedAt || null}, ${checkpoint.manifestSha256 || null},
      ${checkpoint.itemCount ?? null}, ${checkpoint.status},
      ${checkpoint.leaseOwnerId || null}, ${checkpoint.leaseExpiresAt || null},
      ${checkpoint.leaseGeneration}, ${checkpoint.attempts},
      ${checkpoint.failureCode || null}, ${checkpoint.failureSha256 || null},
      ${checkpoint.committedAt || null}, ${checkpoint.createdAt},
      ${checkpoint.updatedAt}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

async function assertNextCheckpoint(
  sql: SourceSyncSqlClient,
  expected: StoredCheckpoint,
  identity: SourceSyncStreamIdentity,
) {
  const rows = await sql`
    SELECT *
    FROM omni_source_sync_page_checkpoints
    WHERE tenant_id = ${expected.tenantId}
      AND id = ${expected.id}
      AND owner_actor_id = ${expected.ownerActorId}
      AND connection_id = ${expected.connectionId}
      AND provider = ${expected.provider}
      AND source_id = ${expected.sourceId}
      AND authorization_generation = ${expected.authorizationGeneration}
      AND rollout_generation = ${expected.rolloutGeneration}
    LIMIT 1
  `;
  if (rows.length !== 1) {
    throw new Error("Source sync next page was not persisted.");
  }
  const actual = checkpointFromRow(rows[0], identity);
  if (
    actual.status !== "open" ||
    actual.rolloutLifecycleRevision !== undefined ||
    actual.phase !== expected.phase ||
    actual.pageSequence !== expected.pageSequence ||
    actual.requestCursorSha256 !== expected.requestCursorSha256 ||
    actual.fenceCursorSha256 !== expected.fenceCursorSha256
  ) {
    throw new Error("Source sync next page conflicts with existing state.");
  }
}

async function assertStoredPageItems(
  sql: SourceSyncSqlClient,
  page: ClaimedSourceSyncPage,
  expected: StoredPageItem[],
) {
  const rows = await sql`
    SELECT id, manifest_item_sha256, adapter_event_key_sha256, outcome
    FROM omni_source_sync_page_items
    WHERE tenant_id = ${page.identity.tenantId}
      AND checkpoint_id = ${page.checkpointId}
      AND owner_actor_id = ${page.identity.ownerActorId}
      AND connection_id = ${page.identity.connectionId}
      AND provider = ${page.identity.provider}
      AND source_id = ${page.identity.sourceId}
      AND authorization_generation = ${page.identity.authorizationGeneration}
      AND rollout_generation = ${page.identity.rolloutGeneration}
    ORDER BY ordinal ASC
  `;
  if (rows.length !== expected.length) {
    throw new Error("Source sync page manifest was not stored completely.");
  }
  rows.forEach((row, index) => {
    const item = expected[index];
    if (
      row.id !== item.id ||
      row.manifest_item_sha256 !== item.manifestItemSha256 ||
      row.adapter_event_key_sha256 !== item.adapterEventKeySha256 ||
      row.outcome !== "shadow_observed"
    ) {
      throw new Error("Source sync page manifest conflicts with stored data.");
    }
  });
}

async function assertStoredCanonicalPageItems(
  sql: SourceSyncSqlClient,
  page: ClaimedCanonicalSourceSyncPage,
  expected: PendingCanonicalPageItem[],
  outcome: "pending",
) {
  const rows = await sql`
    SELECT
      id, ordinal, operation, provider_item_key_sha256,
      provider_revision_key_sha256, manifest_item_sha256,
      adapter_event_key_sha256, observed_at, delete_reason_code, outcome
    FROM omni_source_sync_page_items
    WHERE tenant_id = ${page.identity.tenantId}
      AND checkpoint_id = ${page.checkpointId}
      AND owner_actor_id = ${page.identity.ownerActorId}
      AND connection_id = ${page.identity.connectionId}
      AND provider = ${page.identity.provider}
      AND source_id = ${page.identity.sourceId}
      AND authorization_generation = ${page.identity.authorizationGeneration}
      AND rollout_generation = ${page.identity.rolloutGeneration}
    ORDER BY ordinal ASC
  `;
  if (rows.length !== expected.length) {
    throw new Error("Canonical source sync page manifest was not stored completely.");
  }
  rows.forEach((row, index) => {
    const item = expected[index];
    if (
      row.id !== item.id ||
      Number(row.ordinal) !== item.ordinal ||
      row.operation !== item.operation ||
      row.provider_item_key_sha256 !== item.providerItemKeySha256 ||
      storedNullableString(row.provider_revision_key_sha256) !==
        (item.providerRevisionKeySha256 || null) ||
      row.manifest_item_sha256 !== item.manifestItemSha256 ||
      row.adapter_event_key_sha256 !== item.adapterEventKeySha256 ||
      canonicalSourceSyncTimestamp(row.observed_at as string | Date) !==
        item.observedAt ||
      storedNullableString(row.delete_reason_code) !==
        (item.deleteReasonCode || null) ||
      row.outcome !== outcome
    ) {
      throw new Error("Canonical source sync page manifest conflicts with stored data.");
    }
  });
}

function canonicalSourceOrder(
  page: ClaimedCanonicalSourceSyncPage,
  ordinal: number,
): CanonicalSourceOrder {
  return Object.freeze({
    authorizationGeneration: page.identity.authorizationGeneration,
    rolloutGeneration: page.identity.rolloutGeneration,
    phaseRank: page.phase === "backfill" ? 0 : 1,
    pageSequence: page.pageSequence,
    ordinal,
  });
}

function validatedPreparedCanonicalMutation(
  mutation: PreparedCanonicalSourceMutation,
  page: ClaimedCanonicalSourceSyncPage,
  item: SourceSyncPageManifestItem,
  order: CanonicalSourceOrder,
): PreparedCanonicalSourceMutation {
  if (!mutation || typeof mutation !== "object") {
    throw new Error("Canonical source sync mutation preparer returned no mutation.");
  }
  const output = sourceAdapterOutputV1Schema.parse(mutation.output);
  const executionScope = parsePersistedExecutionScope(mutation.executionScope);
  if (
    !executionScope ||
    sourceContractSha256(executionScope) !==
      sourceContractSha256(page.identity.executionScope)
  ) {
    throw new Error("Canonical source sync mutation scope does not match its page.");
  }
  if (!sameCanonicalSourceOrder(mutation.order, order)) {
    throw new Error("Canonical source sync mutation order does not match its page item.");
  }
  if (
    output.operation !== item.operation ||
    output.tenantId !== page.identity.tenantId ||
    output.ownerActorId !== page.identity.ownerActorId ||
    output.connectionId !== page.identity.connectionId ||
    output.workspaceId !== executionScope.workspaceId ||
    output.projectId !== executionScope.projectId ||
    output.missionId !== executionScope.missionId ||
    !hasExactCanonicalDrivePolicy(output, executionScope) ||
    output.adapterId !== page.identity.adapterId ||
    output.adapterVersionId !== page.identity.adapterVersionId ||
    output.adapterConfigSha256 !== page.identity.adapterConfigSha256 ||
    output.adapterEventKeySha256 !== item.adapterEventKeySha256 ||
    output.observedAt !== item.observedAt
  ) {
    throw new Error("Canonical source sync adapter output does not match its page item.");
  }

  if (output.operation === "upsert") {
    const itemExtractor = output.sourceItem.extractorIdentity;
    const revisionExtractor = output.sourceRevision.extractorIdentity;
    if (
      !item.providerRevisionKeySha256 ||
      output.sourceItem.sourceKind !== "file" ||
      output.sourceRevision.sourceKind !== "file" ||
      output.sourceItem.providerItemKeySha256 !== item.providerItemKeySha256 ||
      output.sourceRevision.providerItemKeySha256 !== item.providerItemKeySha256 ||
      output.sourceRevision.providerRevisionKeySha256 !==
        item.providerRevisionKeySha256 ||
      !hasExactCanonicalDrivePolicy(
        output.sourceItem,
        executionScope,
      ) ||
      !hasExactCanonicalDrivePolicy(
        output.sourceRevision,
        executionScope,
      ) ||
      output.sourceRevision.contentSha256 !==
        CANONICAL_DRIVE_EMPTY_CONTENT_SHA256 ||
      output.sourceRevision.contentByteLength !== 0 ||
      output.sourceRevision.mediaType !== CANONICAL_DRIVE_MEDIA_TYPE ||
      output.sourceItem.metadataSha256 !==
        output.sourceRevision.metadataSha256 ||
      output.sourceItem.sourceCreatedAt !==
        output.sourceRevision.sourceCreatedAt ||
      output.sourceItem.sourceUpdatedAt !==
        output.sourceRevision.sourceUpdatedAt ||
      output.sourceItem.capturedAt !== output.sourceRevision.capturedAt ||
      itemExtractor.extractorId !== CANONICAL_DRIVE_EXTRACTOR_ID ||
      revisionExtractor.extractorId !== CANONICAL_DRIVE_EXTRACTOR_ID ||
      itemExtractor.extractorVersionId !== page.identity.adapterVersionId ||
      revisionExtractor.extractorVersionId !==
        page.identity.adapterVersionId ||
      itemExtractor.extractorConfigSha256 !==
        page.identity.adapterConfigSha256 ||
      revisionExtractor.extractorConfigSha256 !==
        page.identity.adapterConfigSha256 ||
      itemExtractor.modelVersionId !== null ||
      revisionExtractor.modelVersionId !== null ||
      output.evidenceUnits.length !== 0
    ) {
      throw new Error(
        "Canonical Drive metadata upsert does not match its hash-only manifest.",
      );
    }
    return Object.freeze({ executionScope, order, output });
  }
  if (
    output.sourceKind !== "file" ||
    output.providerItemKeySha256 !== item.providerItemKeySha256 ||
    output.deleteReason !== item.deleteReasonCode
  ) {
    throw new Error(
      "Canonical Drive metadata delete does not match its hash-only manifest.",
    );
  }
  return Object.freeze({ executionScope, order, output });
}

function hasExactCanonicalDrivePolicy(
  value: Readonly<{
    permissionGrantIds: readonly string[];
    allowedPurposeIds: readonly string[];
    visibility: string;
    sensitivity: string;
    retentionPolicyId: string;
    retentionExpiresAt: string | null;
  }>,
  executionScope: ExecutionScope,
) {
  return executionScope.purpose === CANONICAL_DRIVE_PURPOSE_ID &&
    value.permissionGrantIds.length === executionScope.contextGrantIds.length &&
    value.permissionGrantIds.every(
      (grantId, index) => grantId === executionScope.contextGrantIds[index],
    ) &&
    value.allowedPurposeIds.length === 1 &&
    value.allowedPurposeIds[0] === executionScope.purpose &&
    value.visibility === "user_private" &&
    value.sensitivity === "confidential" &&
    value.retentionPolicyId === CANONICAL_DRIVE_RETENTION_POLICY_ID &&
    value.retentionExpiresAt === null;
}

function sameCanonicalSourceOrder(
  actual: CanonicalSourceOrder | null | undefined,
  expected: CanonicalSourceOrder,
) {
  if (!actual) return false;
  return actual.authorizationGeneration === expected.authorizationGeneration &&
    actual.rolloutGeneration === expected.rolloutGeneration &&
    actual.phaseRank === expected.phaseRank &&
    actual.pageSequence === expected.pageSequence &&
    actual.ordinal === expected.ordinal;
}

async function settleCanonicalPageItem(
  sql: SourceSyncSqlClient,
  item: PendingCanonicalPageItem,
  output: SourceAdapterOutputV1,
  result: CanonicalSourceMutationResult,
  now: string,
) {
  if (
    result.operation !== output.operation ||
    !sameCanonicalSourceOrder(result.order, canonicalOrderFromStoredItem(item))
  ) {
    throw new Error("Canonical source convergence returned an incoherent result.");
  }
  const lastKnownRevisionId = output.operation === "delete" &&
      result.adapterOutputId !== null
    ? output.lastKnownSourceRevisionId
    : null;
  const noopReasonCode = result.status === "noop" ? result.reason : null;
  const rows = await sql`
    UPDATE omni_source_sync_page_items
    SET outcome = ${result.status},
        source_item_id = ${result.sourceItemId},
        source_revision_id = ${result.sourceRevisionId},
        source_tombstone_id = ${result.sourceTombstoneId},
        adapter_output_id = ${result.adapterOutputId},
        adapter_output_sha256 = ${result.adapterOutputSha256},
        noop_reason_code = ${noopReasonCode},
        last_known_revision_id = ${lastKnownRevisionId},
        attempts = attempts + 1,
        error_code = NULL,
        error_sha256 = NULL,
        next_retry_at = NULL,
        applied_at = ${now},
        updated_at = ${now}
    WHERE tenant_id = ${item.tenantId}
      AND id = ${item.id}
      AND checkpoint_id = ${item.checkpointId}
      AND ordinal = ${item.ordinal}
      AND manifest_item_sha256 = ${item.manifestItemSha256}
      AND adapter_event_key_sha256 = ${item.adapterEventKeySha256}
      AND outcome = 'pending'
    RETURNING
      outcome, source_item_id, source_revision_id, source_tombstone_id,
      adapter_output_id, adapter_output_sha256, noop_reason_code,
      last_known_revision_id
  `;
  const row = rows[0];
  if (
    rows.length !== 1 ||
    row.outcome !== result.status ||
    storedNullableString(row.source_item_id) !== result.sourceItemId ||
    storedNullableString(row.source_revision_id) !== result.sourceRevisionId ||
    storedNullableString(row.source_tombstone_id) !== result.sourceTombstoneId ||
    storedNullableString(row.adapter_output_id) !== result.adapterOutputId ||
    storedNullableString(row.adapter_output_sha256) !==
      result.adapterOutputSha256 ||
    storedNullableString(row.noop_reason_code) !== noopReasonCode ||
    storedNullableString(row.last_known_revision_id) !== lastKnownRevisionId
  ) {
    throw new Error("Canonical source sync page item settlement lost its CAS.");
  }
}

function canonicalOrderFromStoredItem(
  item: PendingCanonicalPageItem,
): CanonicalSourceOrder {
  return {
    authorizationGeneration: item.authorizationGeneration,
    rolloutGeneration: item.rolloutGeneration,
    phaseRank: item.phaseRank as 0 | 1,
    pageSequence: item.pageSequence,
    ordinal: item.ordinal,
  };
}

async function lockStream(
  sql: SourceSyncSqlClient,
  identity: SourceSyncStreamIdentity,
) {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${identity.tenantId}),
      hashtext(${streamLockKey(identity)})
    )
  `;
}

async function assertCurrentAuthorization(
  sql: SourceSyncSqlClient,
  identity: SourceSyncStreamIdentity,
) {
  const rows = await sql`
    SELECT id
    FROM omni_oauth_grants
    WHERE tenant_id = ${identity.tenantId}
      AND id = ${identity.connectionId}
      AND actor_id = ${identity.ownerActorId}
      AND provider = ${identity.provider}
      AND authorization_generation = ${identity.authorizationGeneration}
      AND status = 'active'
    LIMIT 1
    FOR UPDATE
  `;
  if (rows.length !== 1) throw new SourceSyncAuthorizationError();
}

async function assertActiveCanonicalRollout(
  sql: SourceSyncSqlClient,
  identity: SourceSyncStreamIdentity,
  rolloutBinding: SourceSyncCanonicalRolloutBinding,
  expectedLifecycleRevision?: number,
) {
  if (!isCanonicalIdentity(identity)) {
    throw new SourceSyncRolloutError(
      "Canonical source sync rollout identity is incomplete.",
    );
  }
  const rows = await sql`
    SELECT lifecycle_revision
    FROM omni_tenant_capability_rollouts
    WHERE tenant_id = ${identity.tenantId}
      AND capability_id = ${rolloutBinding.capabilityId}
      AND rollout_generation = ${identity.rolloutGeneration}
      AND engine_version = ${identity.engineVersion}
      AND contract_version_id = ${rolloutBinding.contractVersionId}
      AND configuration_sha256 = ${identity.adapterConfigSha256}
      AND mode = ${rolloutBinding.mode}
      AND status = 'active'
    LIMIT 2
    FOR SHARE
  `;
  if (rows.length !== 1) {
    throw new SourceSyncRolloutError(
      "Canonical source sync rollout is not active with the exact expected contract.",
    );
  }
  const lifecycleRevision = positiveSafeInteger(
    Number(rows[0].lifecycle_revision),
    "rollout lifecycle revision",
  );
  if (
    expectedLifecycleRevision !== undefined &&
    lifecycleRevision !== expectedLifecycleRevision
  ) {
    throw new SourceSyncRolloutError(
      "Canonical source sync lease belongs to an earlier rollout lifecycle.",
    );
  }
  return lifecycleRevision;
}

async function databaseTimestamp(sql: SourceSyncSqlClient) {
  const rows = await sql`SELECT clock_timestamp() AS current_time`;
  if (rows.length !== 1) {
    throw new Error("Source sync database clock is unavailable.");
  }
  return canonicalSourceSyncTimestamp(rows[0].current_time as string | Date);
}

async function appendPageObservedEvent(
  sql: SourceSyncSqlClient | undefined,
  page: ClaimedSourceSyncPage,
  items: SourceSyncPageManifestItem[],
  manifestSha256: string,
) {
  const upserts = items.filter((item) => item.operation === "upsert").length;
  const deletes = items.length - upserts;
  await appendScopedDomainEvent({
    id: `source_sync_event_${sourceContractSha256({
      checkpointId: page.checkpointId,
      manifestSha256,
      outcome: "shadow_observed",
    }).slice(0, 56)}`,
    streamId: `source-sync:${page.checkpointId}`,
    type: "source.sync.page.shadow_observed",
    executionScope: page.identity.executionScope,
    payload: {
      schemaVersion: SOURCE_SYNC_SCHEMA_VERSION,
      checkpointId: page.checkpointId,
      connectionId: page.identity.connectionId,
      sourceId: page.identity.sourceId,
      engineVersion: page.identity.engineVersion,
      adapterVersionId: page.identity.adapterVersionId,
      authorizationGeneration: page.identity.authorizationGeneration,
      rolloutGeneration: page.identity.rolloutGeneration,
      phase: page.phase,
      pageSequence: page.pageSequence,
      manifestSha256,
      itemCount: items.length,
      upsertCount: upserts,
      deleteCount: deletes,
      outcome: "shadow_observed",
    },
  }, sql ? { sql } : {});
}

async function appendCanonicalPageSettledEvent(
  sql: SourceSyncSqlClient,
  page: ClaimedCanonicalSourceSyncPage,
  rolloutBinding: SourceSyncCanonicalRolloutBinding,
  items: SourceSyncPageManifestItem[],
  results: CanonicalSourceMutationResult[],
  manifestSha256: string,
) {
  const appliedCount = results.filter((result) =>
    result.status === "applied"
  ).length;
  const noopCount = results.length - appliedCount;
  const upsertCount = items.filter((item) => item.operation === "upsert").length;
  const deleteCount = items.length - upsertCount;
  await appendScopedDomainEvent({
    id: `source_sync_event_${sourceContractSha256({
      checkpointId: page.checkpointId,
      manifestSha256,
      rolloutLifecycleRevision: page.rolloutLifecycleRevision,
      outcome: "canonical_settled",
    }).slice(0, 56)}`,
    streamId: `source-sync:${page.checkpointId}`,
    type: "source.sync.page.canonical_settled",
    executionScope: page.identity.executionScope,
    payload: {
      schemaVersion: SOURCE_SYNC_SCHEMA_VERSION,
      checkpointId: page.checkpointId,
      capabilityId: rolloutBinding.capabilityId,
      connectionId: page.identity.connectionId,
      sourceId: page.identity.sourceId,
      engineVersion: page.identity.engineVersion,
      contractVersionId: rolloutBinding.contractVersionId,
      adapterId: page.identity.adapterId,
      adapterVersionId: page.identity.adapterVersionId,
      adapterConfigSha256: page.identity.adapterConfigSha256,
      authorizationGeneration: page.identity.authorizationGeneration,
      rolloutGeneration: page.identity.rolloutGeneration,
      rolloutLifecycleRevision: page.rolloutLifecycleRevision,
      rolloutMode: rolloutBinding.mode,
      phase: page.phase,
      pageSequence: page.pageSequence,
      manifestSha256,
      itemCount: items.length,
      upsertCount,
      deleteCount,
      appliedCount,
      noopCount,
      staleCount: noopReasonCount(results, "stale"),
      duplicateCount: noopReasonCount(results, "duplicate"),
      notFoundCount: noopReasonCount(results, "not_found"),
      outcome: "canonical_settled",
    },
  }, { sql });
}

function canonicalPageCommitResult(
  page: ClaimedCanonicalSourceSyncPage,
  itemCount: number,
  results: CanonicalSourceMutationResult[],
  manifestSha256: string,
) {
  const appliedCount = results.filter((result) =>
    result.status === "applied"
  ).length;
  return Object.freeze({
    status: "canonical_settled" as const,
    checkpointId: page.checkpointId,
    manifestSha256,
    itemCount,
    appliedCount,
    noopCount: results.length - appliedCount,
    staleCount: noopReasonCount(results, "stale"),
    duplicateCount: noopReasonCount(results, "duplicate"),
    notFoundCount: noopReasonCount(results, "not_found"),
  });
}

function noopReasonCount(
  results: CanonicalSourceMutationResult[],
  reason: "stale" | "duplicate" | "not_found",
) {
  return results.filter((result) =>
    result.status === "noop" && result.reason === reason
  ).length;
}

async function appendFailureEvent(
  sql: SourceSyncSqlClient | undefined,
  page: ClaimedSourceSyncPage,
  code: SourceSyncFailureCode,
  failureSha256: string,
  status: "open" | "dead_letter",
  diagnosticStage?: SourceSyncDiagnosticStage,
) {
  await appendScopedDomainEvent({
    id: `source_sync_event_${sourceContractSha256({
      checkpointId: page.checkpointId,
      leaseGeneration: page.leaseGeneration,
      failureSha256,
    }).slice(0, 56)}`,
    streamId: `source-sync:${page.checkpointId}`,
    type: "source.sync.page.failed",
    executionScope: page.identity.executionScope,
    payload: {
      schemaVersion: SOURCE_SYNC_SCHEMA_VERSION,
      checkpointId: page.checkpointId,
      connectionId: page.identity.connectionId,
      sourceId: page.identity.sourceId,
      engineVersion: page.identity.engineVersion,
      adapterVersionId: page.identity.adapterVersionId,
      authorizationGeneration: page.identity.authorizationGeneration,
      rolloutGeneration: page.identity.rolloutGeneration,
      ...(isCanonicalIdentity(page.identity)
        ? {
            capabilityId: page.identity.rolloutCapabilityId,
            adapterId: page.identity.adapterId,
            rolloutLifecycleRevision: page.rolloutLifecycleRevision!,
          }
        : {}),
      phase: page.phase,
      pageSequence: page.pageSequence,
      leaseGeneration: page.leaseGeneration,
      failureCode: code,
      failureSha256,
      ...(diagnosticStage ? { diagnosticStage } : {}),
      status,
    },
  }, sql ? { sql } : {});
}

function pageItems(
  page: ClaimedSourceSyncPage,
  items: SourceSyncPageManifestItem[],
  now: string,
): StoredPageItem[] {
  return items.map((item, ordinal) => ({
    ...item,
    id: sourceSyncPageItemId(page, item, ordinal),
    checkpointId: page.checkpointId,
    tenantId: page.identity.tenantId,
    ownerActorId: page.identity.ownerActorId,
    connectionId: page.identity.connectionId,
    provider: page.identity.provider,
    sourceId: page.identity.sourceId,
    engineVersion: page.identity.engineVersion,
    authorizationGeneration: page.identity.authorizationGeneration,
    rolloutGeneration: page.identity.rolloutGeneration,
    phaseRank: page.phase === "backfill" ? 0 : 1,
    pageSequence: page.pageSequence,
    ordinal,
    outcome: "shadow_observed",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }));
}

function canonicalPendingPageItems(
  page: ClaimedCanonicalSourceSyncPage,
  items: SourceSyncPageManifestItem[],
  now: string,
): PendingCanonicalPageItem[] {
  return items.map((item, ordinal) => ({
    ...item,
    id: sourceSyncPageItemId(page, item, ordinal),
    checkpointId: page.checkpointId,
    tenantId: page.identity.tenantId,
    ownerActorId: page.identity.ownerActorId,
    connectionId: page.identity.connectionId,
    provider: page.identity.provider,
    sourceId: page.identity.sourceId,
    engineVersion: page.identity.engineVersion,
    authorizationGeneration: page.identity.authorizationGeneration,
    rolloutGeneration: page.identity.rolloutGeneration,
    phaseRank: page.phase === "backfill" ? 0 : 1,
    pageSequence: page.pageSequence,
    ordinal,
    outcome: "pending",
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  }));
}

function sourceSyncPageItemId(
  page: ClaimedSourceSyncPage,
  item: SourceSyncPageManifestItem,
  ordinal: number,
) {
  return `source_sync_item_${sourceContractSha256({
    checkpointId: page.checkpointId,
    ordinal,
    adapterEventKeySha256: item.adapterEventKeySha256,
  }).slice(0, 56)}`;
}

function dbPageItems(items: StoredPageItem[]) {
  return items.map((item) => ({
    id: item.id,
    schema_version: SOURCE_SYNC_SCHEMA_VERSION,
    tenant_id: item.tenantId,
    checkpoint_id: item.checkpointId,
    owner_actor_id: item.ownerActorId,
    connection_id: item.connectionId,
    provider: item.provider,
    source_id: item.sourceId,
    engine_version: item.engineVersion,
    authorization_generation: item.authorizationGeneration,
    rollout_generation: item.rolloutGeneration,
    phase_rank: item.phaseRank,
    page_sequence: item.pageSequence,
    ordinal: item.ordinal,
    operation: item.operation,
    provider_item_key_sha256: item.providerItemKeySha256,
    provider_revision_key_sha256: item.providerRevisionKeySha256 || null,
    adapter_event_key_sha256: item.adapterEventKeySha256,
    observed_at: item.observedAt,
    manifest_item_sha256: item.manifestItemSha256,
    outcome: item.outcome,
    source_item_id: null,
    source_revision_id: null,
    adapter_output_id: null,
    adapter_output_sha256: null,
    delete_reason_code: item.deleteReasonCode || null,
    last_known_revision_id: null,
    attempts: item.attempts,
    error_code: null,
    error_sha256: null,
    next_retry_at: null,
    applied_at: null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }));
}

async function insertCanonicalPendingPageItems(
  sql: SourceSyncSqlClient,
  items: PendingCanonicalPageItem[],
) {
  await sql`
    INSERT INTO omni_source_sync_page_items (
      id, schema_version, tenant_id, checkpoint_id, owner_actor_id,
      connection_id, provider, source_id, engine_version,
      authorization_generation, rollout_generation, phase_rank,
      page_sequence, ordinal, operation, provider_item_key_sha256,
      provider_revision_key_sha256, adapter_event_key_sha256, observed_at,
      manifest_item_sha256, outcome, source_item_id, source_revision_id,
      source_tombstone_id, adapter_output_id, adapter_output_sha256,
      delete_reason_code, noop_reason_code, last_known_revision_id, attempts,
      error_code, error_sha256, next_retry_at, applied_at, created_at,
      updated_at
    )
    SELECT
      id, schema_version, tenant_id, checkpoint_id, owner_actor_id,
      connection_id, provider, source_id, engine_version,
      authorization_generation, rollout_generation, phase_rank,
      page_sequence, ordinal, operation, provider_item_key_sha256,
      provider_revision_key_sha256, adapter_event_key_sha256, observed_at,
      manifest_item_sha256, outcome, source_item_id, source_revision_id,
      source_tombstone_id, adapter_output_id, adapter_output_sha256,
      delete_reason_code, noop_reason_code, last_known_revision_id, attempts,
      error_code, error_sha256, next_retry_at, applied_at, created_at,
      updated_at
    FROM jsonb_to_recordset(${canonicalPendingDbPageItems(items)}::jsonb) AS item(
      id text, schema_version integer, tenant_id text, checkpoint_id text,
      owner_actor_id text, connection_id text, provider text,
      source_id text, engine_version text, authorization_generation bigint,
      rollout_generation bigint, phase_rank integer, page_sequence bigint,
      ordinal integer, operation text, provider_item_key_sha256 text,
      provider_revision_key_sha256 text, adapter_event_key_sha256 text,
      observed_at timestamptz, manifest_item_sha256 text, outcome text,
      source_item_id text, source_revision_id text, source_tombstone_id text,
      adapter_output_id text, adapter_output_sha256 text,
      delete_reason_code text, noop_reason_code text,
      last_known_revision_id text, attempts integer, error_code text,
      error_sha256 text, next_retry_at timestamptz, applied_at timestamptz,
      created_at timestamptz, updated_at timestamptz
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

function canonicalPendingDbPageItems(items: PendingCanonicalPageItem[]) {
  return items.map((item) => ({
    id: item.id,
    schema_version: SOURCE_SYNC_SCHEMA_VERSION,
    tenant_id: item.tenantId,
    checkpoint_id: item.checkpointId,
    owner_actor_id: item.ownerActorId,
    connection_id: item.connectionId,
    provider: item.provider,
    source_id: item.sourceId,
    engine_version: item.engineVersion,
    authorization_generation: item.authorizationGeneration,
    rollout_generation: item.rolloutGeneration,
    phase_rank: item.phaseRank,
    page_sequence: item.pageSequence,
    ordinal: item.ordinal,
    operation: item.operation,
    provider_item_key_sha256: item.providerItemKeySha256,
    provider_revision_key_sha256: item.providerRevisionKeySha256 || null,
    adapter_event_key_sha256: item.adapterEventKeySha256,
    observed_at: item.observedAt,
    manifest_item_sha256: item.manifestItemSha256,
    outcome: item.outcome,
    source_item_id: null,
    source_revision_id: null,
    source_tombstone_id: null,
    adapter_output_id: null,
    adapter_output_sha256: null,
    delete_reason_code: item.deleteReasonCode || null,
    noop_reason_code: null,
    last_known_revision_id: null,
    attempts: item.attempts,
    error_code: null,
    error_sha256: null,
    next_retry_at: null,
    applied_at: null,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
  }));
}

function checkpointFromRow(
  row: Record<string, unknown>,
  identity: SourceSyncStreamIdentity,
): StoredCheckpoint {
  const checkpoint: StoredCheckpoint = {
    id: String(row.id),
    schemaVersion: Number(row.schema_version),
    tenantId: String(row.tenant_id),
    ownerActorId: String(row.owner_actor_id),
    connectionId: String(row.connection_id),
    provider: String(row.provider) as "google",
    sourceId: String(row.source_id),
    engineVersion: String(row.engine_version),
    adapterVersionId: String(row.adapter_version_id),
    adapterConfigSha256: String(row.adapter_config_sha256),
    authorizationGeneration: Number(row.authorization_generation),
    rolloutGeneration: Number(row.rollout_generation),
    rolloutCapabilityId: optionalString(row.rollout_capability_id),
    adapterId: optionalString(row.adapter_id),
    rolloutLifecycleRevision: optionalNumber(row.rollout_lifecycle_revision),
    phase: String(row.phase) as SourceSyncPhase,
    pageSequence: Number(row.page_sequence),
    requestCursorSealed: row.request_cursor_sealed
      ? row.request_cursor_sealed as SealedPayload
      : undefined,
    requestCursorSha256: optionalString(row.request_cursor_sha256),
    fenceCursorSha256: optionalString(row.fence_cursor_sha256),
    observedAt: optionalTimestamp(row.observed_at),
    manifestSha256: optionalString(row.manifest_sha256),
    itemCount: optionalNumber(row.item_count),
    status: String(row.status) as StoredCheckpoint["status"],
    leaseOwnerId: optionalString(row.lease_owner_id),
    leaseExpiresAt: optionalTimestamp(row.lease_expires_at),
    leaseGeneration: Number(row.lease_generation || 0),
    attempts: Number(row.attempts || 0),
    failureCode: optionalString(row.failure_code) as SourceSyncFailureCode | undefined,
    failureSha256: optionalString(row.failure_sha256),
    committedAt: optionalTimestamp(row.committed_at),
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
  if (!sameStream(checkpoint, identity)) {
    throw new Error("Source sync checkpoint scope does not match its stream.");
  }
  return checkpoint;
}

function claimFromCheckpoint(
  checkpoint: StoredCheckpoint,
  identity: SourceSyncStreamIdentity,
): ClaimedSourceSyncPage {
  if (
    checkpoint.status !== "leased" ||
    !checkpoint.leaseOwnerId ||
    !checkpoint.leaseExpiresAt
  ) {
    throw new SourceSyncLeaseError();
  }
  return {
    checkpointId: checkpoint.id,
    identity,
    phase: checkpoint.phase,
    pageSequence: checkpoint.pageSequence,
    requestCursor: checkpoint.requestCursorSealed
      ? openCursor(checkpoint.id, identity, checkpoint.requestCursorSealed)
      : undefined,
    leaseOwnerId: checkpoint.leaseOwnerId,
    leaseGeneration: checkpoint.leaseGeneration,
    leaseExpiresAt: checkpoint.leaseExpiresAt,
    attempts: checkpoint.attempts,
    ...(checkpoint.rolloutLifecycleRevision !== undefined
      ? { rolloutLifecycleRevision: checkpoint.rolloutLifecycleRevision }
      : {}),
  };
}

function canonicalClaimFromCheckpoint(
  checkpoint: StoredCheckpoint,
  identity: SourceSyncStreamIdentity,
): ClaimedCanonicalSourceSyncPage {
  const page = claimFromCheckpoint(checkpoint, identity);
  return validatedCanonicalClaim(page as ClaimedCanonicalSourceSyncPage);
}

function assertStoredClaim(
  checkpoint: StoredCheckpoint,
  page: ClaimedSourceSyncPage,
) {
  if (
    !matchesClaim(checkpoint, page) ||
    checkpoint.phase !== page.phase ||
    checkpoint.pageSequence !== page.pageSequence
  ) {
    throw new SourceSyncLeaseError();
  }
}

function validatedIdentity(
  input: SourceSyncStreamIdentity,
): SourceSyncStreamIdentity {
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope?.initiatingActorId) {
    throw new Error("Source sync shadow requires an initiating actor.");
  }
  assertExecutionScopeTenant(executionScope, input.tenantId);
  if (executionScope.initiatingActorId !== input.ownerActorId) {
    throw new Error("Source sync actor does not match its execution scope.");
  }
  const authorizationGeneration = positiveSafeInteger(
    input.authorizationGeneration,
    "authorization generation",
  );
  const rolloutGeneration = positiveSafeInteger(
    input.rolloutGeneration,
    "rollout generation",
  );
  const rolloutCapabilityId = input.rolloutCapabilityId === undefined
    ? undefined
    : sourceContractIdSchema.parse(input.rolloutCapabilityId);
  const adapterId = input.adapterId === undefined
    ? undefined
    : sourceContractIdSchema.parse(input.adapterId);
  if (rolloutGeneration === 1 && (rolloutCapabilityId || adapterId)) {
    throw new Error(
      "Source sync generation 1 cannot carry canonical rollout bindings.",
    );
  }
  if (rolloutGeneration > 1 && (!rolloutCapabilityId || !adapterId)) {
    throw new Error(
      "Canonical source sync requires rollout capability and adapter bindings.",
    );
  }
  if (input.provider !== "google") {
    throw new Error("Only the Google source sync shadow is supported.");
  }
  if (input.sourceId !== "drive") {
    throw new Error("Only the Google Drive source sync shadow is supported.");
  }
  if (
    executionScope.contextGrantIds.length !== 1 ||
    executionScope.contextGrantIds[0] !== input.connectionId
  ) {
    throw new Error("Source sync scope must bind the exact OAuth grant.");
  }
  return Object.freeze({
    tenantId: sourceContractIdSchema.parse(input.tenantId),
    ownerActorId: sourceContractIdSchema.parse(input.ownerActorId),
    connectionId: sourceContractIdSchema.parse(input.connectionId),
    provider: "google" as const,
    sourceId: sourceContractIdSchema.parse(input.sourceId),
    engineVersion: sourceContractIdSchema.parse(input.engineVersion),
    adapterVersionId: sourceContractIdSchema.parse(input.adapterVersionId),
    adapterConfigSha256: sourceContractSha256Schema.parse(
      input.adapterConfigSha256,
    ),
    authorizationGeneration,
    rolloutGeneration,
    ...(rolloutCapabilityId ? { rolloutCapabilityId } : {}),
    ...(adapterId ? { adapterId } : {}),
    executionScope,
  });
}

function canonicalIdentity(
  input: SourceSyncStreamIdentity,
): ClaimedCanonicalSourceSyncPage["identity"] {
  const identity = validatedIdentity(input);
  if (!isCanonicalIdentity(identity)) {
    throw new Error("Canonical source sync requires rollout generation 2 or newer.");
  }
  return identity;
}

function validatedClaim(page: ClaimedSourceSyncPage) {
  const identity = validatedIdentity(page.identity);
  const checkpointIdValue = sourceContractIdSchema.parse(page.checkpointId);
  const leaseOwnerId = sourceContractIdSchema.parse(page.leaseOwnerId);
  if (page.phase !== "backfill" && page.phase !== "changes") {
    throw new Error("Source sync phase is invalid.");
  }
  const leaseExpiresAt = canonicalSourceSyncTimestamp(page.leaseExpiresAt);
  const pageSequence = nonNegativeSafeInteger(
    page.pageSequence,
    "page sequence",
  );
  if (checkpointIdValue !== checkpointId(identity, pageSequence)) {
    throw new Error("Source sync checkpoint does not match its stream position.");
  }
  const rolloutLifecycleRevision = page.rolloutLifecycleRevision === undefined
    ? undefined
    : positiveSafeInteger(
        page.rolloutLifecycleRevision,
        "rollout lifecycle revision",
      );
  if (isCanonicalIdentity(identity) && rolloutLifecycleRevision === undefined) {
    throw new Error(
      "Canonical source sync leases require a rollout lifecycle revision.",
    );
  }
  if (!isCanonicalIdentity(identity) && rolloutLifecycleRevision !== undefined) {
    throw new Error(
      "Source sync generation 1 cannot carry a rollout lifecycle revision.",
    );
  }
  return Object.freeze({
    ...page,
    checkpointId: checkpointIdValue,
    identity,
    pageSequence,
    requestCursor: page.requestCursor
      ? validatedCursor(page.requestCursor)
      : undefined,
    leaseOwnerId,
    leaseGeneration: positiveSafeInteger(
      page.leaseGeneration,
      "lease generation",
    ),
    leaseExpiresAt,
    attempts: positiveSafeInteger(page.attempts, "attempt count"),
    ...(rolloutLifecycleRevision !== undefined
      ? { rolloutLifecycleRevision }
      : {}),
  });
}

function validatedCanonicalClaim(
  page: ClaimedCanonicalSourceSyncPage,
): ClaimedCanonicalSourceSyncPage {
  const validated = validatedClaim(page);
  if (
    !isCanonicalIdentity(validated.identity) ||
    validated.rolloutLifecycleRevision === undefined
  ) {
    throw new Error("Canonical source sync claim binding is incomplete.");
  }
  return validated as ClaimedCanonicalSourceSyncPage;
}

function validatedManifest(
  itemsInput: readonly SourceSyncPageManifestItem[],
) {
  if (itemsInput.length > MAX_PAGE_ITEMS) {
    throw new Error("Source sync page manifest exceeds its item limit.");
  }
  const seenEvents = new Set<string>();
  return itemsInput.map((item) => {
    if (item.operation !== "upsert" && item.operation !== "delete") {
      throw new Error("Source sync manifest operation is invalid.");
    }
    const adapterEventKeySha256 = sourceContractSha256Schema.parse(
      item.adapterEventKeySha256,
    );
    if (seenEvents.has(adapterEventKeySha256)) {
      throw new Error("Source sync page contains a duplicate provider event.");
    }
    seenEvents.add(adapterEventKeySha256);
    const normalized: SourceSyncPageManifestItem = {
      operation: item.operation,
      providerItemKeySha256: sourceContractSha256Schema.parse(
        item.providerItemKeySha256,
      ),
      ...(item.providerRevisionKeySha256
        ? {
            providerRevisionKeySha256: sourceContractSha256Schema.parse(
              item.providerRevisionKeySha256,
            ),
          }
        : {}),
      adapterEventKeySha256,
      observedAt: canonicalSourceSyncTimestamp(item.observedAt),
      manifestItemSha256: sourceContractSha256Schema.parse(
        item.manifestItemSha256,
      ),
      ...(item.deleteReasonCode
        ? { deleteReasonCode: item.deleteReasonCode }
        : {}),
    };
    if (
      normalized.operation === "delete" &&
      normalized.deleteReasonCode !== "provider_deleted" &&
      normalized.deleteReasonCode !== "source_missing"
    ) {
      throw new Error("Source sync delete reason is invalid.");
    }
    if (normalized.operation === "upsert" && normalized.deleteReasonCode) {
      throw new Error("Source sync upsert cannot carry a delete reason.");
    }
    if (
      sourceContractSha256({
        operation: normalized.operation,
        providerItemKeySha256: normalized.providerItemKeySha256,
        providerRevisionKeySha256:
          normalized.providerRevisionKeySha256 || null,
        adapterEventKeySha256: normalized.adapterEventKeySha256,
        observedAt: normalized.observedAt,
        deleteReasonCode: normalized.deleteReasonCode || null,
      }) !== normalized.manifestItemSha256
    ) {
      throw new Error("Source sync manifest item digest is invalid.");
    }
    return normalized;
  });
}

function validatedNextPage(input: NextSourceSyncPage): NextSourceSyncPage {
  if (input.phase !== "backfill" && input.phase !== "changes") {
    throw new Error("Source sync next phase is invalid.");
  }
  const cursor = validatedCursor(input.cursor);
  if (input.phase === "backfill" && !cursor.fenceToken) {
    throw new Error("Drive backfill pages require a pinned change fence.");
  }
  if (input.phase === "changes" && !cursor.pageToken) {
    throw new Error("Drive change pages require a page token.");
  }
  if (input.phase === "changes" && !cursor.fenceToken) {
    throw new Error("Drive change pages require their pinned change fence.");
  }
  return { phase: input.phase, cursor };
}

function validatedCursor(input: SourceSyncCursor): SourceSyncCursor {
  const pageToken = input.pageToken
    ? boundedCursor(input.pageToken, "Drive page token")
    : undefined;
  const fenceToken = input.fenceToken
    ? boundedCursor(input.fenceToken, "Drive fence token")
    : undefined;
  if (!pageToken && !fenceToken) {
    throw new Error("Source sync cursor cannot be empty.");
  }
  return Object.freeze({
    ...(pageToken ? { pageToken } : {}),
    ...(fenceToken ? { fenceToken } : {}),
  });
}

function sealCursor(
  checkpointIdValue: string,
  identity: SourceSyncStreamIdentity,
  cursor: SourceSyncCursor,
) {
  return sealJsonPayload(
    validatedCursor(cursor),
    cursorBinding(checkpointIdValue, identity),
  );
}

function openCursor(
  checkpointIdValue: string,
  identity: SourceSyncStreamIdentity,
  sealed: SealedPayload,
) {
  const opened = openJsonPayload(
    sealed,
    cursorBinding(checkpointIdValue, identity),
  );
  if (!opened || typeof opened !== "object" || Array.isArray(opened)) {
    throw new Error("Source sync cursor payload is invalid.");
  }
  const value = opened as Record<string, unknown>;
  return validatedCursor({
    pageToken: typeof value.pageToken === "string" ? value.pageToken : undefined,
    fenceToken: typeof value.fenceToken === "string" ? value.fenceToken : undefined,
  });
}

function cursorBinding(
  checkpointIdValue: string,
  identity: SourceSyncStreamIdentity,
) {
  const binding: Array<string | number> = [
    "source-sync-cursor",
    checkpointIdValue,
    identity.tenantId,
    identity.ownerActorId,
    identity.connectionId,
    identity.authorizationGeneration,
    identity.rolloutGeneration,
  ];
  if (isCanonicalIdentity(identity)) {
    binding.push(identity.rolloutCapabilityId, identity.adapterId);
  }
  return binding.join(":");
}

function checkpointId(identity: SourceSyncStreamIdentity, pageSequence: number) {
  return `source_sync_page_${sourceContractSha256({
    tenantId: identity.tenantId,
    ownerActorId: identity.ownerActorId,
    connectionId: identity.connectionId,
    provider: identity.provider,
    sourceId: identity.sourceId,
    engineVersion: identity.engineVersion,
    adapterVersionId: identity.adapterVersionId,
    adapterConfigSha256: identity.adapterConfigSha256,
    authorizationGeneration: identity.authorizationGeneration,
    rolloutGeneration: identity.rolloutGeneration,
    ...(isCanonicalIdentity(identity)
      ? {
          rolloutCapabilityId: identity.rolloutCapabilityId,
          adapterId: identity.adapterId,
        }
      : {}),
    pageSequence,
  }).slice(0, 56)}`;
}

function cursorHash(value: string) {
  return sourceContractSha256({ cursor: value });
}

function requestCursorHash(cursor: SourceSyncCursor) {
  return sourceContractSha256({
    pageToken: cursor.pageToken || null,
    fenceToken: cursor.fenceToken || null,
  });
}

function streamLockKey(identity: SourceSyncStreamIdentity) {
  return sourceContractSha256({
    ownerActorId: identity.ownerActorId,
    connectionId: identity.connectionId,
    provider: identity.provider,
    sourceId: identity.sourceId,
    engineVersion: identity.engineVersion,
    adapterVersionId: identity.adapterVersionId,
    authorizationGeneration: identity.authorizationGeneration,
    rolloutGeneration: identity.rolloutGeneration,
    ...(isCanonicalIdentity(identity)
      ? {
          rolloutCapabilityId: identity.rolloutCapabilityId,
          adapterId: identity.adapterId,
        }
      : {}),
  });
}

function sameStream(
  checkpoint: StoredCheckpoint,
  identity: SourceSyncStreamIdentity,
) {
  return checkpoint.schemaVersion === SOURCE_SYNC_SCHEMA_VERSION &&
    checkpoint.tenantId === identity.tenantId &&
    checkpoint.ownerActorId === identity.ownerActorId &&
    checkpoint.connectionId === identity.connectionId &&
    checkpoint.provider === identity.provider &&
    checkpoint.sourceId === identity.sourceId &&
    checkpoint.engineVersion === identity.engineVersion &&
    checkpoint.adapterVersionId === identity.adapterVersionId &&
    checkpoint.adapterConfigSha256 === identity.adapterConfigSha256 &&
    checkpoint.authorizationGeneration === identity.authorizationGeneration &&
    checkpoint.rolloutGeneration === identity.rolloutGeneration &&
    checkpoint.rolloutCapabilityId === identity.rolloutCapabilityId &&
    checkpoint.adapterId === identity.adapterId;
}

function matchesClaim(
  checkpoint: StoredCheckpoint,
  page: ClaimedSourceSyncPage,
) {
  return sameStream(checkpoint, page.identity) &&
    checkpoint.id === page.checkpointId &&
    checkpoint.status === "leased" &&
    checkpoint.leaseOwnerId === page.leaseOwnerId &&
    checkpoint.leaseGeneration === page.leaseGeneration &&
    checkpoint.rolloutLifecycleRevision === page.rolloutLifecycleRevision;
}

function isCanonicalIdentity(
  identity: SourceSyncStreamIdentity,
): identity is SourceSyncStreamIdentity & Readonly<{
  rolloutCapabilityId: string;
  adapterId: string;
}> {
  return identity.rolloutGeneration > 1 &&
    typeof identity.rolloutCapabilityId === "string" &&
    typeof identity.adapterId === "string";
}

function assertLegacySourceSyncGeneration(identity: SourceSyncStreamIdentity) {
  if (identity.rolloutGeneration !== 1) {
    throw new Error(
      "Canonical source sync generations require the canonical checkpoint API.",
    );
  }
}

function validatedCanonicalRolloutBinding(
  input: SourceSyncCanonicalRolloutBinding,
  identity: SourceSyncStreamIdentity,
): SourceSyncCanonicalRolloutBinding {
  if (!isCanonicalIdentity(identity)) {
    throw new Error("Canonical source sync rollout identity is incomplete.");
  }
  const capabilityId = sourceContractIdSchema.parse(input.capabilityId);
  const contractVersionId = sourceContractIdSchema.parse(
    input.contractVersionId,
  );
  if (input.mode !== "canary" && input.mode !== "enabled") {
    throw new Error("Canonical source sync rollout mode is not write-enabled.");
  }
  if (
    capabilityId !== identity.rolloutCapabilityId ||
    contractVersionId !== identity.adapterVersionId
  ) {
    throw new Error(
      "Canonical source sync rollout binding does not match its stream identity.",
    );
  }
  return Object.freeze({
    capabilityId,
    contractVersionId,
    mode: input.mode,
  });
}

function requireCanonicalPostgres() {
  if (!hasDatabaseUrl()) {
    throw new SourceSyncRolloutError(
      "Canonical source sync requires PostgreSQL-backed atomic settlement.",
    );
  }
}

function leaseExpired(checkpoint: StoredCheckpoint) {
  return !checkpoint.leaseExpiresAt ||
    Date.parse(checkpoint.leaseExpiresAt) <= Date.now();
}

function positiveSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Source sync ${field} must be a positive safe integer.`);
  }
  return value;
}

function nonNegativeSafeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Source sync ${field} must be a non-negative safe integer.`);
  }
  return value;
}

function boundedCursor(value: string, field: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_CURSOR_CHARACTERS) {
    throw new Error(`${field} is invalid.`);
  }
  return normalized;
}

export function canonicalSourceSyncTimestamp(value: string | Date) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Source sync provider timestamp is invalid.");
  }
  return date.toISOString();
}

function optionalTimestamp(value: unknown) {
  return value ? new Date(String(value)).toISOString() : undefined;
}

function optionalString(value: unknown) {
  return value === null || value === undefined || value === ""
    ? undefined
    : String(value);
}

function optionalNumber(value: unknown) {
  return value === null || value === undefined ? undefined : Number(value);
}

function storedNullableString(value: unknown) {
  return value === null || value === undefined ? null : String(value);
}

function sourceSyncFailureCode(value: SourceSyncFailureCode) {
  const allowed = new Set<SourceSyncFailureCode>([
    "cursor_expired",
    "invalid_provider_response",
    "lease_lost",
    "provider_forbidden",
    "provider_rate_limited",
    "provider_unauthorized",
    "provider_unavailable",
    "request_aborted",
    "store_unavailable",
    "unexpected_failure",
  ]);
  if (!allowed.has(value)) throw new Error("Source sync failure code is invalid.");
  return value;
}

class SourceSyncLeaseError extends Error {
  constructor(message = "Source sync page lease was lost.") {
    super(message);
    this.name = "SourceSyncLeaseError";
  }
}

class SourceSyncAuthorizationError extends Error {
  constructor() {
    super("Source sync OAuth authorization is no longer current.");
    this.name = "SourceSyncAuthorizationError";
  }
}

class SourceSyncRolloutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceSyncRolloutError";
  }
}
