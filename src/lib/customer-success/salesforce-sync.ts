import {
  SalesforceProviderError,
  fetchSalesforcePage,
  fetchSalesforceRecord,
} from "@/lib/customer-success/salesforce-adapter";
import {
  SALESFORCE_OBJECT_TYPES,
  buildSalesforceRecordRevision,
  salesforceSyncCursorSchema,
  type SalesforceObjectType,
} from "@/lib/customer-success/salesforce-contracts";
import { projectPendingSalesforceRecords } from "@/lib/customer-success/salesforce-projection";
import {
  claimSalesforceSyncLease,
  failSalesforceSync,
  listDueSalesforceConnectionsForTenant,
  listCurrentSalesforceHeads,
  recordSalesforceReconciliationFinding,
  settleSalesforceSyncPage,
  type SalesforceMutationAuthority,
} from "@/lib/customer-success/salesforce-store";
import { createExecutionScope } from "@/lib/security/execution-scope";

export async function syncSalesforceWorkspace(input: {
  authority: SalesforceMutationAuthority;
  abortSignal?: AbortSignal;
  maxPages?: number;
}) {
  const claim = await claimSalesforceSyncLease(input.authority);
  if (claim.status === "busy") {
    return Object.freeze({
      status: "busy" as const,
      pages: 0,
      records: 0,
      advanced: 0,
      conflicts: 0,
      projection: null,
    });
  }
  let { connection } = claim;
  const { lease } = claim;
  const cursor = salesforceSyncCursorSchema.parse(
    structuredClone(connection.cursor),
  );
  const maxPages = Math.max(1, Math.min(64, input.maxPages || 24));
  let pages = 0;
  let records = 0;
  let advanced = 0;
  let conflicts = 0;
  try {
    for (const objectType of SALESFORCE_OBJECT_TYPES) {
      while (pages < maxPages) {
        if (input.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
        const objectCursor = cursor.objects[objectType];
        if (objectCursor.phase === "pending") {
          objectCursor.phase = "backfill";
          objectCursor.upperBoundAt = new Date().toISOString();
        } else if (objectCursor.phase === "current" && !objectCursor.nextRecordsPath) {
          objectCursor.phase = "delta";
          objectCursor.upperBoundAt = new Date().toISOString();
        }
        const page = await fetchSalesforcePage({
          connection,
          objectType,
          cursor: objectCursor,
          abortSignal: input.abortSignal,
        });
        pages += 1;
        records += page.observations.length;
        objectCursor.pagesSettled += 1;
        objectCursor.recordsSettled += page.observations.length;
        objectCursor.nextRecordsPath = page.nextRecordsPath;
        objectCursor.upperBoundAt = page.upperBoundAt;
        const last = lastObservation(page.observations);
        if (last) {
          objectCursor.watermarkAt = last.providerModifiedAt;
          objectCursor.watermarkExternalId = last.externalId;
        }
        if (page.done) {
          objectCursor.phase = "current";
          objectCursor.nextRecordsPath = null;
          objectCursor.watermarkAt = page.upperBoundAt;
          objectCursor.watermarkExternalId = null;
          objectCursor.upperBoundAt = null;
        }
        const settled = await settleSalesforceSyncPage({
          authority: input.authority,
          connection,
          lease,
          observations: page.observations,
          cursor,
          releaseLease: false,
          healthy: false,
        });
        connection = settled.connection;
        advanced += settled.advanced;
        conflicts += settled.conflicts;
        if (page.done) break;
      }
      if (pages >= maxPages) break;
    }
    const healthy = SALESFORCE_OBJECT_TYPES.every((objectType) => {
      const item = cursor.objects[objectType];
      return item.phase === "current" && item.nextRecordsPath === null;
    });
    const released = await settleSalesforceSyncPage({
      authority: input.authority,
      connection,
      lease,
      observations: [],
      cursor,
      releaseLease: true,
      healthy,
    });
    connection = released.connection;
    const projection = await projectPendingSalesforceRecords({
      authority: input.authority,
      connection,
      limit: 500,
    });
    return Object.freeze({
      status: healthy ? "healthy" as const : "partial" as const,
      pages,
      records,
      advanced,
      conflicts,
      projection,
    });
  } catch (error) {
    const actionableError = error instanceof SalesforceProviderError
      ? error.actionableError
      : {
          code: "internal_error" as const,
          message: error instanceof DOMException && error.name === "AbortError"
            ? "Salesforce synchronization was interrupted and can be resumed safely."
            : "Salesforce synchronization failed internally and can be retried safely.",
          action: "retry" as const,
          occurredAt: new Date().toISOString(),
        };
    await failSalesforceSync({
      authority: input.authority,
      connectionId: connection.connectionId,
      lease,
      error: actionableError,
    }).catch(() => undefined);
    throw error;
  }
}

export async function reconcileSalesforceWorkspace(input: {
  authority: SalesforceMutationAuthority;
  abortSignal?: AbortSignal;
  limit?: number;
}) {
  const claim = await claimSalesforceSyncLease(input.authority);
  if (claim.status === "busy") {
    return Object.freeze({ status: "busy" as const, checked: 0, findings: 0 });
  }
  const { connection, lease } = claim;
  const heads = await listCurrentSalesforceHeads(
    input.authority,
    Math.max(1, Math.min(50, input.limit || 25)),
  );
  let checked = 0;
  let findings = 0;
  try {
    for (const local of heads) {
      if (input.abortSignal?.aborted) throw new DOMException("Aborted", "AbortError");
      checked += 1;
      const observation = await fetchSalesforceRecord({
        connection,
        objectType: local.objectType,
        externalId: local.externalId,
        sourceKind: "reconciliation",
        abortSignal: input.abortSignal,
      });
      if (!observation) {
        if (!local.deleted) {
          await recordSalesforceReconciliationFinding({
            authority: input.authority,
            connectionId: connection.connectionId,
            objectType: local.objectType,
            externalId: local.externalId,
            localRevisionId: local.revisionId,
            remoteRevisionId: null,
            findingKind: "missing_remote",
            observedAt: new Date().toISOString(),
          });
          findings += 1;
        }
        continue;
      }
      const remote = buildSalesforceRecordRevision({
        tenantId: connection.tenantId,
        workspaceId: connection.workspaceId,
        connectionId: connection.connectionId,
        organizationIdSha256: connection.organizationIdSha256,
        observation,
        receivedAt: new Date().toISOString(),
      });
      if (remote.revisionId !== local.revisionId) {
        await recordSalesforceReconciliationFinding({
          authority: input.authority,
          connectionId: connection.connectionId,
          objectType: local.objectType,
          externalId: local.externalId,
          localRevisionId: local.revisionId,
          remoteRevisionId: remote.revisionId,
          findingKind: "revision_mismatch",
          observedAt: new Date().toISOString(),
        });
        findings += 1;
      }
    }
    await settleSalesforceSyncPage({
      authority: input.authority,
      connection,
      lease,
      observations: [],
      cursor: connection.cursor,
      releaseLease: true,
      healthy: connection.syncStatus === "healthy",
    });
    return Object.freeze({ status: "complete" as const, checked, findings });
  } catch (error) {
    await failSalesforceSync({
      authority: input.authority,
      connectionId: connection.connectionId,
      lease,
      error: error instanceof SalesforceProviderError
        ? error.actionableError
        : {
            code: "internal_error",
            message: "Salesforce reconciliation failed internally and can be retried safely.",
            action: "retry",
            occurredAt: new Date().toISOString(),
          },
    }).catch(() => undefined);
    throw error;
  }
}

export async function syncDueSalesforceConnections(input: {
  tenantId: string;
  limit?: number;
}) {
  const connections = await listDueSalesforceConnectionsForTenant(
    input.tenantId,
    input.limit || 2,
  );
  const results: Array<{
    connectionId: string;
    status: "healthy" | "partial" | "busy" | "error";
  }> = [];
  for (const connection of connections) {
    const authority: SalesforceMutationAuthority = {
      tenantId: connection.tenantId,
      workspaceId: connection.workspaceId,
      canonicalActorId: connection.ownerActorId,
      readableActorIds: [connection.ownerActorId],
      executionScope: createExecutionScope({
        tenantId: connection.tenantId,
        initiatingActorId: connection.ownerActorId,
        executingPrincipalType: "system",
        executingPrincipalId: "salesforce:scheduled-sync",
        workspaceId: connection.workspaceId,
        correlationId: `salesforce-scheduled:${connection.connectionId}:${Date.now()}`,
        purpose: "customer.salesforce.scheduled_read_sync",
      }),
    };
    try {
      const result = await syncSalesforceWorkspace({
        authority,
        maxPages: 8,
      });
      results.push({ connectionId: connection.connectionId, status: result.status });
    } catch {
      results.push({ connectionId: connection.connectionId, status: "error" });
    }
  }
  return Object.freeze(results);
}

function lastObservation(
  observations: readonly {
    providerModifiedAt: string;
    externalId: string;
  }[],
) {
  return [...observations].sort((left, right) =>
    left.providerModifiedAt === right.providerModifiedAt
      ? left.externalId.localeCompare(right.externalId)
      : left.providerModifiedAt.localeCompare(right.providerModifiedAt)
  ).at(-1);
}

export function nextSalesforceObjectType(
  objectType: SalesforceObjectType,
) {
  const index = SALESFORCE_OBJECT_TYPES.indexOf(objectType);
  return SALESFORCE_OBJECT_TYPES[index + 1];
}
