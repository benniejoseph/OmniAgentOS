import {
  customerAccountId,
  customerFactId,
  customerFactValueSchema,
  customerMutationId,
  type CustomerFactValue,
} from "@/lib/customer-success/contracts";
import {
  getCustomerAccount360,
  recordCustomerFact,
  saveCustomerAccount,
  type CustomerAccountMutationAuthority,
  type CustomerAccountReadAuthority,
} from "@/lib/customer-success/store";
import type { SalesforceRecordRevision } from "@/lib/customer-success/salesforce-contracts";
import {
  getSalesforceAccountLink,
  linkSalesforceAccount,
  listPendingSalesforceHeads,
  markSalesforceHeadProjection,
  type SalesforceConnection,
  type SalesforceMutationAuthority,
} from "@/lib/customer-success/salesforce-store";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export async function projectPendingSalesforceRecords(input: {
  authority: SalesforceMutationAuthority;
  connection: SalesforceConnection;
  limit?: number;
}) {
  const records = await listPendingSalesforceHeads(
    input.authority,
    input.limit || 200,
  );
  const result = {
    examined: 0,
    projected: 0,
    held: 0,
    failed: 0,
  };
  for (const record of records) {
    result.examined += 1;
    try {
      const status = await projectSalesforceRecord(
        input.authority,
        input.connection,
        record,
      );
      await markSalesforceHeadProjection({
        authority: input.authority,
        record,
        status,
      });
      result[status === "projected" ? "projected" : "held"] += 1;
    } catch (error) {
      const errorCode = projectionErrorCode(error);
      await markSalesforceHeadProjection({
        authority: input.authority,
        record,
        status: "error",
        errorCode,
      }).catch(() => false);
      result.failed += 1;
    }
  }
  return Object.freeze(result);
}

export async function projectSalesforceRecord(
  authority: SalesforceMutationAuthority,
  connection: SalesforceConnection,
  record: SalesforceRecordRevision,
): Promise<"projected" | "held"> {
  if (record.connectionId !== connection.connectionId ||
      record.workspaceId !== authority.workspaceId ||
      record.tenantId !== authority.tenantId ||
      record.organizationIdSha256 !== connection.organizationIdSha256) {
    throw new Error("Salesforce projection scope changed.");
  }
  const accountExternalId = record.objectType === "Account"
    ? record.externalId
    : record.accountExternalId;
  if (!accountExternalId) return "held";
  let link = await getSalesforceAccountLink(
    authority,
    connection.connectionId,
    accountExternalId,
  );
  if (!link && record.objectType === "Account" && !record.deleted) {
    link = await ensureSalesforceAccount(authority, connection, record);
  }
  if (!link) return "held";
  const read = customerReadAuthority(authority);
  const account = await getCustomerAccount360(read, link.customerAccountId);
  if (!account) throw new Error("Salesforce Account 360 link is invalid.");
  const factId = customerFactId({
    accountId: account.account.accountId,
    idempotencyKey: record.providerObjectIdSha256,
  });
  const current = account.facts
    .map((view) => view.fact)
    .find((fact) => fact.factId === factId);
  if (current?.source.sourceRevisionId === record.revisionId) {
    return "projected";
  }
  if (record.deleted && !current) return "projected";
  const value = record.deleted
    ? current!.value
    : salesforceFactValue(record);
  const state = record.deleted ? "retracted" as const : "active" as const;
  const mutation = customerMutationAuthority(
    authority,
    `salesforce-projection:${record.revisionId}`,
  );
  await recordCustomerFact({
    authority: mutation,
    accountId: account.account.accountId,
    factId,
    mutationId: customerMutationId({
      accountId: account.account.accountId,
      idempotencyKey: `salesforce-projection:${record.revisionId}`,
      operation: "fact.record",
    }),
    expectedRevision: current?.revision,
    factKey: `salesforce.${record.objectType.toLowerCase()}.${record.providerObjectIdSha256.slice(0, 32)}`,
    state,
    value,
    source: {
      sourceKind: "crm",
      sourceId: connection.connectionId,
      sourceRevisionId: record.revisionId,
      sourceRevisionSha256: record.recordSha256,
      sourceLabel: `Salesforce ${record.objectType}`,
      providerId: "salesforce",
      providerObjectType: record.objectType,
      providerObjectIdSha256: record.providerObjectIdSha256,
      permissionBasis: "connector_grant",
      allowedPurposeIds: [
        "customer_success.account.read",
        "customer_success.crm_sync",
      ],
      observedAt: record.observedAt,
      ingestedAt: record.receivedAt,
    },
    owner: salesforceOwner(record, authority.canonicalActorId),
    confidenceBasisPoints: record.sourceKind === "reconciliation" ? 10_000 : 9_500,
    validFrom: record.providerModifiedAt,
    validTo: null,
    staleAfter: new Date(
      Date.parse(record.providerModifiedAt) + 7 * 24 * 60 * 60_000,
    ).toISOString(),
  });
  return "projected";
}

async function ensureSalesforceAccount(
  authority: SalesforceMutationAuthority,
  connection: SalesforceConnection,
  record: SalesforceRecordRevision,
) {
  const idempotencyKey = `salesforce-account:${record.organizationIdSha256}:${record.externalId}`;
  const accountId = customerAccountId({
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    idempotencyKey,
  });
  const read = customerReadAuthority(authority);
  let account = await getCustomerAccount360(read, accountId);
  if (!account) {
    try {
      await saveCustomerAccount({
        authority: customerMutationAuthority(authority, idempotencyKey),
        accountId,
        mutationId: customerMutationId({
          accountId,
          idempotencyKey,
          operation: "account.create",
        }),
        name: requiredString(record.fields.Name, "Unnamed Salesforce account", 240),
        lifecycle: "active",
        organizationEntityId: `salesforce-organization:${record.providerObjectIdSha256}`,
        accountOwner: {
          ownerKind: "actor",
          ownerId: authority.canonicalActorId,
          displayName: "Salesforce connection owner",
        },
        crmPermissions: {
          readScope: "workspace_members",
          writeScope: "account_owner",
          externalWriteState: "disabled",
          customerDataPurposeIds: [
            "customer_success.account.manage",
            "customer_success.account.read",
            "customer_success.crm_sync",
          ],
        },
      });
    } catch {
      // A concurrent page or webhook may have created the deterministic account.
    }
    account = await getCustomerAccount360(read, accountId);
    if (!account) throw new Error("Salesforce account could not be projected.");
  }
  return linkSalesforceAccount({
    authority,
    connection,
    salesforceAccountId: record.externalId,
    customerAccountId: account.account.accountId,
    providerObjectIdSha256: record.providerObjectIdSha256,
  });
}

export function salesforceFactValue(
  record: SalesforceRecordRevision,
): CustomerFactValue {
  const fields = record.fields;
  const entityId = `salesforce-${record.objectType.toLowerCase()}:${record.providerObjectIdSha256}`;
  const value: CustomerFactValue = record.objectType === "Account"
    ? {
        kind: "organization",
        entityId,
        name: requiredString(fields.Name, "Unnamed organization", 240),
        industry: optionalString(fields.Industry, 160),
        website: safeUrl(fields.Website),
      }
    : record.objectType === "Contact"
      ? {
          kind: "contact",
          entityId,
          name: requiredString(fields.Name, "Unnamed contact", 240),
          email: safeEmail(fields.Email),
          title: optionalString(fields.Title, 180),
        }
      : record.objectType === "Opportunity"
        ? opportunityValue(entityId, fields)
        : record.objectType === "Case"
          ? {
              kind: "case",
              entityId,
              title: requiredString(fields.Subject, "Untitled Salesforce case", 500),
              status: requiredString(fields.Status, "Unknown", 120),
              severity: caseSeverity(fields.Priority),
            }
          : record.objectType === "Asset"
            ? {
                kind: "product",
                entityId,
                name: requiredString(fields.Name, "Unnamed Salesforce asset", 240),
                status: assetStatus(fields.Status),
                quantity: safeNumber(fields.Quantity),
              }
            : record.objectType === "Contract"
              ? {
                  kind: "renewal",
                  renewalId: entityId,
                  status: renewalStatus(fields.Status),
                  renewalAt: salesforceDate(fields.EndDate, record.providerModifiedAt),
                  amountMinor: null,
                  currency: null,
                }
              : {
                  kind: "interaction",
                  interactionId: entityId,
                  channel: taskChannel(fields.Subject),
                  summary: requiredString(fields.Subject, `Salesforce ${record.objectType}`, 4_000),
                  occurredAt: salesforceDate(
                    fields.StartDateTime || fields.CompletedDateTime || fields.ActivityDate,
                    record.providerModifiedAt,
                  ),
                };
  return customerFactValueSchema.parse(value);
}

function opportunityValue(
  entityId: string,
  fields: SalesforceRecordRevision["fields"],
): CustomerFactValue {
  const amount = safeNumber(fields.Amount);
  const currency = typeof fields.CurrencyIsoCode === "string" &&
      /^[A-Z]{3}$/.test(fields.CurrencyIsoCode)
    ? fields.CurrencyIsoCode
    : null;
  const amountMinor = amount !== null && currency
    ? Math.max(0, Math.round(amount * 100))
    : null;
  return {
    kind: "opportunity",
    entityId,
    name: requiredString(fields.Name, "Unnamed opportunity", 240),
    stage: requiredString(fields.StageName, "Unknown", 120),
    amountMinor,
    currency: amountMinor === null ? null : currency,
    expectedCloseAt: fields.CloseDate
      ? salesforceDate(fields.CloseDate, "1970-01-01T00:00:00.000Z")
      : null,
  };
}

function salesforceOwner(
  record: SalesforceRecordRevision,
  fallbackActorId: string,
) {
  const ownerId = typeof record.fields.OwnerId === "string"
    ? `salesforce-user:${canonicalJsonSha256(record.fields.OwnerId)}`
    : fallbackActorId;
  return {
    ownerKind: typeof record.fields.OwnerId === "string" ? "person" as const : "actor" as const,
    ownerId,
    displayName: typeof record.fields.OwnerId === "string"
      ? "Salesforce record owner"
      : "Salesforce connection owner",
  };
}

function customerReadAuthority(
  authority: SalesforceMutationAuthority,
): CustomerAccountReadAuthority {
  return {
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    readableActorIds: authority.readableActorIds,
    purposeId: "customer_success.account.read",
  };
}

function customerMutationAuthority(
  authority: SalesforceMutationAuthority,
  idempotencyKey: string,
): CustomerAccountMutationAuthority {
  return {
    tenantId: authority.tenantId,
    workspaceId: authority.workspaceId,
    canonicalActorId: authority.canonicalActorId,
    readableActorIds: authority.readableActorIds,
    purposeId: "customer_success.account.manage",
    idempotencyKey,
    executionScope: authority.executionScope,
  };
}

function requiredString(value: unknown, fallback: string, max: number) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return Array.from(candidate || fallback).slice(0, max).join("");
}

function optionalString(value: unknown, max: number) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return candidate ? Array.from(candidate).slice(0, max).join("") : null;
}

function safeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && value.length <= 2_000
      ? value
      : null;
  } catch {
    return null;
  }
}

function safeEmail(value: unknown) {
  if (typeof value !== "string" || value.length > 320) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
}

function safeNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function salesforceDate(value: unknown, fallback: string) {
  const candidate = typeof value === "string" ? value : fallback;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(candidate)
    ? new Date(`${candidate}T00:00:00.000Z`)
    : new Date(candidate);
  return Number.isFinite(date.getTime()) ? date.toISOString() : fallback;
}

function caseSeverity(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "high") return "high" as const;
  if (normalized === "medium") return "medium" as const;
  if (normalized === "low") return "low" as const;
  return "unknown" as const;
}

function assetStatus(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("active") || normalized.includes("installed")) return "active" as const;
  if (normalized.includes("trial")) return "trial" as const;
  if (normalized.includes("pause")) return "paused" as const;
  if (normalized.includes("retire") || normalized.includes("end")) return "ended" as const;
  return "unknown" as const;
}

function renewalStatus(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("activat") || normalized.includes("signed")) return "committed" as const;
  if (normalized.includes("renew")) return "renewed" as const;
  if (normalized.includes("draft") || normalized.includes("approval")) return "planning" as const;
  if (normalized.includes("cancel") || normalized.includes("terminat")) return "lost" as const;
  return "unplanned" as const;
}

function taskChannel(value: unknown) {
  const normalized = String(value || "").toLowerCase();
  if (normalized.includes("call")) return "call" as const;
  if (normalized.includes("email")) return "email" as const;
  return "other" as const;
}

function projectionErrorCode(error: unknown) {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  if (message.includes("not found") || message.includes("missing")) return "account_missing" as const;
  if (message.includes("permission") || message.includes("access")) return "permission_denied" as const;
  if (message.includes("invalid")) return "invalid_record" as const;
  if (message.includes("conflict") || message.includes("changed")) return "account_conflict" as const;
  return "internal_error" as const;
}
