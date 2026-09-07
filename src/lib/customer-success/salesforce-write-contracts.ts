import { createHash } from "node:crypto";
import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const SALESFORCE_WRITE_CONTRACT_VERSION =
  "p10.11-salesforce-guarded-write:1" as const;

export const SALESFORCE_CREATE_OBJECTS = Object.freeze([
  "Contact",
  "Task",
  "Case",
  "Opportunity",
] as const);

export const SALESFORCE_UPDATE_OBJECTS = Object.freeze([
  "Account",
  "Contact",
  "Task",
  "Note",
  "Case",
  "Opportunity",
] as const);

export const SALESFORCE_WRITE_TOOL_IDS = Object.freeze([
  "app.customer_accounts.salesforce.writes.configure",
  "app.customer_accounts.salesforce.contact.create",
  "app.customer_accounts.salesforce.contact.update",
  "app.customer_accounts.salesforce.task.create",
  "app.customer_accounts.salesforce.task.update",
  "app.customer_accounts.salesforce.note.update",
  "app.customer_accounts.salesforce.case.create",
  "app.customer_accounts.salesforce.case.update",
  "app.customer_accounts.salesforce.opportunity.create",
  "app.customer_accounts.salesforce.opportunity.update",
  "app.customer_accounts.salesforce.account.update",
] as const);

export type SalesforceCreateObject = (typeof SALESFORCE_CREATE_OBJECTS)[number];
export type SalesforceUpdateObject = (typeof SALESFORCE_UPDATE_OBJECTS)[number];
export type SalesforceWriteObject = SalesforceCreateObject | SalesforceUpdateObject;
export type SalesforceWriteToolId = (typeof SALESFORCE_WRITE_TOOL_IDS)[number];
export type SalesforceRecordWriteToolId = Exclude<
  SalesforceWriteToolId,
  "app.customer_accounts.salesforce.writes.configure"
>;

const salesforceIdSchema = z.string().regex(/^[A-Za-z0-9]{15,18}$/);
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);
const workspaceIdSchema = z.string().trim().min(1).max(240).optional();
const boundedText = (max: number) => z.string().trim().min(1).max(max);
const nullableText = (max: number) => boundedText(max).nullable();
const salesforceDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const commonShape = {
  workspaceId: workspaceIdSchema,
  accountId: accountIdSchema,
  expectedAccountRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};

export const salesforceWriteConfigurationInputSchema = z.object({
  ...commonShape,
  enabled: z.boolean(),
}).strict();

const accountFieldsSchema = mutableFields({
  Name: boundedText(255),
  Phone: nullableText(40),
  Website: nullableText(255),
  Industry: nullableText(80),
  Type: nullableText(80),
  Description: nullableText(32_000),
  BillingStreet: nullableText(255),
  BillingCity: nullableText(40),
  BillingState: nullableText(80),
  BillingPostalCode: nullableText(20),
  BillingCountry: nullableText(80),
});

const contactFields = {
  FirstName: nullableText(40).optional(),
  LastName: boundedText(80),
  Email: z.string().email().max(254).nullable().optional(),
  Phone: nullableText(40).optional(),
  MobilePhone: nullableText(40).optional(),
  Title: nullableText(128).optional(),
  Department: nullableText(80).optional(),
  Description: nullableText(32_000).optional(),
};
const contactCreateFieldsSchema = z.object(contactFields).strict();
const contactUpdateFieldsSchema = mutableFields(contactFields);

const taskFields = {
  Subject: boundedText(255),
  Description: nullableText(32_000).optional(),
  ActivityDate: salesforceDateSchema.nullable().optional(),
  Status: boundedText(80),
  Priority: boundedText(80),
};
const taskCreateFieldsSchema = z.object(taskFields).strict();
const taskUpdateFieldsSchema = mutableFields(taskFields);

const noteUpdateFieldsSchema = mutableFields({
  Title: boundedText(80),
  Body: nullableText(32_000),
});

const caseFields = {
  Subject: boundedText(255),
  Description: nullableText(32_000).optional(),
  Status: boundedText(80),
  Priority: boundedText(80),
  Origin: boundedText(80),
  Type: nullableText(80).optional(),
  Reason: nullableText(80).optional(),
};
const caseCreateFieldsSchema = z.object(caseFields).strict();
const caseUpdateFieldsSchema = mutableFields(caseFields);

const opportunityFields = {
  Name: boundedText(120),
  StageName: boundedText(120),
  CloseDate: salesforceDateSchema,
  Amount: z.number().finite().min(0).max(1_000_000_000_000).nullable().optional(),
  Probability: z.number().finite().min(0).max(100).nullable().optional(),
  Type: nullableText(80).optional(),
  NextStep: nullableText(255).optional(),
  Description: nullableText(32_000).optional(),
};
const opportunityCreateFieldsSchema = z.object(opportunityFields).strict();
const opportunityUpdateFieldsSchema = mutableFields(opportunityFields);

const createInput = (fields: z.ZodTypeAny) => z.object({
  ...commonShape,
  fields,
}).strict();

const updateInput = (fields: z.ZodTypeAny) => z.object({
  ...commonShape,
  recordId: salesforceIdSchema,
  expectedProviderModifiedAt: canonicalTimestampSchema,
  fields,
}).strict();

const recordWriteSchemas = {
  "app.customer_accounts.salesforce.contact.create": createInput(contactCreateFieldsSchema),
  "app.customer_accounts.salesforce.contact.update": updateInput(contactUpdateFieldsSchema),
  "app.customer_accounts.salesforce.task.create": createInput(taskCreateFieldsSchema),
  "app.customer_accounts.salesforce.task.update": updateInput(taskUpdateFieldsSchema),
  "app.customer_accounts.salesforce.note.update": updateInput(noteUpdateFieldsSchema),
  "app.customer_accounts.salesforce.case.create": createInput(caseCreateFieldsSchema),
  "app.customer_accounts.salesforce.case.update": updateInput(caseUpdateFieldsSchema),
  "app.customer_accounts.salesforce.opportunity.create": createInput(opportunityCreateFieldsSchema),
  "app.customer_accounts.salesforce.opportunity.update": updateInput(opportunityUpdateFieldsSchema),
  "app.customer_accounts.salesforce.account.update": updateInput(accountFieldsSchema),
} satisfies Record<SalesforceRecordWriteToolId, z.ZodTypeAny>;

const toolMetadata = Object.freeze({
  "app.customer_accounts.salesforce.contact.create": { objectType: "Contact", action: "create" },
  "app.customer_accounts.salesforce.contact.update": { objectType: "Contact", action: "update" },
  "app.customer_accounts.salesforce.task.create": { objectType: "Task", action: "create" },
  "app.customer_accounts.salesforce.task.update": { objectType: "Task", action: "update" },
  "app.customer_accounts.salesforce.note.update": { objectType: "Note", action: "update" },
  "app.customer_accounts.salesforce.case.create": { objectType: "Case", action: "create" },
  "app.customer_accounts.salesforce.case.update": { objectType: "Case", action: "update" },
  "app.customer_accounts.salesforce.opportunity.create": { objectType: "Opportunity", action: "create" },
  "app.customer_accounts.salesforce.opportunity.update": { objectType: "Opportunity", action: "update" },
  "app.customer_accounts.salesforce.account.update": { objectType: "Account", action: "update" },
} as const satisfies Record<SalesforceRecordWriteToolId, {
  objectType: SalesforceWriteObject;
  action: "create" | "update";
}>);

export const salesforceWriteCommitSchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(SALESFORCE_WRITE_CONTRACT_VERSION),
  operationId: z.string().regex(/^salesforce-write:[a-f0-9]{64}$/),
  toolId: z.enum(SALESFORCE_WRITE_TOOL_IDS),
  objectType: z.enum(SALESFORCE_UPDATE_OBJECTS),
  action: z.enum(["create", "update"]),
  providerRecordIdSha256: z.string().regex(/^[a-f0-9]{64}$/),
  providerModifiedAt: canonicalTimestampSchema,
  providerAcknowledgement: z.enum([
    "provider_response",
    "provider_idempotency_reconciliation",
  ]),
  providerAcknowledgementId: z.string().regex(/^salesforce_ack_[a-f0-9]{48}$/),
  providerAcknowledgementSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedTargetStateSha256: z.string().regex(/^[a-f0-9]{64}$/),
  observedTargetStateSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  verificationState: z.enum(["verified", "failed"]),
  verificationReasonCode: z.enum(["state_matched", "target_missing", "state_mismatch"]),
}).strict().superRefine((value, context) => {
  if (value.verificationState === "verified" !==
      (value.verificationReasonCode === "state_matched" &&
        value.observedTargetStateSha256 === value.expectedTargetStateSha256)) {
    context.addIssue({
      code: "custom",
      path: ["verificationState"],
      message: "Salesforce verification state is inconsistent with its target evidence.",
    });
  }
});

export type SalesforceRecordWriteInput = Readonly<{
  workspaceId?: string;
  accountId: string;
  expectedAccountRevision: number;
  recordId?: string;
  expectedProviderModifiedAt?: string;
  fields: Readonly<Record<string, string | number | null>>;
}>;
export type SalesforceWriteCommit = z.infer<typeof salesforceWriteCommitSchema>;

export function isSalesforceWriteToolId(value: string): value is SalesforceWriteToolId {
  return (SALESFORCE_WRITE_TOOL_IDS as readonly string[]).includes(value);
}

export function isSalesforceRecordWriteToolId(
  value: string,
): value is SalesforceRecordWriteToolId {
  return isSalesforceWriteToolId(value) &&
    value !== "app.customer_accounts.salesforce.writes.configure";
}

export function salesforceWriteToolMetadata(toolId: SalesforceRecordWriteToolId) {
  return toolMetadata[toolId];
}

export function parseSalesforceRecordWriteInput(
  toolId: SalesforceRecordWriteToolId,
  input: unknown,
): SalesforceRecordWriteInput {
  return recordWriteSchemas[toolId].parse(input) as SalesforceRecordWriteInput;
}

export function salesforceWriteExternalKey(executionId: string) {
  const normalized = executionId.trim();
  if (!normalized || normalized.length > 240) {
    throw new Error("Salesforce write execution identity is invalid.");
  }
  return `asael_${createHash("sha256").update(normalized).digest("hex").slice(0, 58)}`;
}

export function salesforceWriteOperationId(executionId: string) {
  return `salesforce-write:${createHash("sha256")
    .update(`p10.11\0${executionId}`)
    .digest("hex")}`;
}

export function salesforceWriteExpectedTargetState(input: {
  toolId: SalesforceRecordWriteToolId;
  value: SalesforceRecordWriteInput;
  executionId: string;
}) {
  const metadata = salesforceWriteToolMetadata(input.toolId);
  return Object.freeze({
    contractVersion: SALESFORCE_WRITE_CONTRACT_VERSION,
    operationId: salesforceWriteOperationId(input.executionId),
    action: metadata.action,
    objectType: metadata.objectType,
    accountId: input.value.accountId,
    expectedAccountRevision: input.value.expectedAccountRevision,
    recordIdentity: metadata.action === "create"
      ? { externalKey: salesforceWriteExternalKey(input.executionId) }
      : { providerRecordIdSha256: providerRecordIdSha256(input.value.recordId || "") },
    fields: input.value.fields,
  });
}

export function salesforceWriteExpectedTargetStateSha256(input: {
  toolId: SalesforceRecordWriteToolId;
  value: SalesforceRecordWriteInput;
  executionId: string;
}) {
  return canonicalJsonSha256(salesforceWriteExpectedTargetState(input));
}

export function providerRecordIdSha256(value: string) {
  if (!/^[A-Za-z0-9]{15,18}$/.test(value)) {
    throw new Error("Salesforce record identity is invalid.");
  }
  return canonicalJsonSha256({ provider: "salesforce", recordId: value });
}

export function getSalesforceWriteConfiguration() {
  const externalIdField = process.env.SALESFORCE_WRITE_EXTERNAL_ID_FIELD?.trim() || null;
  const externalIdFieldValid = Boolean(
    externalIdField && /^[A-Za-z][A-Za-z0-9_]{0,100}__c$/.test(externalIdField),
  );
  const enabled = process.env.SALESFORCE_WRITE_ENABLED === "true";
  return Object.freeze({
    enabled,
    externalIdField: externalIdFieldValid ? externalIdField : null,
    configured: enabled && externalIdFieldValid,
    mode: "approval_required" as const,
    createObjects: SALESFORCE_CREATE_OBJECTS,
    updateObjects: SALESFORCE_UPDATE_OBJECTS,
  });
}

function mutableFields<T extends z.ZodRawShape>(shape: T) {
  return z.object(Object.fromEntries(
    Object.entries(shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).optional()]),
  ) as unknown as { [K in keyof T]: z.ZodOptional<T[K]> }).strict().refine(
    (value) => Object.keys(value).length > 0,
    { message: "At least one reviewed Salesforce field is required." },
  );
}
