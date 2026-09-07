import { z } from "zod";

import { ASAEL_ONTOLOGY_VERSION_ID } from "@/lib/entities/ontology";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const CUSTOMER_ACCOUNT_CONTRACT_VERSION =
  "p10.9-customer-account-360:1" as const;

export const CUSTOMER_DATA_PURPOSE_IDS = Object.freeze([
  "customer_success.account.read",
  "customer_success.account.manage",
  "customer_success.meeting_follow_up",
  "customer_success.analytics",
  "customer_success.crm_sync",
] as const);

export const CUSTOMER_FACT_KINDS = Object.freeze([
  "organization",
  "contact",
  "stakeholder",
  "product",
  "opportunity",
  "case",
  "usage",
  "project",
  "interaction",
  "health",
  "risk",
  "renewal",
] as const);

const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const factIdSchema = z.string().regex(/^customer-fact:[a-f0-9]{64}$/);
const mutationIdSchema = z.string().regex(/^customer-mutation:[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);
const nullableTimestampSchema = canonicalTimestampSchema.nullable();
const currencySchema = z.string().regex(/^[A-Z]{3}$/);

export const customerDataPurposeIdSchema = z.enum(CUSTOMER_DATA_PURPOSE_IDS);
export const customerFactKindSchema = z.enum(CUSTOMER_FACT_KINDS);

export const customerCrmPermissionsSchema = z.object({
  readScope: z.literal("workspace_members"),
  writeScope: z.literal("account_owner"),
  externalWriteState: z.literal("disabled"),
  customerDataPurposeIds: z.array(customerDataPurposeIdSchema).min(2).max(5),
}).strict().superRefine((value, context) => {
  assertCanonicalUnique(value.customerDataPurposeIds, context, "customerDataPurposeIds");
  if (
    !value.customerDataPurposeIds.includes("customer_success.account.read") ||
    !value.customerDataPurposeIds.includes("customer_success.account.manage")
  ) {
    context.addIssue({
      code: "custom",
      path: ["customerDataPurposeIds"],
      message: "Account data must retain explicit read and management purposes.",
    });
  }
});

export const customerFactOwnerSchema = z.object({
  ownerKind: z.enum(["actor", "person", "organization", "team", "system"]),
  ownerId: opaqueIdSchema,
  displayName: z.string().trim().min(1).max(180),
}).strict();

export const customerFactSourceSchema = z.object({
  sourceKind: z.enum([
    "manual",
    "meeting",
    "project",
    "work_item",
    "connected_source",
    "crm",
    "computed",
  ]),
  sourceId: opaqueIdSchema,
  sourceRevisionId: opaqueIdSchema,
  sourceRevisionSha256: sha256Schema,
  sourceLabel: z.string().trim().min(1).max(240),
  providerId: opaqueIdSchema.nullable(),
  providerObjectType: z.string().trim().min(1).max(120).nullable(),
  providerObjectIdSha256: sha256Schema.nullable(),
  permissionBasis: z.enum([
    "operator_assertion",
    "workspace_membership",
    "project_membership",
    "connector_grant",
    "derived_from_cited_evidence",
  ]),
  allowedPurposeIds: z.array(customerDataPurposeIdSchema).min(1).max(5),
  observedAt: canonicalTimestampSchema,
  ingestedAt: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  assertCanonicalUnique(value.allowedPurposeIds, context, "allowedPurposeIds");
  const providerComplete = value.providerId !== null &&
    value.providerObjectType !== null && value.providerObjectIdSha256 !== null;
  const providerEmpty = value.providerId === null &&
    value.providerObjectType === null && value.providerObjectIdSha256 === null;
  if (!providerComplete && !providerEmpty) {
    context.addIssue({
      code: "custom",
      path: ["providerId"],
      message: "Provider references must be complete or absent.",
    });
  }
  if (["crm", "connected_source"].includes(value.sourceKind) !== providerComplete) {
    context.addIssue({
      code: "custom",
      path: ["providerId"],
      message: "External sources require a complete provider reference.",
    });
  }
  if (value.permissionBasis === "connector_grant" !== providerComplete) {
    context.addIssue({
      code: "custom",
      path: ["permissionBasis"],
      message: "Connector permission is valid only for an external provider source.",
    });
  }
});

const namedEntitySchema = z.object({
  entityId: opaqueIdSchema,
  name: z.string().trim().min(1).max(240),
}).strict();

export const customerFactValueSchema = z.discriminatedUnion("kind", [
  namedEntitySchema.extend({
    kind: z.literal("organization"),
    industry: z.string().trim().min(1).max(160).nullable(),
    website: z.string().url().max(2_000).nullable(),
  }).strict(),
  namedEntitySchema.extend({
    kind: z.literal("contact"),
    email: z.string().email().max(320).nullable(),
    title: z.string().trim().min(1).max(180).nullable(),
  }).strict(),
  namedEntitySchema.extend({
    kind: z.literal("stakeholder"),
    role: z.string().trim().min(1).max(180),
    influence: z.enum(["low", "medium", "high", "unknown"]),
    stance: z.enum(["champion", "supportive", "neutral", "detractor", "unknown"]),
  }).strict(),
  namedEntitySchema.extend({
    kind: z.literal("product"),
    status: z.enum(["trial", "active", "paused", "ended", "unknown"]),
    quantity: z.number().nonnegative().nullable(),
  }).strict(),
  namedEntitySchema.extend({
    kind: z.literal("opportunity"),
    stage: z.string().trim().min(1).max(120),
    amountMinor: z.number().int().nonnegative().nullable(),
    currency: currencySchema.nullable(),
    expectedCloseAt: nullableTimestampSchema,
  }).strict().superRefine(requireAmountCurrencyPair),
  z.object({
    kind: z.literal("case"),
    entityId: opaqueIdSchema,
    title: z.string().trim().min(1).max(500),
    status: z.string().trim().min(1).max(120),
    severity: z.enum(["low", "medium", "high", "critical", "unknown"]),
  }).strict(),
  z.object({
    kind: z.literal("usage"),
    metricId: opaqueIdSchema,
    label: z.string().trim().min(1).max(240),
    value: z.number().finite(),
    unit: z.string().trim().min(1).max(80),
    periodStartAt: canonicalTimestampSchema,
    periodEndAt: canonicalTimestampSchema,
  }).strict().refine(
    (value) => value.periodEndAt > value.periodStartAt,
    { message: "Usage period must be a non-empty interval." },
  ),
  z.object({
    kind: z.literal("project"),
    projectId: opaqueIdSchema,
    name: z.string().trim().min(1).max(240),
    status: z.string().trim().min(1).max(120),
  }).strict(),
  z.object({
    kind: z.literal("interaction"),
    interactionId: opaqueIdSchema,
    channel: z.enum(["meeting", "email", "call", "message", "support", "other"]),
    summary: z.string().trim().min(1).max(4_000),
    occurredAt: canonicalTimestampSchema,
  }).strict(),
  z.object({
    kind: z.literal("health"),
    dimension: z.string().trim().min(1).max(120),
    status: z.enum(["healthy", "watch", "at_risk", "unknown"]),
    scoreBasisPoints: z.number().int().min(0).max(10_000).nullable(),
    summary: z.string().trim().min(1).max(2_000),
  }).strict(),
  z.object({
    kind: z.literal("risk"),
    entityId: opaqueIdSchema,
    title: z.string().trim().min(1).max(500),
    severity: z.enum(["low", "medium", "high", "critical"]),
    status: z.enum(["open", "mitigating", "resolved"]),
  }).strict(),
  z.object({
    kind: z.literal("renewal"),
    renewalId: opaqueIdSchema,
    status: z.enum(["unplanned", "planning", "proposed", "committed", "renewed", "lost"]),
    renewalAt: canonicalTimestampSchema,
    amountMinor: z.number().int().nonnegative().nullable(),
    currency: currencySchema.nullable(),
  }).strict().superRefine(requireAmountCurrencyPair),
]);

const customerAccountRevisionBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(CUSTOMER_ACCOUNT_CONTRACT_VERSION),
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  accountId: accountIdSchema,
  accountEntityId: opaqueIdSchema,
  organizationEntityId: opaqueIdSchema.nullable(),
  revisionId: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousRevisionId: opaqueIdSchema.nullable(),
  mutationId: mutationIdSchema,
  name: z.string().trim().min(1).max(240),
  lifecycle: z.enum(["prospect", "onboarding", "active", "at_risk", "churned", "archived"]),
  accountOwner: customerFactOwnerSchema,
  crmPermissions: customerCrmPermissionsSchema,
  ownerActorId: opaqueIdSchema,
  revisedByActorId: opaqueIdSchema,
  revisedAt: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.revisionId !== `${value.accountId}:v${value.revision}`) {
    context.addIssue({ code: "custom", path: ["revisionId"], message: "Account revision identity is inconsistent." });
  }
  const expectedPrevious = value.revision === 1
    ? null
    : `${value.accountId}:v${value.revision - 1}`;
  if (value.previousRevisionId !== expectedPrevious) {
    context.addIssue({ code: "custom", path: ["previousRevisionId"], message: "Account revision lineage is inconsistent." });
  }
});

export const customerAccountRevisionSchema = customerAccountRevisionBodySchema.extend({
  accountSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { accountSha256, ...body } = value;
  if (accountSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["accountSha256"], message: "Account digest does not match its immutable revision." });
  }
});

const customerFactRevisionBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(CUSTOMER_ACCOUNT_CONTRACT_VERSION),
  ontologyVersionId: z.literal(ASAEL_ONTOLOGY_VERSION_ID),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  accountId: accountIdSchema,
  factId: factIdSchema,
  factRevisionId: opaqueIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousFactRevisionId: opaqueIdSchema.nullable(),
  mutationId: mutationIdSchema,
  factKey: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/),
  kind: customerFactKindSchema,
  state: z.enum(["active", "retracted"]),
  value: customerFactValueSchema,
  valueSha256: sha256Schema,
  source: customerFactSourceSchema,
  owner: customerFactOwnerSchema,
  confidenceBasisPoints: z.number().int().min(0).max(10_000),
  validFrom: canonicalTimestampSchema,
  validTo: nullableTimestampSchema,
  staleAfter: nullableTimestampSchema,
  recordedByActorId: opaqueIdSchema,
  recordedAt: canonicalTimestampSchema,
}).strict().superRefine((value, context) => {
  if (value.value.kind !== value.kind) {
    context.addIssue({ code: "custom", path: ["value", "kind"], message: "Fact kind and value kind must match." });
  }
  if (value.valueSha256 !== canonicalJsonSha256(value.value)) {
    context.addIssue({ code: "custom", path: ["valueSha256"], message: "Fact value digest does not match." });
  }
  if (value.factRevisionId !== `${value.factId}:v${value.revision}`) {
    context.addIssue({ code: "custom", path: ["factRevisionId"], message: "Fact revision identity is inconsistent." });
  }
  const expectedPrevious = value.revision === 1
    ? null
    : `${value.factId}:v${value.revision - 1}`;
  if (value.previousFactRevisionId !== expectedPrevious) {
    context.addIssue({ code: "custom", path: ["previousFactRevisionId"], message: "Fact revision lineage is inconsistent." });
  }
  if (value.validTo !== null && value.validTo <= value.validFrom) {
    context.addIssue({ code: "custom", path: ["validTo"], message: "Fact valid time must be a non-empty interval." });
  }
  if (value.staleAfter !== null && value.staleAfter <= value.source.observedAt) {
    context.addIssue({ code: "custom", path: ["staleAfter"], message: "Staleness must begin after observation." });
  }
});

export const customerFactRevisionSchema = customerFactRevisionBodySchema.extend({
  factSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { factSha256, ...body } = value;
  if (factSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["factSha256"], message: "Fact digest does not match its immutable revision." });
  }
});

export const customerFactFreshnessSchema = z.object({
  status: z.enum(["fresh", "stale", "future", "expired", "unknown"]),
  observedAt: canonicalTimestampSchema,
  staleAfter: nullableTimestampSchema,
  evaluatedAt: canonicalTimestampSchema,
}).strict();

export const customerFactViewSchema = z.object({
  fact: customerFactRevisionSchema,
  freshness: customerFactFreshnessSchema,
  conflict: z.object({
    state: z.enum(["none", "conflicting"]),
    conflictingFactIds: z.array(factIdSchema).max(100),
  }).strict(),
}).strict();

export const customerAccount360Schema = z.object({
  account: customerAccountRevisionSchema,
  facts: z.array(customerFactViewSchema).max(5_000),
  factsByKind: z.record(customerFactKindSchema, z.array(customerFactViewSchema)),
  historyCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  staleCount: z.number().int().nonnegative(),
  evaluatedAt: canonicalTimestampSchema,
}).strict();

export type CustomerDataPurposeId = z.infer<typeof customerDataPurposeIdSchema>;
export type CustomerFactKind = z.infer<typeof customerFactKindSchema>;
export type CustomerCrmPermissions = z.infer<typeof customerCrmPermissionsSchema>;
export type CustomerFactOwner = z.infer<typeof customerFactOwnerSchema>;
export type CustomerFactSource = z.infer<typeof customerFactSourceSchema>;
export type CustomerFactValue = z.infer<typeof customerFactValueSchema>;
export type CustomerAccountRevision = z.infer<typeof customerAccountRevisionSchema>;
export type CustomerFactRevision = z.infer<typeof customerFactRevisionSchema>;
export type CustomerFactView = z.infer<typeof customerFactViewSchema>;
export type CustomerAccount360 = z.infer<typeof customerAccount360Schema>;

export function customerAccountId(input: {
  tenantId: string;
  workspaceId: string;
  idempotencyKey: string;
}) {
  return `customer-account:${canonicalJsonSha256(input)}`;
}

export function customerFactId(input: { accountId: string; idempotencyKey: string }) {
  return `customer-fact:${canonicalJsonSha256(input)}`;
}

export function customerMutationId(input: {
  accountId: string;
  idempotencyKey: string;
  operation: "account.create" | "account.revise" | "fact.record";
}) {
  return `customer-mutation:${canonicalJsonSha256(input)}`;
}

export function buildCustomerAccountRevision(input: {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  accountEntityId?: string;
  organizationEntityId?: string | null;
  revision: number;
  mutationId: string;
  name: string;
  lifecycle: CustomerAccountRevision["lifecycle"];
  accountOwner: CustomerFactOwner;
  crmPermissions: CustomerCrmPermissions;
  ownerActorId: string;
  revisedByActorId: string;
  revisedAt: string;
}): CustomerAccountRevision {
  const body = customerAccountRevisionBodySchema.parse({
    schemaVersion: 1,
    contractVersion: CUSTOMER_ACCOUNT_CONTRACT_VERSION,
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    accountEntityId: input.accountEntityId || input.accountId,
    organizationEntityId: input.organizationEntityId ?? null,
    revisionId: `${input.accountId}:v${input.revision}`,
    revision: input.revision,
    previousRevisionId: input.revision === 1
      ? null
      : `${input.accountId}:v${input.revision - 1}`,
    mutationId: input.mutationId,
    name: input.name,
    lifecycle: input.lifecycle,
    accountOwner: input.accountOwner,
    crmPermissions: input.crmPermissions,
    ownerActorId: input.ownerActorId,
    revisedByActorId: input.revisedByActorId,
    revisedAt: canonicalTimestamp(input.revisedAt),
  });
  return customerAccountRevisionSchema.parse({
    ...body,
    accountSha256: canonicalJsonSha256(body),
  });
}

export function buildCustomerFactRevision(input: {
  tenantId: string;
  workspaceId: string;
  accountId: string;
  factId: string;
  revision: number;
  mutationId: string;
  factKey: string;
  state?: "active" | "retracted";
  value: CustomerFactValue;
  source: CustomerFactSource;
  owner: CustomerFactOwner;
  confidenceBasisPoints: number;
  validFrom: string;
  validTo?: string | null;
  staleAfter?: string | null;
  recordedByActorId: string;
  recordedAt: string;
}): CustomerFactRevision {
  const body = customerFactRevisionBodySchema.parse({
    schemaVersion: 1,
    contractVersion: CUSTOMER_ACCOUNT_CONTRACT_VERSION,
    ontologyVersionId: ASAEL_ONTOLOGY_VERSION_ID,
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    accountId: input.accountId,
    factId: input.factId,
    factRevisionId: `${input.factId}:v${input.revision}`,
    revision: input.revision,
    previousFactRevisionId: input.revision === 1
      ? null
      : `${input.factId}:v${input.revision - 1}`,
    mutationId: input.mutationId,
    factKey: input.factKey,
    kind: input.value.kind,
    state: input.state || "active",
    value: input.value,
    valueSha256: canonicalJsonSha256(input.value),
    source: input.source,
    owner: input.owner,
    confidenceBasisPoints: input.confidenceBasisPoints,
    validFrom: canonicalTimestamp(input.validFrom),
    validTo: input.validTo ? canonicalTimestamp(input.validTo) : null,
    staleAfter: input.staleAfter ? canonicalTimestamp(input.staleAfter) : null,
    recordedByActorId: input.recordedByActorId,
    recordedAt: canonicalTimestamp(input.recordedAt),
  });
  return customerFactRevisionSchema.parse({
    ...body,
    factSha256: canonicalJsonSha256(body),
  });
}

export function projectCustomerAccount360(input: {
  account: CustomerAccountRevision;
  currentFacts: readonly CustomerFactRevision[];
  historyCount: number;
  evaluatedAt?: string;
}): CustomerAccount360 {
  const account = customerAccountRevisionSchema.parse(input.account);
  const evaluatedAt = canonicalTimestamp(input.evaluatedAt || new Date().toISOString());
  const facts = input.currentFacts
    .map((fact) => customerFactRevisionSchema.parse(fact))
    .filter((fact) => fact.state === "active")
    .filter((fact) => fact.source.allowedPurposeIds.includes("customer_success.account.read"));
  const byKey = new Map<string, CustomerFactRevision[]>();
  for (const fact of facts) {
    const group = byKey.get(fact.factKey) || [];
    group.push(fact);
    byKey.set(fact.factKey, group);
  }
  const views = facts.map((fact) => {
    const candidates = byKey.get(fact.factKey) || [];
    const conflictIds = candidates
      .filter((candidate) => candidate.valueSha256 !== fact.valueSha256)
      .map((candidate) => candidate.factId)
      .sort();
    return customerFactViewSchema.parse({
      fact,
      freshness: customerFactFreshness(fact, evaluatedAt),
      conflict: {
        state: conflictIds.length ? "conflicting" : "none",
        conflictingFactIds: conflictIds,
      },
    });
  }).sort((left, right) =>
    left.fact.kind.localeCompare(right.fact.kind) ||
    left.fact.factKey.localeCompare(right.fact.factKey) ||
    left.fact.factId.localeCompare(right.fact.factId)
  );
  const factsByKind = Object.fromEntries(
    CUSTOMER_FACT_KINDS.map((kind) => [
      kind,
      views.filter((view) => view.fact.kind === kind),
    ]),
  );
  return customerAccount360Schema.parse({
    account,
    facts: views,
    factsByKind,
    historyCount: input.historyCount,
    conflictCount: views.filter((view) => view.conflict.state === "conflicting").length,
    staleCount: views.filter((view) => view.freshness.status === "stale").length,
    evaluatedAt,
  });
}

function customerFactFreshness(
  fact: CustomerFactRevision,
  evaluatedAt: string,
) {
  let status: "fresh" | "stale" | "future" | "expired" | "unknown";
  if (fact.validFrom > evaluatedAt) status = "future";
  else if (fact.validTo !== null && fact.validTo <= evaluatedAt) status = "expired";
  else if (fact.staleAfter === null) status = "unknown";
  else if (fact.staleAfter <= evaluatedAt) status = "stale";
  else status = "fresh";
  return {
    status,
    observedAt: fact.source.observedAt,
    staleAfter: fact.staleAfter,
    evaluatedAt,
  };
}

function requireAmountCurrencyPair(
  value: { amountMinor: number | null; currency: string | null },
  context: z.RefinementCtx,
) {
  if ((value.amountMinor !== null) !== (value.currency !== null)) {
    context.addIssue({
      code: "custom",
      path: ["currency"],
      message: "Amount and currency must be recorded together.",
    });
  }
}

function assertCanonicalUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  field: string,
) {
  if (new Set(values).size !== values.length ||
      [...values].sort().some((value, index) => value !== values[index])) {
    context.addIssue({
      code: "custom",
      path: [field],
      message: "Purpose identifiers must be unique and canonically sorted.",
    });
  }
}

function canonicalTimestamp(value: string) {
  return new Date(value).toISOString();
}
