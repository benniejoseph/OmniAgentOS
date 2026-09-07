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
        cursor.objects.Account.phase === "pending" ? "backfilling" : "syncing";
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
    organizationIdSha256: canonicalJsonSha256({
      provider: "salesforce",
      organizationId,
    }),
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
