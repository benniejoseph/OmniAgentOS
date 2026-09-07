import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const SALESFORCE_SYNC_CONTRACT_VERSION =
  "p10.10-salesforce-read-sync:1" as const;

export const SALESFORCE_OBJECT_TYPES = Object.freeze([
  "Account",
  "Contact",
  "Opportunity",
  "Case",
  "Task",
  "Event",
  "Asset",
  "Contract",
] as const);

export type SalesforceObjectType = (typeof SALESFORCE_OBJECT_TYPES)[number];

export const SALESFORCE_OBJECT_FIELDS = Object.freeze({
  Account: [
    "Id", "Name", "Industry", "Website", "OwnerId", "Type",
    "BillingCountry", "LastActivityDate", "LastModifiedDate", "SystemModstamp",
    "IsDeleted",
  ],
  Contact: [
    "Id", "AccountId", "Name", "Email", "Title", "Department", "OwnerId",
    "LastActivityDate", "LastModifiedDate", "SystemModstamp", "IsDeleted",
  ],
  Opportunity: [
    "Id", "AccountId", "Name", "StageName", "Amount", "CurrencyIsoCode",
    "Probability", "CloseDate", "IsClosed", "IsWon", "OwnerId",
    "LastModifiedDate", "SystemModstamp", "IsDeleted",
  ],
  Case: [
    "Id", "AccountId", "Subject", "Status", "Priority", "Type", "Reason",
    "OwnerId", "ClosedDate", "LastModifiedDate", "SystemModstamp", "IsDeleted",
  ],
  Task: [
    "Id", "AccountId", "WhatId", "WhoId", "Subject", "Status", "Priority",
    "ActivityDate", "CompletedDateTime", "OwnerId", "LastModifiedDate",
    "SystemModstamp", "IsDeleted",
  ],
  Event: [
    "Id", "AccountId", "WhatId", "WhoId", "Subject", "StartDateTime",
    "EndDateTime", "Location", "OwnerId", "LastModifiedDate", "SystemModstamp",
    "IsDeleted",
  ],
  Asset: [
    "Id", "AccountId", "Name", "Status", "Quantity", "Product2Id",
    "PurchaseDate", "InstallDate", "UsageEndDate", "LastModifiedDate",
    "SystemModstamp", "IsDeleted",
  ],
  Contract: [
    "Id", "AccountId", "Status", "StartDate", "EndDate", "ContractTerm",
    "OwnerId", "LastModifiedDate", "SystemModstamp", "IsDeleted",
  ],
} satisfies Record<SalesforceObjectType, readonly string[]>);

const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const salesforceIdSchema = z.string().regex(/^[A-Za-z0-9]{15,18}$/);
const connectionIdSchema = z.string().regex(/^salesforce-connection:[a-f0-9]{64}$/);
const revisionIdSchema = z.string().regex(/^salesforce-revision:[a-f0-9]{64}$/);
const workspaceIdSchema = z.string().regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);

export const salesforceObjectTypeSchema = z.enum(SALESFORCE_OBJECT_TYPES);
const salesforceFieldValueSchema = z.union([
  z.string().max(8_000),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const salesforceRecordObservationSchema = z.object({
  objectType: salesforceObjectTypeSchema,
  externalId: salesforceIdSchema,
  accountExternalId: salesforceIdSchema.nullable(),
  providerModifiedAt: canonicalTimestampSchema,
  deleted: z.boolean(),
  fields: z.record(z.string().min(1).max(120), salesforceFieldValueSchema),
  sourceKind: z.enum(["backfill", "delta", "webhook", "reconciliation"]),
  observedAt: canonicalTimestampSchema,
  replayIdSha256: sha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  const allowed = new Set<string>(SALESFORCE_OBJECT_FIELDS[value.objectType]);
  for (const field of Object.keys(value.fields)) {
    if (!allowed.has(field)) {
      context.addIssue({
        code: "custom",
        path: ["fields", field],
        message: "Field is outside the reviewed Salesforce read contract.",
      });
    }
  }
  if (value.fields.Id !== value.externalId) {
    context.addIssue({
      code: "custom",
      path: ["fields", "Id"],
      message: "Salesforce record identity is inconsistent.",
    });
  }
});

const salesforceRecordRevisionBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(SALESFORCE_SYNC_CONTRACT_VERSION),
  tenantId: z.string().trim().min(1).max(240),
  workspaceId: workspaceIdSchema,
  connectionId: connectionIdSchema,
  organizationIdSha256: sha256Schema,
  objectType: salesforceObjectTypeSchema,
  externalId: salesforceIdSchema,
  providerObjectIdSha256: sha256Schema,
  accountExternalId: salesforceIdSchema.nullable(),
  revisionId: revisionIdSchema,
  providerModifiedAt: canonicalTimestampSchema,
  deleted: z.boolean(),
  fields: z.record(z.string().min(1).max(120), salesforceFieldValueSchema),
  fieldsSha256: sha256Schema,
  sourceKind: z.enum(["backfill", "delta", "webhook", "reconciliation"]),
  observedAt: canonicalTimestampSchema,
  receivedAt: canonicalTimestampSchema,
  replayIdSha256: sha256Schema.nullable(),
}).strict();

export const salesforceRecordRevisionSchema = salesforceRecordRevisionBodySchema
  .extend({ recordSha256: sha256Schema })
  .strict()
  .superRefine((value, context) => {
    if (value.fieldsSha256 !== canonicalJsonSha256(value.fields)) {
      context.addIssue({
        code: "custom",
        path: ["fieldsSha256"],
        message: "Salesforce field digest is inconsistent.",
      });
    }
    const expectedProviderId = canonicalJsonSha256({
      organizationIdSha256: value.organizationIdSha256,
      objectType: value.objectType,
      externalId: value.externalId,
    });
    if (value.providerObjectIdSha256 !== expectedProviderId) {
      context.addIssue({
        code: "custom",
        path: ["providerObjectIdSha256"],
        message: "Salesforce provider reference is inconsistent.",
      });
    }
    const { recordSha256, ...body } = value;
    if (recordSha256 !== canonicalJsonSha256(body)) {
      context.addIssue({
        code: "custom",
        path: ["recordSha256"],
        message: "Salesforce record digest is inconsistent.",
      });
    }
  });

export const salesforceObjectCursorSchema = z.object({
  phase: z.enum(["pending", "backfill", "delta", "current"]),
  nextRecordsPath: z.string().regex(/^\/services\/data\//).max(2_000).nullable(),
  upperBoundAt: canonicalTimestampSchema.nullable(),
  watermarkAt: canonicalTimestampSchema.nullable(),
  watermarkExternalId: salesforceIdSchema.nullable(),
  pagesSettled: z.number().int().nonnegative(),
  recordsSettled: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.watermarkExternalId !== null && value.watermarkAt === null) {
    context.addIssue({
      code: "custom",
      path: ["watermarkAt"],
      message: "A Salesforce watermark record requires its provider timestamp.",
    });
  }
});

export const salesforceSyncCursorSchema = z.object({
  version: z.literal(1),
  objects: z.record(salesforceObjectTypeSchema, salesforceObjectCursorSchema),
}).strict().superRefine((value, context) => {
  for (const objectType of SALESFORCE_OBJECT_TYPES) {
    if (!value.objects[objectType]) {
      context.addIssue({
        code: "custom",
        path: ["objects", objectType],
        message: "Every reviewed Salesforce object requires an independent cursor.",
      });
    }
  }
});

export const salesforceActionableErrorSchema = z.object({
  code: z.enum([
    "authorization_expired",
    "insufficient_scope",
    "provider_unavailable",
    "rate_limited",
    "cursor_expired",
    "schema_changed",
    "record_conflict",
    "webhook_invalid",
    "internal_error",
  ]),
  message: z.string().trim().min(1).max(500),
  action: z.enum(["reconnect", "review_permissions", "retry", "restart_backfill", "review_conflict", "contact_support"]),
  occurredAt: canonicalTimestampSchema,
}).strict();

export const salesforceSyncHealthSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(SALESFORCE_SYNC_CONTRACT_VERSION),
  configured: z.boolean(),
  connected: z.boolean(),
  connectionId: connectionIdSchema.nullable(),
  workspaceId: workspaceIdSchema,
  status: z.enum(["configuration_required", "disconnected", "idle", "backfilling", "syncing", "healthy", "degraded", "error"]),
  accessMode: z.literal("read_only"),
  objectScope: z.array(salesforceObjectTypeSchema).length(SALESFORCE_OBJECT_TYPES.length),
  purposeScope: z.tuple([
    z.literal("customer_success.account.read"),
    z.literal("customer_success.crm_sync"),
  ]),
  cursor: salesforceSyncCursorSchema.nullable(),
  lagSeconds: z.number().int().nonnegative().nullable(),
  lastSuccessfulSyncAt: canonicalTimestampSchema.nullable(),
  lastWebhookAt: canonicalTimestampSchema.nullable(),
  lastReplayIdSha256: sha256Schema.nullable(),
  actionableError: salesforceActionableErrorSchema.nullable(),
  evaluatedAt: canonicalTimestampSchema,
}).strict();

export type SalesforceRecordObservation = z.infer<typeof salesforceRecordObservationSchema>;
export type SalesforceRecordRevision = z.infer<typeof salesforceRecordRevisionSchema>;
export type SalesforceObjectCursor = z.infer<typeof salesforceObjectCursorSchema>;
export type SalesforceSyncCursor = z.infer<typeof salesforceSyncCursorSchema>;
export type SalesforceActionableError = z.infer<typeof salesforceActionableErrorSchema>;
export type SalesforceSyncHealth = z.infer<typeof salesforceSyncHealthSchema>;

export function salesforceConnectionId(input: {
  tenantId: string;
  workspaceId: string;
  organizationIdSha256: string;
}) {
  return `salesforce-connection:${canonicalJsonSha256(input)}`;
}

export function salesforceOrganizationIdSha256(organizationId: string) {
  if (!/^[A-Za-z0-9]{15,18}$/.test(organizationId)) {
    throw new Error("Salesforce organization identity is invalid.");
  }
  return canonicalJsonSha256({ provider: "salesforce", organizationId });
}

export function initialSalesforceSyncCursor(): SalesforceSyncCursor {
  return salesforceSyncCursorSchema.parse({
    version: 1,
    objects: Object.fromEntries(SALESFORCE_OBJECT_TYPES.map((objectType) => [
      objectType,
      {
        phase: "pending",
        nextRecordsPath: null,
        upperBoundAt: null,
        watermarkAt: null,
        watermarkExternalId: null,
        pagesSettled: 0,
        recordsSettled: 0,
      },
    ])),
  });
}

export function buildSalesforceRecordRevision(input: {
  tenantId: string;
  workspaceId: string;
  connectionId: string;
  organizationIdSha256: string;
  observation: SalesforceRecordObservation;
  receivedAt: string;
}): SalesforceRecordRevision {
  const observation = salesforceRecordObservationSchema.parse(input.observation);
  const fieldsSha256 = canonicalJsonSha256(observation.fields);
  const providerObjectIdSha256 = canonicalJsonSha256({
    organizationIdSha256: input.organizationIdSha256,
    objectType: observation.objectType,
    externalId: observation.externalId,
  });
  const revisionId = `salesforce-revision:${canonicalJsonSha256({
    providerObjectIdSha256,
    providerModifiedAt: observation.providerModifiedAt,
    deleted: observation.deleted,
    fieldsSha256,
  })}`;
  const body = salesforceRecordRevisionBodySchema.parse({
    schemaVersion: 1,
    contractVersion: SALESFORCE_SYNC_CONTRACT_VERSION,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    connectionId: input.connectionId,
    organizationIdSha256: input.organizationIdSha256,
    objectType: observation.objectType,
    externalId: observation.externalId,
    providerObjectIdSha256,
    accountExternalId: observation.accountExternalId,
    revisionId,
    providerModifiedAt: observation.providerModifiedAt,
    deleted: observation.deleted,
    fields: observation.fields,
    fieldsSha256,
    sourceKind: observation.sourceKind,
    observedAt: observation.observedAt,
    receivedAt: input.receivedAt,
    replayIdSha256: observation.replayIdSha256,
  });
  return salesforceRecordRevisionSchema.parse({
    ...body,
    recordSha256: canonicalJsonSha256(body),
  });
}

export function resolveSalesforceHead(
  current: SalesforceRecordRevision | undefined,
  candidate: SalesforceRecordRevision,
): {
  outcome: "advanced" | "duplicate" | "stale" | "conflict_advanced" | "conflict_retained";
  head: SalesforceRecordRevision;
  conflict: boolean;
} {
  const next = salesforceRecordRevisionSchema.parse(candidate);
  if (!current) return { outcome: "advanced", head: next, conflict: false };
  const existing = salesforceRecordRevisionSchema.parse(current);
  if (
    existing.connectionId !== next.connectionId ||
    existing.objectType !== next.objectType ||
    existing.externalId !== next.externalId
  ) {
    throw new Error("Salesforce head identity changed.");
  }
  if (existing.revisionId === next.revisionId) {
    return { outcome: "duplicate", head: existing, conflict: false };
  }
  if (next.providerModifiedAt > existing.providerModifiedAt) {
    return { outcome: "advanced", head: next, conflict: false };
  }
  if (next.providerModifiedAt < existing.providerModifiedAt) {
    return { outcome: "stale", head: existing, conflict: false };
  }
  const advance = next.revisionId > existing.revisionId;
  return {
    outcome: advance ? "conflict_advanced" : "conflict_retained",
    head: advance ? next : existing,
    conflict: true,
  };
}

export function normalizeSalesforceRecord(input: {
  objectType: SalesforceObjectType;
  record: Record<string, unknown>;
  sourceKind: SalesforceRecordObservation["sourceKind"];
  observedAt: string;
  replayIdSha256?: string | null;
}): SalesforceRecordObservation {
  const allowed = SALESFORCE_OBJECT_FIELDS[input.objectType];
  const fields: Record<string, string | number | boolean | null> = {};
  for (const name of allowed) {
    const value = input.record[name];
    if (value === null || typeof value === "string" ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))) {
      fields[name] = typeof value === "string"
        ? Array.from(value).slice(0, 8_000).join("")
        : value;
    }
  }
  const externalId = String(fields.Id || "");
  const accountExternalId = input.objectType === "Account"
    ? externalId
    : salesforceAccountReference(input.objectType, fields);
  const providerModifiedAt = canonicalProviderTimestamp(
    fields.SystemModstamp || fields.LastModifiedDate,
  );
  return salesforceRecordObservationSchema.parse({
    objectType: input.objectType,
    externalId,
    accountExternalId: accountExternalId || null,
    providerModifiedAt,
    deleted: input.record.IsDeleted === true,
    fields,
    sourceKind: input.sourceKind,
    observedAt: new Date(input.observedAt).toISOString(),
    replayIdSha256: input.replayIdSha256 || null,
  });
}

function salesforceAccountReference(
  objectType: SalesforceObjectType,
  fields: Record<string, string | number | boolean | null>,
) {
  if (typeof fields.AccountId === "string") return fields.AccountId;
  if (["Task", "Event"].includes(objectType) && typeof fields.WhatId === "string" &&
      fields.WhatId.startsWith("001")) return fields.WhatId;
  return "";
}

function canonicalProviderTimestamp(value: unknown) {
  if (typeof value !== "string") {
    throw new Error("Salesforce record has no provider revision timestamp.");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Salesforce record revision timestamp is invalid.");
  }
  return timestamp.toISOString();
}
