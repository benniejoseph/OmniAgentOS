import { randomUUID } from "node:crypto";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import {
  SALESFORCE_OBJECT_TYPES,
  buildSalesforceRecordRevision,
  initialSalesforceSyncCursor,
  resolveSalesforceHead,
  salesforceActionableErrorSchema,
  salesforceConnectionId,
  salesforceOrganizationIdSha256,
  salesforceRecordRevisionSchema,
  salesforceSyncCursorSchema,
  salesforceSyncHealthSchema,
  type SalesforceActionableError,
  type SalesforceRecordObservation,
  type SalesforceRecordRevision,
  type SalesforceSyncCursor,
  type SalesforceSyncHealth,
} from "@/lib/customer-success/salesforce-contracts";
import { isSalesforceInstanceUrl } from "@/lib/connectors/oauth-providers";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  salesforceWriteCommitSchema,
  type SalesforceRecordWriteToolId,
  type SalesforceWriteCommit,
  type SalesforceWriteObject,
} from "@/lib/customer-success/salesforce-write-contracts";

type SalesforceSql = ReturnType<typeof getSql>;

export type SalesforceReadAuthority = Readonly<{
  tenantId: string;
  workspaceId: string;
  canonicalActorId: string;
  readableActorIds: readonly string[];
}>;

export type SalesforceMutationAuthority = SalesforceReadAuthority & Readonly<{
  executionScope: ExecutionScope;
}>;

export type SalesforceSyncLease = Readonly<{
  ownerId: string;
  generation: number;
  expiresAt: string;
}>;

export type SalesforceConnection = Readonly<{
  connectionId: string;
  tenantId: string;
  workspaceId: string;
  ownerActorId: string;
  oauthGrantId: string;
  authorizationGeneration: number;
  organizationIdSha256: string;
  instanceOrigin: string;
  connectionState: "active" | "revoked" | "error";
  cursor: SalesforceSyncCursor;
  syncStatus: "idle" | "backfilling" | "syncing" | "healthy" | "degraded" | "error";
  syncError: SalesforceActionableError | null;
  lastSuccessfulSyncAt: string | null;
  lastWebhookAt: string | null;
  lastReplayIdSha256: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export class SalesforceConnectionConflictError extends Error {
  readonly status = 409;

  constructor(message = "Salesforce connection conflicts with this workspace.") {
    super(message);
    this.name = "SalesforceConnectionConflictError";
  }
}

export class SalesforceConnectionNotFoundError extends Error {
  readonly status = 404;

  constructor() {
    super("Salesforce is not connected to this workspace.");
    this.name = "SalesforceConnectionNotFoundError";
  }
}

export type SalesforceWriteOperation = Readonly<{
  operationId: string;
  toolExecutionId: string;
  toolId: SalesforceRecordWriteToolId;
  objectType: SalesforceWriteObject;
  action: "create" | "update";
  customerAccountId: string;
  providerRecordIdSha256: string | null;
  requestSha256: string;
  expectedTargetStateSha256: string;
  state: "prepared" | "verified" | "failed";
  providerAcknowledgementSha256: string | null;
  observedTargetStateSha256: string | null;
  verificationReasonCode: "state_matched" | "target_missing" | "state_mismatch" | null;
  attemptCount: number;
  lastAttemptAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export async function bindSalesforceConnection(input: {
  authority: SalesforceMutationAuthority;
  oauthGrantId: string;
  authorizationGeneration: number;
  tokens: Record<string, unknown>;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const identity = salesforceTokenIdentity(input.tokens);
  const connectionId = salesforceConnectionId({
    tenantId: input.authority.tenantId,
    workspaceId: input.authority.workspaceId,
    organizationIdSha256: identity.organizationIdSha256,
  });
  const cursor = initialSalesforceSyncCursor();
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      const grantRows = await sql`
        SELECT id, tenant_id, actor_id, provider, scopes, status,
          authorization_generation
        FROM omni_oauth_grants
        WHERE id = ${input.oauthGrantId}
          AND tenant_id = ${input.authority.tenantId}
          AND actor_id = ${input.authority.canonicalActorId}
          AND provider = 'salesforce'
          AND status = 'active'
        FOR UPDATE
      `;
      const grant = grantRows[0];
      if (!grant || Number(grant.authorization_generation) !== input.authorizationGeneration) {
        throw new SalesforceConnectionConflictError(
          "Salesforce authorization changed before it could be bound.",
        );
      }
      const scopes = Array.isArray(grant.scopes) ? grant.scopes.map(String) : [];
      if (!scopes.includes("api") || !scopes.includes("refresh_token")) {
        throw new SalesforceConnectionConflictError(
          "Salesforce must grant API and offline refresh permissions.",
        );
      }
      const clock = await sql`SELECT clock_timestamp() AS now`;
      const now = timestamp(clock[0]?.now);
      const rows = await sql`
        INSERT INTO omni_salesforce_connections (
          tenant_id, workspace_id, connection_id, owner_actor_id,
          oauth_grant_id, authorization_generation, organization_id_sha256,
          instance_origin, connection_state, access_mode, object_scope,
          allowed_purpose_ids, sync_cursor, sync_status, created_at, updated_at
        ) VALUES (
          ${input.authority.tenantId}, ${input.authority.workspaceId},
          ${connectionId}, ${input.authority.canonicalActorId},
          ${input.oauthGrantId}, ${input.authorizationGeneration},
          ${identity.organizationIdSha256}, ${identity.instanceOrigin},
          'active', 'read_only', ${[...SALESFORCE_OBJECT_TYPES]},
          ${["customer_success.account.read", "customer_success.crm_sync"]},
          ${cursor}::JSONB, 'idle', ${now}, ${now}
        )
        ON CONFLICT (tenant_id, workspace_id) DO UPDATE SET
          oauth_grant_id = EXCLUDED.oauth_grant_id,
          authorization_generation = EXCLUDED.authorization_generation,
          instance_origin = EXCLUDED.instance_origin,
          connection_state = 'active',
          sync_error = NULL,
          sync_lease_owner_id = NULL,
          sync_lease_expires_at = NULL,
          updated_at = EXCLUDED.updated_at
        WHERE omni_salesforce_connections.connection_id = EXCLUDED.connection_id
          AND omni_salesforce_connections.organization_id_sha256 = EXCLUDED.organization_id_sha256
          AND omni_salesforce_connections.owner_actor_id = EXCLUDED.owner_actor_id
        RETURNING *
      `;
      if (!rows[0]) {
        throw new SalesforceConnectionConflictError(
          "A different Salesforce organization is already bound to this workspace.",
        );
      }
      const connection = connectionFromRow(rows[0]);
      await appendScopedDomainEvent({
        id: `salesforce-connection-bound:${connection.connectionId}:${connection.authorizationGeneration}`,
        streamId: connection.connectionId,
        type: "customer.salesforce.connection.bound",
        executionScope: input.authority.executionScope,
        payload: {
          schemaVersion: 1,
          connectionId: connection.connectionId,
          workspaceId: connection.workspaceId,
          organizationIdSha256: connection.organizationIdSha256,
          authorizationGeneration: connection.authorizationGeneration,
          accessMode: "read_only",
          objectScope: SALESFORCE_OBJECT_TYPES,
        },
      }, { sql });
      return connection;
    }) as Promise<SalesforceConnection>,
  );
}

export async function getSalesforceConnection(
  authority: SalesforceReadAuthority,
): Promise<SalesforceConnection | undefined> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT * FROM omni_salesforce_connections
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
        LIMIT 1
      `;
      return rows[0] ? connectionFromRow(rows[0]) : undefined;
    },
  );
}

export async function getSalesforceSyncHealth(
  authority: SalesforceReadAuthority,
  configured: boolean,
): Promise<SalesforceSyncHealth> {
  const connection = await getSalesforceConnection(authority);
  return projectSalesforceSyncHealth({
    workspaceId: authority.workspaceId,
    configured,
    connection,
    evaluatedAt: new Date().toISOString(),
  });
}

export function projectSalesforceSyncHealth(input: {
  workspaceId: string;
  configured: boolean;
  connection?: SalesforceConnection;
  evaluatedAt: string;
}) {
  const connection = input.connection;
  const lastProgress = connection?.lastSuccessfulSyncAt ||
    latestWatermark(connection?.cursor) || null;
  const lagSeconds = lastProgress
    ? Math.max(0, Math.floor(
        (Date.parse(input.evaluatedAt) - Date.parse(lastProgress)) / 1_000,
      ))
    : null;
  const status = !input.configured
    ? "configuration_required"
    : !connection || connection.connectionState === "revoked"
      ? "disconnected"
      : connection.syncStatus;
  return salesforceSyncHealthSchema.parse({
    schemaVersion: 1,
    contractVersion: "p10.10-salesforce-read-sync:1",
    configured: input.configured,
    connected: Boolean(connection && connection.connectionState === "active"),
    connectionId: connection?.connectionId || null,
    workspaceId: input.workspaceId,
    status,
    accessMode: "read_only",
    objectScope: SALESFORCE_OBJECT_TYPES,
    purposeScope: [
      "customer_success.account.read",
      "customer_success.crm_sync",
    ],
    cursor: connection?.cursor || null,
    lagSeconds,
    lastSuccessfulSyncAt: connection?.lastSuccessfulSyncAt || null,
    lastWebhookAt: connection?.lastWebhookAt || null,
    lastReplayIdSha256: connection?.lastReplayIdSha256 || null,
    actionableError: connection?.syncError || null,
    evaluatedAt: new Date(input.evaluatedAt).toISOString(),
  });
}

export async function claimSalesforceSyncLease(
  authority: SalesforceMutationAuthority,
): Promise<{ status: "claimed"; connection: SalesforceConnection; lease: SalesforceSyncLease } | { status: "busy" }> {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(authority);
  const ownerId = `salesforce-sync:${randomUUID()}`;
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        UPDATE omni_salesforce_connections
        SET sync_lease_owner_id = ${ownerId},
            sync_lease_generation = sync_lease_generation + 1,
            sync_lease_expires_at = clock_timestamp() + INTERVAL '10 minutes',
            sync_status = CASE
              WHEN sync_cursor #>> '{objects,Account,phase}' = 'pending'
                THEN 'backfilling'
              ELSE 'syncing'
            END,
            sync_error = NULL,
            updated_at = clock_timestamp()
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND connection_state = 'active'
          AND (sync_lease_owner_id IS NULL OR sync_lease_expires_at <= clock_timestamp())
        RETURNING *
      `;
      if (!rows[0]) return { status: "busy" as const };
      const connection = connectionFromRow(rows[0]);
      return {
        status: "claimed" as const,
        connection,
        lease: {
          ownerId,
          generation: Number(rows[0].sync_lease_generation),
          expiresAt: timestamp(rows[0].sync_lease_expires_at),
        },
      };
    },
  );
}

export async function settleSalesforceSyncPage(input: {
  authority: SalesforceMutationAuthority;
  connection: SalesforceConnection;
  lease: SalesforceSyncLease;
  observations: readonly SalesforceRecordObservation[];
  cursor: SalesforceSyncCursor;
  releaseLease: boolean;
  healthy: boolean;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const cursor = salesforceSyncCursorSchema.parse(input.cursor);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      const connectionRows = await sql`
        SELECT * FROM omni_salesforce_connections
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connection.connectionId}
          AND owner_actor_id = ${input.authority.canonicalActorId}
          AND sync_lease_owner_id = ${input.lease.ownerId}
          AND sync_lease_generation = ${input.lease.generation}
          AND sync_lease_expires_at > clock_timestamp()
          AND connection_state = 'active'
        FOR UPDATE
      `;
      if (!connectionRows[0]) {
        throw new SalesforceConnectionConflictError(
          "Salesforce sync lost its exact lease fence.",
        );
      }
      const clock = await sql`SELECT clock_timestamp() AS now`;
      const receivedAt = timestamp(clock[0]?.now);
      let inserted = 0;
      let advanced = 0;
      let stale = 0;
      let duplicate = 0;
      let conflicts = 0;
      const advancedRecords: SalesforceRecordRevision[] = [];
      for (const observation of input.observations) {
        const revision = buildSalesforceRecordRevision({
          tenantId: input.authority.tenantId,
          workspaceId: input.authority.workspaceId,
          connectionId: input.connection.connectionId,
          organizationIdSha256: input.connection.organizationIdSha256,
          observation,
          receivedAt,
        });
        const insertedRows = await sql`
          INSERT INTO omni_salesforce_record_revisions (
            tenant_id, workspace_id, connection_id, owner_actor_id,
            organization_id_sha256, object_type, external_id,
            account_external_id, revision_id, provider_modified_at, deleted,
            fields_sha256, record_sha256, record_snapshot, source_kind,
            observed_at, received_at, replay_id_sha256
          ) VALUES (
            ${revision.tenantId}, ${revision.workspaceId},
            ${revision.connectionId}, ${input.authority.canonicalActorId},
            ${revision.organizationIdSha256}, ${revision.objectType},
            ${revision.externalId}, ${revision.accountExternalId},
            ${revision.revisionId}, ${revision.providerModifiedAt},
            ${revision.deleted}, ${revision.fieldsSha256},
            ${revision.recordSha256}, ${revision}::JSONB,
            ${revision.sourceKind}, ${revision.observedAt},
            ${revision.receivedAt}, ${revision.replayIdSha256}
          ) ON CONFLICT DO NOTHING
          RETURNING revision_id
        `;
        inserted += insertedRows.length;
        const headRows = await sql`
          SELECT record_snapshot FROM omni_salesforce_record_heads
          WHERE tenant_id = ${revision.tenantId}
            AND workspace_id = ${revision.workspaceId}
            AND connection_id = ${revision.connectionId}
            AND object_type = ${revision.objectType}
            AND external_id = ${revision.externalId}
          FOR UPDATE
        `;
        const current = headRows[0]
          ? salesforceRecordRevisionSchema.parse(headRows[0].record_snapshot)
          : undefined;
        const resolution = resolveSalesforceHead(current, revision);
        if (resolution.outcome === "duplicate") duplicate += 1;
        else if (resolution.outcome === "stale") stale += 1;
        else if (resolution.conflict) conflicts += 1;
        if (resolution.head.revisionId === revision.revisionId &&
            resolution.outcome !== "duplicate") {
          advanced += 1;
          advancedRecords.push(revision);
          await sql`
            INSERT INTO omni_salesforce_record_heads (
              tenant_id, workspace_id, connection_id, owner_actor_id,
              organization_id_sha256, object_type, external_id,
              account_external_id, current_revision_id, provider_modified_at,
              deleted, record_sha256, record_snapshot, conflict_count,
              projection_status, projection_error_code, projected_at, updated_at
            ) VALUES (
              ${revision.tenantId}, ${revision.workspaceId},
              ${revision.connectionId}, ${input.authority.canonicalActorId},
              ${revision.organizationIdSha256}, ${revision.objectType},
              ${revision.externalId}, ${revision.accountExternalId},
              ${revision.revisionId}, ${revision.providerModifiedAt},
              ${revision.deleted}, ${revision.recordSha256}, ${revision}::JSONB,
              ${resolution.conflict ? 1 : 0}, 'pending', NULL, NULL, ${receivedAt}
            )
            ON CONFLICT (tenant_id, workspace_id, connection_id, object_type, external_id)
            DO UPDATE SET
              account_external_id = EXCLUDED.account_external_id,
              current_revision_id = EXCLUDED.current_revision_id,
              provider_modified_at = EXCLUDED.provider_modified_at,
              deleted = EXCLUDED.deleted,
              record_sha256 = EXCLUDED.record_sha256,
              record_snapshot = EXCLUDED.record_snapshot,
              conflict_count = omni_salesforce_record_heads.conflict_count +
                ${resolution.conflict ? 1 : 0},
              projection_status = 'pending',
              projection_error_code = NULL,
              projected_at = NULL,
              updated_at = EXCLUDED.updated_at
          `;
        }
        if (resolution.conflict) {
          await insertReconciliationFinding(sql, {
            authority: input.authority,
            connectionId: input.connection.connectionId,
            objectType: revision.objectType,
            externalId: revision.externalId,
            localRevisionId: current?.revisionId || null,
            remoteRevisionId: revision.revisionId,
            findingKind: "concurrent_revision",
            observedAt: receivedAt,
          });
        }
      }
      const status = input.healthy ? "healthy" :
        Object.values(cursor.objects).some((item) =>
          item.phase === "pending" || item.phase === "backfill"
        ) ? "backfilling" : "syncing";
      const updatedRows = await sql`
        UPDATE omni_salesforce_connections
        SET sync_cursor = ${cursor}::JSONB,
            sync_status = ${status},
            sync_error = NULL,
            last_successful_sync_at = CASE
              WHEN ${input.healthy} THEN ${receivedAt}::TIMESTAMPTZ
              ELSE last_successful_sync_at
            END,
            sync_lease_owner_id = CASE
              WHEN ${input.releaseLease} THEN NULL ELSE sync_lease_owner_id END,
            sync_lease_expires_at = CASE
              WHEN ${input.releaseLease} THEN NULL ELSE sync_lease_expires_at END,
            updated_at = ${receivedAt}
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connection.connectionId}
          AND sync_lease_owner_id = ${input.lease.ownerId}
          AND sync_lease_generation = ${input.lease.generation}
        RETURNING *
      `;
      if (!updatedRows[0]) {
        throw new SalesforceConnectionConflictError(
          "Salesforce sync lost its lease while settling a page.",
        );
      }
      await appendScopedDomainEvent({
        id: `salesforce-page-settled:${canonicalJsonSha256({
          connectionId: input.connection.connectionId,
          cursor,
          recordIds: input.observations.map((item) =>
            `${item.objectType}:${item.externalId}:${item.providerModifiedAt}`
          ),
        })}`,
        streamId: input.connection.connectionId,
        type: "customer.salesforce.sync.page_settled",
        executionScope: input.authority.executionScope,
        payload: {
          schemaVersion: 1,
          connectionId: input.connection.connectionId,
          inserted,
          advanced,
          stale,
          duplicate,
          conflicts,
          released: input.releaseLease,
          healthy: input.healthy,
          cursorSha256: canonicalJsonSha256(cursor),
        },
      }, { sql });
      return {
        connection: connectionFromRow(updatedRows[0]),
        advancedRecords: Object.freeze(advancedRecords),
        inserted,
        advanced,
        stale,
        duplicate,
        conflicts,
      };
    }) as Promise<{
      connection: SalesforceConnection;
      advancedRecords: readonly SalesforceRecordRevision[];
      inserted: number;
      advanced: number;
      stale: number;
      duplicate: number;
      conflicts: number;
    }>,
  );
}

export async function failSalesforceSync(input: {
  authority: SalesforceMutationAuthority;
  connectionId: string;
  lease: SalesforceSyncLease;
  error: SalesforceActionableError;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const error = salesforceActionableErrorSchema.parse(input.error);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        UPDATE omni_salesforce_connections
        SET sync_status = 'error', sync_error = ${error}::JSONB,
            sync_lease_owner_id = NULL, sync_lease_expires_at = NULL,
            updated_at = clock_timestamp()
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connectionId}
          AND sync_lease_owner_id = ${input.lease.ownerId}
          AND sync_lease_generation = ${input.lease.generation}
        RETURNING *
      `;
      return rows[0] ? connectionFromRow(rows[0]) : undefined;
    },
  );
}

export async function findSalesforceConnectionByOrganization(
  organizationIdSha256: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope(
    "Resolve a signed Salesforce webhook to its exact tenant and workspace.",
    async () => {
      const rows = await getSql()`
        SELECT * FROM omni_salesforce_connections
        WHERE organization_id_sha256 = ${organizationIdSha256}
          AND connection_state = 'active'
        LIMIT 2
      `;
      if (rows.length > 1) {
        throw new SalesforceConnectionConflictError(
          "Salesforce organization ownership is ambiguous.",
        );
      }
      return rows[0] ? connectionFromRow(rows[0]) : undefined;
    },
  );
}

export async function listDueSalesforceConnectionsForTenant(
  tenantId: string,
  limit = 2,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  return runWithDatabaseSystemScope(
    "Select due read-only Salesforce connections for a tenant schedule.",
    async () => {
      const rows = await getSql()`
        SELECT * FROM omni_salesforce_connections
        WHERE tenant_id = ${tenantId}
          AND connection_state = 'active'
          AND (
            last_successful_sync_at IS NULL
            OR last_successful_sync_at <= clock_timestamp() - INTERVAL '5 minutes'
          )
          AND (
            sync_lease_owner_id IS NULL
            OR sync_lease_expires_at <= clock_timestamp()
          )
        ORDER BY last_successful_sync_at ASC NULLS FIRST, updated_at ASC
        LIMIT ${Math.max(1, Math.min(10, limit))}
      `;
      return Object.freeze(rows.map(connectionFromRow));
    },
  );
}

export async function listPendingSalesforceHeads(
  authority: SalesforceReadAuthority,
  limit = 200,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT record_snapshot
        FROM omni_salesforce_record_heads
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND projection_status IN ('pending', 'error')
        ORDER BY CASE WHEN object_type = 'Account' THEN 0 ELSE 1 END,
          provider_modified_at, object_type, external_id
        LIMIT ${Math.max(1, Math.min(500, limit))}
      `;
      return rows.map((row) =>
        salesforceRecordRevisionSchema.parse(row.record_snapshot)
      );
    },
  );
}

export async function getSalesforceAccountLink(
  authority: SalesforceReadAuthority,
  connectionId: string,
  salesforceAccountId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT customer_account_id, provider_object_id_sha256, linked_at
        FROM omni_salesforce_account_links
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND connection_id = ${connectionId}
          AND salesforce_account_id = ${salesforceAccountId}
        LIMIT 1
      `;
      return rows[0] ? Object.freeze({
        customerAccountId: String(rows[0].customer_account_id),
        providerObjectIdSha256: String(rows[0].provider_object_id_sha256),
        linkedAt: timestamp(rows[0].linked_at),
      }) : undefined;
    },
  );
}

export async function getSalesforceAccountLinkByCustomerAccount(
  authority: SalesforceReadAuthority,
  customerAccountId: string,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  if (!/^customer-account:[a-f0-9]{64}$/.test(customerAccountId)) {
    throw new Error("Customer account identity is invalid.");
  }
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT connection_id, salesforce_account_id,
          provider_object_id_sha256, linked_at
        FROM omni_salesforce_account_links
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND customer_account_id = ${customerAccountId}
        LIMIT 1
      `;
      return rows[0] ? Object.freeze({
        connectionId: String(rows[0].connection_id),
        salesforceAccountId: String(rows[0].salesforce_account_id),
        providerObjectIdSha256: String(rows[0].provider_object_id_sha256),
        linkedAt: timestamp(rows[0].linked_at),
      }) : undefined;
    },
  );
}

export async function prepareSalesforceWriteOperation(input: {
  authority: SalesforceMutationAuthority;
  connection: SalesforceConnection;
  customerAccountId: string;
  operationId: string;
  toolExecutionId: string;
  toolId: SalesforceRecordWriteToolId;
  objectType: SalesforceWriteObject;
  action: "create" | "update";
  providerRecordIdSha256: string | null;
  providerIdempotencyKeySha256: string | null;
  requestSha256: string;
  expectedTargetStateSha256: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      const inserted = await sql`
        INSERT INTO omni_salesforce_write_operations (
          tenant_id, workspace_id, connection_id, owner_actor_id,
          customer_account_id, organization_id_sha256, operation_id,
          tool_execution_id, tool_id, object_type, operation_kind,
          provider_record_id_sha256, provider_idempotency_key_sha256,
          request_sha256, expected_target_state_sha256, operation_state,
          created_at, updated_at
        ) VALUES (
          ${input.authority.tenantId}, ${input.authority.workspaceId},
          ${input.connection.connectionId}, ${input.authority.canonicalActorId},
          ${input.customerAccountId}, ${input.connection.organizationIdSha256},
          ${input.operationId}, ${input.toolExecutionId}, ${input.toolId},
          ${input.objectType}, ${input.action}, ${input.providerRecordIdSha256},
          ${input.providerIdempotencyKeySha256}, ${input.requestSha256},
          ${input.expectedTargetStateSha256}, 'prepared', clock_timestamp(),
          clock_timestamp()
        ) ON CONFLICT DO NOTHING
        RETURNING *
      `;
      const rows = inserted[0] ? inserted : await sql`
        SELECT * FROM omni_salesforce_write_operations
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connection.connectionId}
          AND operation_id = ${input.operationId}
        LIMIT 1
      `;
      if (!rows[0]) {
        throw new SalesforceConnectionConflictError(
          "Salesforce write idempotency key belongs to another operation.",
        );
      }
      const operation = salesforceWriteOperationFromRow(rows[0]);
      if (operation.toolExecutionId !== input.toolExecutionId ||
          operation.toolId !== input.toolId ||
          operation.customerAccountId !== input.customerAccountId ||
          operation.requestSha256 !== input.requestSha256 ||
          operation.expectedTargetStateSha256 !== input.expectedTargetStateSha256) {
        throw new SalesforceConnectionConflictError(
          "Salesforce write idempotency key was reused for different content.",
        );
      }
      if (inserted[0]) {
        await appendScopedDomainEvent({
          id: `salesforce-write-prepared:${input.operationId}`,
          streamId: input.connection.connectionId,
          type: "customer.salesforce.write.prepared",
          executionScope: input.authority.executionScope,
          payload: {
            schemaVersion: 1,
            operationId: input.operationId,
            toolId: input.toolId,
            customerAccountId: input.customerAccountId,
            objectType: input.objectType,
            action: input.action,
            requestSha256: input.requestSha256,
            expectedTargetStateSha256: input.expectedTargetStateSha256,
          },
        }, { sql });
      }
      return operation;
    }) as Promise<SalesforceWriteOperation>,
  );
}

export async function beginSalesforceWriteAttempt(input: {
  authority: SalesforceMutationAuthority;
  connectionId: string;
  operationId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        UPDATE omni_salesforce_write_operations
        SET attempt_count = attempt_count + 1,
            last_attempt_at = clock_timestamp(),
            updated_at = clock_timestamp()
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connectionId}
          AND operation_id = ${input.operationId}
          AND operation_state = 'prepared'
        RETURNING *
      `;
      return rows[0] ? salesforceWriteOperationFromRow(rows[0]) : undefined;
    },
  );
}

export async function settleSalesforceWriteOperation(input: {
  authority: SalesforceMutationAuthority;
  connectionId: string;
  commit: SalesforceWriteCommit;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  const commit = salesforceWriteCommitSchema.parse(input.commit);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      const currentRows = await sql`
        SELECT * FROM omni_salesforce_write_operations
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connectionId}
          AND operation_id = ${commit.operationId}
        FOR UPDATE
      `;
      if (!currentRows[0]) {
        throw new SalesforceConnectionConflictError(
          "Salesforce write operation was not prepared.",
        );
      }
      const current = salesforceWriteOperationFromRow(currentRows[0]);
      if (current.expectedTargetStateSha256 !== commit.expectedTargetStateSha256 ||
          current.toolId !== commit.toolId ||
          current.objectType !== commit.objectType ||
          current.action !== commit.action) {
        throw new SalesforceConnectionConflictError(
          "Salesforce write receipt does not match its prepared operation.",
        );
      }
      if (current.state !== "prepared") return current;
      const rows = await sql`
        UPDATE omni_salesforce_write_operations
        SET provider_record_id_sha256 = ${commit.providerRecordIdSha256},
            operation_state = ${commit.verificationState === "verified" ? "verified" : "failed"},
            provider_acknowledgement_sha256 = ${commit.providerAcknowledgementSha256},
            observed_target_state_sha256 = ${commit.observedTargetStateSha256},
            verification_reason_code = ${commit.verificationReasonCode},
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connectionId}
          AND operation_id = ${commit.operationId}
          AND operation_state = 'prepared'
        RETURNING *
      `;
      if (!rows[0]) {
        throw new SalesforceConnectionConflictError(
          "Salesforce write operation changed before its receipt settled.",
        );
      }
      const settled = salesforceWriteOperationFromRow(rows[0]);
      await appendScopedDomainEvent({
        id: `salesforce-write-${settled.state}:${commit.operationId}`,
        streamId: input.connectionId,
        type: `customer.salesforce.write.${settled.state}`,
        executionScope: input.authority.executionScope,
        payload: {
          schemaVersion: 1,
          operationId: commit.operationId,
          toolId: commit.toolId,
          objectType: commit.objectType,
          action: commit.action,
          providerRecordIdSha256: commit.providerRecordIdSha256,
          providerAcknowledgementSha256: commit.providerAcknowledgementSha256,
          expectedTargetStateSha256: commit.expectedTargetStateSha256,
          observedTargetStateSha256: commit.observedTargetStateSha256,
          verificationReasonCode: commit.verificationReasonCode,
        },
      }, { sql });
      return settled;
    }) as Promise<SalesforceWriteOperation>,
  );
}

export async function listSalesforceWriteOperations(
  authority: SalesforceReadAuthority,
  customerAccountId?: string,
  limit = 50,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT * FROM omni_salesforce_write_operations
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
          AND (${customerAccountId || null}::TEXT IS NULL
            OR customer_account_id = ${customerAccountId || null})
        ORDER BY created_at DESC, operation_id
        LIMIT ${Math.max(1, Math.min(200, limit))}
      `;
      return Object.freeze(rows.map(salesforceWriteOperationFromRow));
    },
  );
}

export async function linkSalesforceAccount(input: {
  authority: SalesforceMutationAuthority;
  connection: SalesforceConnection;
  salesforceAccountId: string;
  customerAccountId: string;
  providerObjectIdSha256: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      await sql`
        INSERT INTO omni_salesforce_account_links (
          tenant_id, workspace_id, connection_id, owner_actor_id,
          organization_id_sha256, salesforce_account_id, customer_account_id,
          provider_object_id_sha256, linked_at
        ) VALUES (
          ${input.authority.tenantId}, ${input.authority.workspaceId},
          ${input.connection.connectionId}, ${input.authority.canonicalActorId},
          ${input.connection.organizationIdSha256},
          ${input.salesforceAccountId}, ${input.customerAccountId},
          ${input.providerObjectIdSha256}, clock_timestamp()
        ) ON CONFLICT DO NOTHING
      `;
      const rows = await sql`
        SELECT customer_account_id, provider_object_id_sha256, linked_at
        FROM omni_salesforce_account_links
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connection.connectionId}
          AND salesforce_account_id = ${input.salesforceAccountId}
        LIMIT 1
      `;
      if (!rows[0] || rows[0].customer_account_id !== input.customerAccountId ||
          rows[0].provider_object_id_sha256 !== input.providerObjectIdSha256) {
        throw new SalesforceConnectionConflictError(
          "Salesforce account is already linked to a different Account 360.",
        );
      }
      return Object.freeze({
        customerAccountId: String(rows[0].customer_account_id),
        providerObjectIdSha256: String(rows[0].provider_object_id_sha256),
        linkedAt: timestamp(rows[0].linked_at),
      });
    }) as Promise<Readonly<{
      customerAccountId: string;
      providerObjectIdSha256: string;
      linkedAt: string;
    }>>,
  );
}

export async function settleSalesforceWebhookObservation(input: {
  authority: SalesforceMutationAuthority;
  connection: SalesforceConnection;
  eventKeySha256: string;
  eventSha256: string;
  replayIdSha256: string;
  observation: SalesforceRecordObservation;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  if (![input.eventKeySha256, input.eventSha256, input.replayIdSha256]
    .every((value) => /^[a-f0-9]{64}$/.test(value))) {
    throw new Error("Salesforce webhook digests are invalid.");
  }
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      const connectionRows = await sql`
        SELECT * FROM omni_salesforce_connections
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connection.connectionId}
          AND connection_state = 'active'
        FOR UPDATE
      `;
      if (!connectionRows[0]) throw new SalesforceConnectionNotFoundError();
      const clock = await sql`SELECT clock_timestamp() AS now`;
      const receivedAt = timestamp(clock[0]?.now);
      const eventRows = await sql`
        INSERT INTO omni_salesforce_webhook_events (
          tenant_id, workspace_id, connection_id, owner_actor_id,
          organization_id_sha256, event_key_sha256, replay_id_sha256,
          event_sha256, object_type, external_id, received_at
        ) VALUES (
          ${input.authority.tenantId}, ${input.authority.workspaceId},
          ${input.connection.connectionId}, ${input.authority.canonicalActorId},
          ${input.connection.organizationIdSha256}, ${input.eventKeySha256},
          ${input.replayIdSha256}, ${input.eventSha256},
          ${input.observation.objectType}, ${input.observation.externalId},
          ${receivedAt}
        ) ON CONFLICT DO NOTHING
        RETURNING event_key_sha256
      `;
      if (!eventRows[0]) return { status: "duplicate" as const };
      const revision = buildSalesforceRecordRevision({
        tenantId: input.authority.tenantId,
        workspaceId: input.authority.workspaceId,
        connectionId: input.connection.connectionId,
        organizationIdSha256: input.connection.organizationIdSha256,
        observation: input.observation,
        receivedAt,
      });
      await sql`
        INSERT INTO omni_salesforce_record_revisions (
          tenant_id, workspace_id, connection_id, owner_actor_id,
          organization_id_sha256, object_type, external_id,
          account_external_id, revision_id, provider_modified_at, deleted,
          fields_sha256, record_sha256, record_snapshot, source_kind,
          observed_at, received_at, replay_id_sha256
        ) VALUES (
          ${revision.tenantId}, ${revision.workspaceId},
          ${revision.connectionId}, ${input.authority.canonicalActorId},
          ${revision.organizationIdSha256}, ${revision.objectType},
          ${revision.externalId}, ${revision.accountExternalId},
          ${revision.revisionId}, ${revision.providerModifiedAt},
          ${revision.deleted}, ${revision.fieldsSha256},
          ${revision.recordSha256}, ${revision}::JSONB,
          ${revision.sourceKind}, ${revision.observedAt},
          ${revision.receivedAt}, ${revision.replayIdSha256}
        ) ON CONFLICT DO NOTHING
      `;
      const headRows = await sql`
        SELECT record_snapshot FROM omni_salesforce_record_heads
        WHERE tenant_id = ${revision.tenantId}
          AND workspace_id = ${revision.workspaceId}
          AND connection_id = ${revision.connectionId}
          AND object_type = ${revision.objectType}
          AND external_id = ${revision.externalId}
        FOR UPDATE
      `;
      const current = headRows[0]
        ? salesforceRecordRevisionSchema.parse(headRows[0].record_snapshot)
        : undefined;
      const resolution = resolveSalesforceHead(current, revision);
      const advances = resolution.head.revisionId === revision.revisionId &&
        resolution.outcome !== "duplicate";
      if (advances) {
        await sql`
          INSERT INTO omni_salesforce_record_heads (
            tenant_id, workspace_id, connection_id, owner_actor_id,
            organization_id_sha256, object_type, external_id,
            account_external_id, current_revision_id, provider_modified_at,
            deleted, record_sha256, record_snapshot, conflict_count,
            projection_status, projection_error_code, projected_at, updated_at
          ) VALUES (
            ${revision.tenantId}, ${revision.workspaceId},
            ${revision.connectionId}, ${input.authority.canonicalActorId},
            ${revision.organizationIdSha256}, ${revision.objectType},
            ${revision.externalId}, ${revision.accountExternalId},
            ${revision.revisionId}, ${revision.providerModifiedAt},
            ${revision.deleted}, ${revision.recordSha256}, ${revision}::JSONB,
            ${resolution.conflict ? 1 : 0}, 'pending', NULL, NULL, ${receivedAt}
          ) ON CONFLICT (
            tenant_id, workspace_id, connection_id, object_type, external_id
          ) DO UPDATE SET
            account_external_id = EXCLUDED.account_external_id,
            current_revision_id = EXCLUDED.current_revision_id,
            provider_modified_at = EXCLUDED.provider_modified_at,
            deleted = EXCLUDED.deleted,
            record_sha256 = EXCLUDED.record_sha256,
            record_snapshot = EXCLUDED.record_snapshot,
            conflict_count = omni_salesforce_record_heads.conflict_count +
              ${resolution.conflict ? 1 : 0},
            projection_status = 'pending', projection_error_code = NULL,
            projected_at = NULL, updated_at = EXCLUDED.updated_at
        `;
      }
      if (resolution.conflict) {
        await insertReconciliationFinding(sql, {
          authority: input.authority,
          connectionId: input.connection.connectionId,
          objectType: revision.objectType,
          externalId: revision.externalId,
          localRevisionId: current?.revisionId || null,
          remoteRevisionId: revision.revisionId,
          findingKind: "concurrent_revision",
          observedAt: receivedAt,
        });
      }
      await sql`
        UPDATE omni_salesforce_connections
        SET last_webhook_at = ${receivedAt},
            last_replay_id_sha256 = ${input.replayIdSha256},
            updated_at = ${receivedAt}
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.connection.connectionId}
      `;
      await appendScopedDomainEvent({
        id: `salesforce-webhook-settled:${input.eventKeySha256}`,
        streamId: input.connection.connectionId,
        type: "customer.salesforce.webhook.settled",
        executionScope: input.authority.executionScope,
        payload: {
          schemaVersion: 1,
          connectionId: input.connection.connectionId,
          eventKeySha256: input.eventKeySha256,
          replayIdSha256: input.replayIdSha256,
          objectType: revision.objectType,
          revisionId: revision.revisionId,
          outcome: resolution.outcome,
        },
      }, { sql });
      return {
        status: "settled" as const,
        outcome: resolution.outcome,
        advancedRecord: advances ? revision : undefined,
      };
    }) as Promise<
      | { status: "duplicate" }
      | {
          status: "settled";
          outcome: ReturnType<typeof resolveSalesforceHead>["outcome"];
          advancedRecord?: SalesforceRecordRevision;
        }
    >,
  );
}

export async function listCurrentSalesforceHeads(
  authority: SalesforceReadAuthority,
  limit = 200,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT record_snapshot FROM omni_salesforce_record_heads
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
        ORDER BY provider_modified_at DESC, object_type, external_id
        LIMIT ${Math.max(1, Math.min(500, limit))}
      `;
      return Object.freeze(rows.map((row) =>
        salesforceRecordRevisionSchema.parse(row.record_snapshot)
      ));
    },
  );
}

export async function recordSalesforceReconciliationFinding(input: {
  authority: SalesforceMutationAuthority;
  connectionId: string;
  objectType: string;
  externalId: string;
  localRevisionId: string | null;
  remoteRevisionId: string | null;
  findingKind: "missing_local" | "missing_remote" | "revision_mismatch" | "concurrent_revision";
  observedAt: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    () => getSql().transaction(async (sql: SalesforceSql) => {
      await insertReconciliationFinding(sql, input);
      return true;
    }) as Promise<boolean>,
  );
}

export async function listSalesforceReconciliationFindings(
  authority: SalesforceReadAuthority,
  limit = 100,
) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertReadAuthority(authority);
  return runWithDatabaseActorScope(
    authority.tenantId,
    authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        SELECT finding_id, object_type, external_id_sha256,
          local_revision_id, remote_revision_id, finding_kind,
          finding_sha256, observed_at
        FROM omni_salesforce_reconciliation_findings
        WHERE tenant_id = ${authority.tenantId}
          AND workspace_id = ${authority.workspaceId}
        ORDER BY observed_at DESC, finding_id
        LIMIT ${Math.max(1, Math.min(500, limit))}
      `;
      return Object.freeze(rows.map((row) => Object.freeze({
        findingId: String(row.finding_id),
        objectType: String(row.object_type),
        externalIdSha256: String(row.external_id_sha256),
        localRevisionId: row.local_revision_id ? String(row.local_revision_id) : null,
        remoteRevisionId: row.remote_revision_id ? String(row.remote_revision_id) : null,
        findingKind: String(row.finding_kind),
        findingSha256: String(row.finding_sha256),
        observedAt: timestamp(row.observed_at),
      })));
    },
  );
}

export async function revokeSalesforceConnection(input: {
  authority: SalesforceMutationAuthority;
  oauthGrantId: string;
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        UPDATE omni_salesforce_connections
        SET connection_state = 'revoked', sync_status = 'idle',
            sync_error = NULL, sync_lease_owner_id = NULL,
            sync_lease_expires_at = NULL, updated_at = clock_timestamp()
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND owner_actor_id = ${input.authority.canonicalActorId}
          AND oauth_grant_id = ${input.oauthGrantId}
        RETURNING connection_id
      `;
      return rows.length === 1;
    },
  );
}

export async function markSalesforceHeadProjection(input: {
  authority: SalesforceMutationAuthority;
  record: SalesforceRecordRevision;
  status: "projected" | "held" | "error";
  errorCode?: "account_missing" | "account_conflict" | "permission_denied" | "invalid_record" | "internal_error";
}) {
  requireDatabase();
  await ensureDatabaseSchema();
  assertMutationAuthority(input.authority);
  if ((input.status === "error") !== Boolean(input.errorCode)) {
    throw new Error("Salesforce projection errors require an exact error code.");
  }
  return runWithDatabaseActorScope(
    input.authority.tenantId,
    input.authority.readableActorIds,
    async () => {
      const rows = await getSql()`
        UPDATE omni_salesforce_record_heads
        SET projection_status = ${input.status},
            projection_error_code = ${input.errorCode || null},
            projected_at = CASE WHEN ${input.status} = 'projected'
              THEN clock_timestamp() ELSE NULL END,
            updated_at = clock_timestamp()
        WHERE tenant_id = ${input.authority.tenantId}
          AND workspace_id = ${input.authority.workspaceId}
          AND connection_id = ${input.record.connectionId}
          AND object_type = ${input.record.objectType}
          AND external_id = ${input.record.externalId}
          AND current_revision_id = ${input.record.revisionId}
        RETURNING current_revision_id
      `;
      return rows.length === 1;
    },
  );
}

async function insertReconciliationFinding(
  sql: SalesforceSql,
  input: {
    authority: SalesforceMutationAuthority;
    connectionId: string;
    objectType: string;
    externalId: string;
    localRevisionId: string | null;
    remoteRevisionId: string | null;
    findingKind: "missing_local" | "missing_remote" | "revision_mismatch" | "concurrent_revision";
    observedAt: string;
  },
) {
  const body = {
    connectionId: input.connectionId,
    objectType: input.objectType,
    externalIdSha256: canonicalJsonSha256(input.externalId),
    localRevisionId: input.localRevisionId,
    remoteRevisionId: input.remoteRevisionId,
    findingKind: input.findingKind,
    observedAt: input.observedAt,
  };
  const findingSha256 = canonicalJsonSha256(body);
  await sql`
    INSERT INTO omni_salesforce_reconciliation_findings (
      tenant_id, workspace_id, connection_id, owner_actor_id, finding_id,
      object_type, external_id_sha256, local_revision_id, remote_revision_id,
      finding_kind, finding_sha256, observed_at
    ) VALUES (
      ${input.authority.tenantId}, ${input.authority.workspaceId},
      ${input.connectionId}, ${input.authority.canonicalActorId},
      ${`salesforce-finding:${findingSha256}`}, ${input.objectType},
      ${body.externalIdSha256}, ${input.localRevisionId},
      ${input.remoteRevisionId}, ${input.findingKind}, ${findingSha256},
      ${input.observedAt}
    ) ON CONFLICT DO NOTHING
  `;
}

function connectionFromRow(row: Record<string, unknown>): SalesforceConnection {
  return Object.freeze({
    connectionId: String(row.connection_id),
    tenantId: String(row.tenant_id),
    workspaceId: String(row.workspace_id),
    ownerActorId: String(row.owner_actor_id),
    oauthGrantId: String(row.oauth_grant_id),
    authorizationGeneration: Number(row.authorization_generation),
    organizationIdSha256: String(row.organization_id_sha256),
    instanceOrigin: String(row.instance_origin),
    connectionState: String(row.connection_state) as SalesforceConnection["connectionState"],
    cursor: salesforceSyncCursorSchema.parse(row.sync_cursor),
    syncStatus: String(row.sync_status) as SalesforceConnection["syncStatus"],
    syncError: row.sync_error
      ? salesforceActionableErrorSchema.parse(row.sync_error)
      : null,
    lastSuccessfulSyncAt: row.last_successful_sync_at
      ? timestamp(row.last_successful_sync_at)
      : null,
    lastWebhookAt: row.last_webhook_at ? timestamp(row.last_webhook_at) : null,
    lastReplayIdSha256: row.last_replay_id_sha256
      ? String(row.last_replay_id_sha256)
      : null,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function salesforceWriteOperationFromRow(
  row: Record<string, unknown>,
): SalesforceWriteOperation {
  return Object.freeze({
    operationId: String(row.operation_id),
    toolExecutionId: String(row.tool_execution_id),
    toolId: String(row.tool_id) as SalesforceRecordWriteToolId,
    objectType: String(row.object_type) as SalesforceWriteObject,
    action: String(row.operation_kind) as "create" | "update",
    customerAccountId: String(row.customer_account_id),
    providerRecordIdSha256: row.provider_record_id_sha256
      ? String(row.provider_record_id_sha256)
      : null,
    requestSha256: String(row.request_sha256),
    expectedTargetStateSha256: String(row.expected_target_state_sha256),
    state: String(row.operation_state) as SalesforceWriteOperation["state"],
    providerAcknowledgementSha256: row.provider_acknowledgement_sha256
      ? String(row.provider_acknowledgement_sha256)
      : null,
    observedTargetStateSha256: row.observed_target_state_sha256
      ? String(row.observed_target_state_sha256)
      : null,
    verificationReasonCode: row.verification_reason_code
      ? String(row.verification_reason_code) as SalesforceWriteOperation["verificationReasonCode"]
      : null,
    attemptCount: Number(row.attempt_count),
    lastAttemptAt: row.last_attempt_at ? timestamp(row.last_attempt_at) : null,
    completedAt: row.completed_at ? timestamp(row.completed_at) : null,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  });
}

function salesforceTokenIdentity(tokens: Record<string, unknown>) {
  if (!isSalesforceInstanceUrl(tokens.instance_url)) {
    throw new SalesforceConnectionConflictError(
      "Salesforce returned an invalid instance authority.",
    );
  }
  const identityUrl = typeof tokens.id === "string" ? tokens.id : "";
  let organizationId = "";
  try {
    const url = new URL(identityUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (!isSalesforceInstanceUrl(url.origin) || parts.at(-3) !== "id") {
      throw new Error("Invalid identity URL.");
    }
    organizationId = parts.at(-2) || "";
  } catch {
    throw new SalesforceConnectionConflictError(
      "Salesforce organization identity is missing or invalid.",
    );
  }
  if (!/^[A-Za-z0-9]{15,18}$/.test(organizationId)) {
    throw new SalesforceConnectionConflictError(
      "Salesforce organization identity is missing or invalid.",
    );
  }
  return {
    organizationIdSha256: salesforceOrganizationIdSha256(organizationId),
    instanceOrigin: new URL(String(tokens.instance_url)).origin,
  };
}

function latestWatermark(cursor: SalesforceSyncCursor | undefined) {
  if (!cursor) return undefined;
  return Object.values(cursor.objects)
    .map((item) => item.watermarkAt)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(0);
}

function assertReadAuthority(authority: SalesforceReadAuthority) {
  if (!authority.tenantId || !authority.workspaceId || !authority.canonicalActorId ||
      !authority.readableActorIds.includes(authority.canonicalActorId)) {
    throw new Error("Salesforce read authority is invalid.");
  }
}

function assertMutationAuthority(authority: SalesforceMutationAuthority) {
  assertReadAuthority(authority);
  const scope = parsePersistedExecutionScope(authority.executionScope);
  if (!scope || scope.tenantId !== authority.tenantId ||
      scope.workspaceId !== authority.workspaceId ||
      scope.initiatingActorId !== authority.canonicalActorId) {
    throw new Error("Salesforce execution scope is invalid.");
  }
}

function timestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Database timestamp is invalid.");
  }
  return date.toISOString();
}

function requireDatabase() {
  if (!hasDatabaseUrl()) {
    throw new Error("Salesforce synchronization requires the canonical database.");
  }
}
