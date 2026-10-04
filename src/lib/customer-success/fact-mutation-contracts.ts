import { z } from "zod";
import { customerFactId, customerFactOwnerSchema, customerFactRevisionSchema, customerFactSourceSchema, customerFactValueSchema,
  customerMutationId, type CustomerFactRevision } from "@/lib/customer-success/contracts";
import { CUSTOMER_FACT_KINDS } from "@/lib/customer-success/fact-kinds";
import { canonicalJsonSha256, idempotencyKeySha256 } from "@/lib/tools/effect-receipt";

export const CUSTOMER_FACT_NATIVE_REQUEST_CONTRACT = "customer-fact-mutation-request:1" as const;
export const CUSTOMER_FACT_NATIVE_READ_CONTRACT = "customer-fact-mutation-read:1" as const;
export const CUSTOMER_FACT_NATIVE_REVISION_MAX = 2_147_483_647;
const revision = z.number().int().min(1).max(CUSTOMER_FACT_NATIVE_REVISION_MAX);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const opaque = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const actor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const customerFactNativeWorkspaceSchema = opaque.regex(/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const customerFactNativeAccountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const factId = z.string().regex(/^customer-fact:[a-f0-9]{64}$/);
const mutationId = z.string().regex(/^customer-mutation:[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const valueSchema = customerFactValueSchema.superRefine((value, context) => {
  if ((value.kind === "opportunity" || value.kind === "renewal") && value.amountMinor !== null && !Number.isSafeInteger(value.amountMinor)) {
    context.addIssue({ code: "custom", message: "Fact money must be a safe integer." });
  }
});
const fields = z.object({
  expectedAccountRevision: revision, expectedAccountSha256: sha, operation: z.enum(["create", "revise", "retract"]),
  factId: factId.nullable(), expectedFactRevision: revision.nullable(), expectedFactSha256: sha.nullable(),
  factKey: z.string().trim().min(1).max(160).regex(/^[a-z0-9][a-z0-9._:-]*$/), value: valueSchema,
  owner: customerFactOwnerSchema, confidenceBasisPoints: z.number().int().min(0).max(10_000),
  validFrom: at, validTo: at.nullable(), staleAfter: at.nullable(), manualSource: z.object({ label: z.string().trim().min(1).max(240), observedAt: at }).strict(),
  allowedPurposeIds: customerFactSourceSchema.shape.allowedPurposeIds.refine((purposes) => purposes.includes("customer_success.account.read") &&
    new Set(purposes).size === purposes.length && [...purposes].sort().every((purpose, index) => purpose === purposes[index])),
}).strict();
function pins(value: z.infer<typeof fields>, context: z.RefinementCtx) {
  if (value.operation === "create" ? value.factId !== null || value.expectedFactRevision !== null || value.expectedFactSha256 !== null
    : value.factId === null || value.expectedFactRevision === null || value.expectedFactSha256 === null || value.expectedFactRevision >= CUSTOMER_FACT_NATIVE_REVISION_MAX) {
    context.addIssue({ code: "custom", message: "Fact operation requires its exact bounded prior revision pins." });
  }
  if ((value.validTo !== null && value.validTo <= value.validFrom) ||
    (value.staleAfter !== null && value.staleAfter <= value.manualSource.observedAt)) {
    context.addIssue({ code: "custom", message: "Fact validity and freshness intervals are inconsistent." });
  }
}
export const customerFactNativeRequestSchema = fields.extend({
  contract: z.literal(CUSTOMER_FACT_NATIVE_REQUEST_CONTRACT), workspaceId: customerFactNativeWorkspaceSchema,
}).strict().superRefine(pins);
export const customerFactNativeIntentSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal("customer-fact-mutation-intent:1"), tenantId: opaque,
  workspaceId: customerFactNativeWorkspaceSchema, accountId: customerFactNativeAccountIdSchema, canonicalActorId: actor,
  factId, mutationId, idempotencyKeySha256: sha, request: fields.superRefine(pins),
}).strict().superRefine((value, context) => {
  if (value.request.factId !== null && value.request.factId !== value.factId) context.addIssue({ code: "custom", message: "Fact intent targets another fact." });
});
export const customerFactNativeCurrentAccountSchema = z.object({ accountId: customerFactNativeAccountIdSchema,
  revisionId: opaque, revision, accountSha256: sha }).strict().refine((value) => value.revisionId === `${value.accountId}:v${value.revision}`);
const acceptanceBody = z.object({
  schemaVersion: z.literal(1), contract: z.literal("customer-fact-mutation-acceptance:1"), operation: z.enum(["create", "revise", "retract"]),
  tenantId: opaque, workspaceId: customerFactNativeWorkspaceSchema, accountId: customerFactNativeAccountIdSchema, canonicalActorId: actor,
  idempotencyKeySha256: sha, requestSha256: sha, mutationId, factId, factRevisionId: opaque, factRevision: revision,
  factSha256: sha, factKey: fields.shape.factKey, kind: z.enum(CUSTOMER_FACT_KINDS), state: z.enum(["active", "retracted"]), valueSha256: sha,
  reviewedAccountRevisionId: opaque, reviewedAccountRevision: revision, reviewedAccountSha256: sha,
  expectedFactRevision: revision.nullable(), expectedFactSha256: sha.nullable(),
  sourceRevisionId: opaque, sourceRevisionSha256: sha, sourceKind: z.literal("manual"), permissionBasis: z.literal("operator_assertion"), recordedAt: at,
}).strict();
export const customerFactNativeAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: sha }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  if (canonicalJsonSha256(body) !== acceptanceSha256 || value.factRevisionId !== `${value.factId}:v${value.factRevision}` ||
    value.reviewedAccountRevisionId !== `${value.accountId}:v${value.reviewedAccountRevision}` ||
    value.state !== (value.operation === "retract" ? "retracted" : "active") ||
    value.sourceRevisionId !== `customer-manual-source:${value.requestSha256}:v1` ||
    value.sourceRevisionSha256 !== manualSourceDigest(value) ||
    (value.operation === "create" ? value.factRevision !== 1 || value.expectedFactRevision !== null || value.expectedFactSha256 !== null
      : value.expectedFactRevision === null || value.expectedFactSha256 === null || value.factRevision !== value.expectedFactRevision + 1)) {
    context.addIssue({ code: "custom", message: "Manual fact acceptance identity, pins or digest is inconsistent." });
  }
});
export type CustomerFactNativeRequest = z.infer<typeof customerFactNativeRequestSchema>;
export type CustomerFactNativeIntent = z.infer<typeof customerFactNativeIntentSchema>;
export type CustomerFactNativeAcceptance = z.infer<typeof customerFactNativeAcceptanceSchema>;
export type CustomerFactNativeCurrentAccount = z.infer<typeof customerFactNativeCurrentAccountSchema>;

export function buildCustomerFactNativeIntent(input: { tenantId: string; workspaceId: string; accountId: string; canonicalActorId: string;
  idempotencyKey: string; request: CustomerFactNativeRequest }): CustomerFactNativeIntent {
  const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/).parse(input.idempotencyKey);
  const full = customerFactNativeRequestSchema.parse(input.request);
  if (full.workspaceId !== input.workspaceId) throw new Error("Reviewed fact workspace differs from current authority.");
  const { contract: _contract, workspaceId: _workspaceId, ...request } = full; void _contract; void _workspaceId;
  return customerFactNativeIntentSchema.parse({ schemaVersion: 1, contract: "customer-fact-mutation-intent:1",
    tenantId: input.tenantId, workspaceId: input.workspaceId, accountId: input.accountId, canonicalActorId: input.canonicalActorId,
    factId: request.factId ?? customerFactId({ accountId: input.accountId, idempotencyKey: key }),
    mutationId: customerMutationId({ accountId: input.accountId, idempotencyKey: key, operation: "fact.record" }),
    idempotencyKeySha256: idempotencyKeySha256({ tenantId: input.tenantId, idempotencyKey: key }), request });
}
function manualSourceDigest(value: { tenantId: string; workspaceId: string; accountId: string; canonicalActorId: string; requestSha256: string }) {
  return canonicalJsonSha256({ contract: "customer-manual-source:1", tenantId: value.tenantId, workspaceId: value.workspaceId,
    accountId: value.accountId, canonicalActorId: value.canonicalActorId, requestSha256: value.requestSha256 });
}
export function buildCustomerFactNativeSource(intent: CustomerFactNativeIntent, recordedAt: string) {
  const requestSha256 = canonicalJsonSha256(intent), sourceId = `customer-manual-source:${requestSha256}`;
  return customerFactSourceSchema.parse({ sourceKind: "manual", sourceId, sourceRevisionId: `${sourceId}:v1`,
    sourceRevisionSha256: manualSourceDigest({ ...intent, requestSha256 }), sourceLabel: intent.request.manualSource.label,
    providerId: null, providerObjectType: null, providerObjectIdSha256: null, permissionBasis: "operator_assertion",
    allowedPurposeIds: intent.request.allowedPurposeIds, observedAt: intent.request.manualSource.observedAt, ingestedAt: recordedAt });
}
export function buildCustomerFactNativeAcceptance(intentValue: CustomerFactNativeIntent, factValue: CustomerFactRevision): CustomerFactNativeAcceptance {
  const intent = customerFactNativeIntentSchema.parse(intentValue), fact = customerFactRevisionSchema.parse(factValue), request = intent.request;
  if (fact.tenantId !== intent.tenantId || fact.workspaceId !== intent.workspaceId || fact.accountId !== intent.accountId ||
    fact.factId !== intent.factId || fact.mutationId !== intent.mutationId || fact.recordedByActorId !== intent.canonicalActorId ||
    fact.revision !== (request.expectedFactRevision ?? 0) + 1 || fact.factKey !== request.factKey ||
    fact.state !== (request.operation === "retract" ? "retracted" : "active") || fact.valueSha256 !== canonicalJsonSha256(request.value) ||
    canonicalJsonSha256(fact.owner) !== canonicalJsonSha256(request.owner) || fact.confidenceBasisPoints !== request.confidenceBasisPoints ||
    fact.validFrom !== request.validFrom || fact.validTo !== request.validTo || fact.staleAfter !== request.staleAfter ||
    canonicalJsonSha256(fact.source) !== canonicalJsonSha256(buildCustomerFactNativeSource(intent, fact.recordedAt))) {
    throw new Error("Accepted fact does not bind the exact manual intent and author.");
  }
  const body = acceptanceBody.parse({ schemaVersion: 1, contract: "customer-fact-mutation-acceptance:1", operation: request.operation,
    tenantId: intent.tenantId, workspaceId: intent.workspaceId, accountId: intent.accountId, canonicalActorId: intent.canonicalActorId,
    idempotencyKeySha256: intent.idempotencyKeySha256, requestSha256: canonicalJsonSha256(intent), mutationId: intent.mutationId,
    factId: fact.factId, factRevisionId: fact.factRevisionId, factRevision: fact.revision, factSha256: fact.factSha256,
    factKey: fact.factKey, kind: fact.kind, state: fact.state, valueSha256: fact.valueSha256,
    reviewedAccountRevisionId: `${intent.accountId}:v${request.expectedAccountRevision}`, reviewedAccountRevision: request.expectedAccountRevision,
    reviewedAccountSha256: request.expectedAccountSha256, expectedFactRevision: request.expectedFactRevision, expectedFactSha256: request.expectedFactSha256,
    sourceRevisionId: fact.source.sourceRevisionId, sourceRevisionSha256: fact.source.sourceRevisionSha256,
    sourceKind: "manual", permissionBasis: "operator_assertion", recordedAt: fact.recordedAt });
  return customerFactNativeAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
}
