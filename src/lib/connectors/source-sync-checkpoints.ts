import { randomUUID } from "node:crypto";
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
  sourceContractIdSchema,
  sourceContractSha256,
  sourceContractSha256Schema,
} from "@/lib/sources/contracts";
import { getDataPath } from "@/lib/storage/paths";
import { updateJsonFile } from "@/lib/storage/json";

const SOURCE_SYNC_SCHEMA_VERSION = 1;
const LEASE_DURATION_MS = 60_000;
const MAX_PAGE_ITEMS = 1_000;
const MAX_PAGE_ATTEMPTS = 5;
const MAX_CURSOR_CHARACTERS = 4_000;

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
  executionScope: ExecutionScope;
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
}>;

export type SourceSyncPageClaim =
  | { status: "claimed"; page: ClaimedSourceSyncPage }
  | { status: "busy" | "blocked" };

export type NextSourceSyncPage = Readonly<{
  phase: SourceSyncPhase;
  cursor: SourceSyncCursor;
}>;

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

type SourceSyncLedger = {
  checkpoints: StoredCheckpoint[];
  items: StoredPageItem[];
};

const sourceSyncFile = () => getDataPath("source-sync-checkpoints.json");

export async function claimSourceSyncPage(
  identityInput: SourceSyncStreamIdentity,
): Promise<SourceSyncPageClaim> {
  const identity = validatedIdentity(identityInput);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(
      identity.tenantId,
      () => claimSourceSyncPageDb(identity),
    );
  }
  return claimSourceSyncPageFile(identity);
}

export async function pinSourceSyncBackfillFence(
  page: ClaimedSourceSyncPage,
  fenceTokenInput: string,
): Promise<ClaimedSourceSyncPage> {
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

export async function commitSourceSyncPage(input: {
  page: ClaimedSourceSyncPage;
  items: readonly SourceSyncPageManifestItem[];
  next: NextSourceSyncPage;
  observedAt: string;
}) {
  const page = validatedClaim(input.page);
  if (!page.requestCursor?.fenceToken) {
    throw new Error("Source sync pages must retain their pinned change fence.");
  }
  const items = validatedManifest(input.items);
  const next = validatedNextPage(input.next);
  const manifestSha256 = sourceContractSha256(
    items.map((item, ordinal) => ({ ordinal, ...item })),
  );
  const observedAt = canonicalTimestamp(input.observedAt);

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

export async function failSourceSyncPage(input: {
  page: ClaimedSourceSyncPage;
  code: SourceSyncFailureCode;
  failureSha256: string;
}) {
  const page = validatedClaim(input.page);
  const code = sourceSyncFailureCode(input.code);
  const failureSha256 = sourceContractSha256Schema.parse(input.failureSha256);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseTenantScope(
      page.identity.tenantId,
      () => failSourceSyncPageDb({ page, code, failureSha256 }),
    );
  }
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
): Promise<SourceSyncPageClaim> {
  return await getSql().transaction(async (sql: SourceSyncSqlClient) => {
    await lockStream(sql, identity);
    await assertCurrentAuthorization(sql, identity);
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
    const claimed = await sql`
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
    return {
      status: "claimed",
      page: claimFromCheckpoint(checkpointFromRow(claimed[0], identity), identity),
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
        FROM jsonb_to_recordset(${JSON.stringify(dbPageItems(storedItems))}::jsonb) AS item(
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

async function failSourceSyncPageDb(input: {
  page: ClaimedSourceSyncPage;
  code: SourceSyncFailureCode;
  failureSha256: string;
}) {
  const { page, code, failureSha256 } = input;
  return await getSql().transaction(async (sql: SourceSyncSqlClient) => {
    await lockStream(sql, page.identity);
    const status = page.attempts >= MAX_PAGE_ATTEMPTS
      ? "dead_letter"
      : "open";
    const rows = await sql`
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
    await appendFailureEvent(sql, page, code, failureSha256, status);
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
  const now = canonicalTimestamp(observedNow);
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
      authorization_generation, rollout_generation, phase, page_sequence,
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
      ${checkpoint.phase}, ${checkpoint.pageSequence},
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

async function databaseTimestamp(sql: SourceSyncSqlClient) {
  const rows = await sql`SELECT clock_timestamp() AS current_time`;
  if (rows.length !== 1) {
    throw new Error("Source sync database clock is unavailable.");
  }
  return canonicalTimestamp(String(rows[0].current_time));
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

async function appendFailureEvent(
  sql: SourceSyncSqlClient | undefined,
  page: ClaimedSourceSyncPage,
  code: SourceSyncFailureCode,
  failureSha256: string,
  status: "open" | "dead_letter",
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
      phase: page.phase,
      pageSequence: page.pageSequence,
      leaseGeneration: page.leaseGeneration,
      failureCode: code,
      failureSha256,
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
    id: `source_sync_item_${sourceContractSha256({
      checkpointId: page.checkpointId,
      ordinal,
      adapterEventKeySha256: item.adapterEventKeySha256,
    }).slice(0, 56)}`,
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
  };
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
    executionScope,
  });
}

function validatedClaim(page: ClaimedSourceSyncPage) {
  const identity = validatedIdentity(page.identity);
  const checkpointIdValue = sourceContractIdSchema.parse(page.checkpointId);
  const leaseOwnerId = sourceContractIdSchema.parse(page.leaseOwnerId);
  if (page.phase !== "backfill" && page.phase !== "changes") {
    throw new Error("Source sync phase is invalid.");
  }
  const leaseExpiresAt = canonicalTimestamp(page.leaseExpiresAt);
  const pageSequence = nonNegativeSafeInteger(
    page.pageSequence,
    "page sequence",
  );
  if (checkpointIdValue !== checkpointId(identity, pageSequence)) {
    throw new Error("Source sync checkpoint does not match its stream position.");
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
  });
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
      observedAt: canonicalTimestamp(item.observedAt),
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
  return [
    "source-sync-cursor",
    checkpointIdValue,
    identity.tenantId,
    identity.ownerActorId,
    identity.connectionId,
    identity.authorizationGeneration,
    identity.rolloutGeneration,
  ].join(":");
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
    checkpoint.rolloutGeneration === identity.rolloutGeneration;
}

function matchesClaim(
  checkpoint: StoredCheckpoint,
  page: ClaimedSourceSyncPage,
) {
  return sameStream(checkpoint, page.identity) &&
    checkpoint.id === page.checkpointId &&
    checkpoint.status === "leased" &&
    checkpoint.leaseOwnerId === page.leaseOwnerId &&
    checkpoint.leaseGeneration === page.leaseGeneration;
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

function canonicalTimestamp(value: string) {
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
