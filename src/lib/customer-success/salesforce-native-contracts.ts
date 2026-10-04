import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const SALESFORCE_NATIVE_READ_CONTRACT = "customer-salesforce-action-read:1" as const;
export const SALESFORCE_NATIVE_REQUEST_CONTRACT = "customer-salesforce-action-request:1" as const;
export const salesforceNativeShaSchema = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/);
export const salesforceNativeWorkspaceSchema = z.string().max(240).regex(/^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const actor = z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
const generation = z.number().int().min(1).max(2_147_483_647);
const at = z.string().datetime().refine((value) => new Date(value).toISOString() === value);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const salesforceNativeActionKindSchema = z.enum(["sync", "reconcile", "disconnect"]);
export const salesforceNativeScopeSchema = z.object({ tenantId: id, workspaceId: salesforceNativeWorkspaceSchema, ownerActorId: actor }).strict();
const connectionBody = z.object({ ...salesforceNativeScopeSchema.shape,
  connectionId: z.string().regex(/^salesforce-connection:[a-f0-9]{64}$/), oauthGrantId: id,
  authorizationGeneration: generation, organizationIdSha256: salesforceNativeShaSchema,
  instanceOrigin: z.string().url().max(300).refine((value) => { try { const url = new URL(value); return url.protocol === "https:" && url.origin === value; } catch { return false; } }),
  connectionState: z.enum(["active", "revoked", "error"]), grantStatus: z.enum(["active", "revoked"]),
  grantAuthorizationGeneration: generation, readScopesGranted: z.boolean(),
}).strict();
export const salesforceNativeConnectionSchema = connectionBody.extend({ reviewSha256: salesforceNativeShaSchema }).strict().superRefine((value, context) => {
  const { reviewSha256, ...body } = value;
  if (reviewSha256 !== canonicalJsonSha256(body)) context.addIssue({ code: "custom", message: "Salesforce connection review digest differs." });
});
export type SalesforceNativeConnection = z.infer<typeof salesforceNativeConnectionSchema>;
export function sealSalesforceNativeConnection(value: z.input<typeof connectionBody>) {
  const body = connectionBody.parse(value); return salesforceNativeConnectionSchema.parse({ ...body, reviewSha256: canonicalJsonSha256(body) });
}
export const salesforceNativeRequestSchema = z.object({ contract: z.literal(SALESFORCE_NATIVE_REQUEST_CONTRACT), workspaceId: salesforceNativeWorkspaceSchema,
  action: salesforceNativeActionKindSchema, review: salesforceNativeConnectionSchema }).strict().superRefine((value, context) => {
  if (value.workspaceId !== value.review.workspaceId || value.review.connectionState !== "active" || value.review.grantStatus !== "active" ||
    value.review.authorizationGeneration !== value.review.grantAuthorizationGeneration || (value.action !== "disconnect" && !value.review.readScopesGranted) ||
    (value.action === "disconnect" && value.review.grantAuthorizationGeneration === 2_147_483_647)) {
    context.addIssue({ code: "custom", message: "An exact active Salesforce authorization must be reviewed." });
  }
});
export const salesforceNativeIntentSchema = z.object({ contract: z.literal("customer-salesforce-action-intent:1"), scope: salesforceNativeScopeSchema,
  idempotencyKeySha256: salesforceNativeShaSchema, request: salesforceNativeRequestSchema }).strict().superRefine((value, context) => {
  if (Object.entries(value.scope).some(([key, expected]) => value.request.review[key as keyof typeof value.scope] !== expected)) {
    context.addIssue({ code: "custom", message: "Salesforce intent scope differs from its reviewed owner." });
  }
});
export type SalesforceNativeRequest = z.infer<typeof salesforceNativeRequestSchema>;
export type SalesforceNativeIntent = z.infer<typeof salesforceNativeIntentSchema>;
export type SalesforceNativeScope = z.infer<typeof salesforceNativeScopeSchema>;
export function buildSalesforceNativeIntent(input: { scope: SalesforceNativeScope; request: SalesforceNativeRequest; idempotencyKey: string }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,511}$/.test(input.idempotencyKey)) throw new Error("A stable Idempotency-Key is required.");
  return salesforceNativeIntentSchema.parse({ contract: "customer-salesforce-action-intent:1", scope: input.scope, request: input.request,
    idempotencyKeySha256: createHash("sha256").update(`${input.scope.tenantId}\0${input.idempotencyKey}`).digest("hex") });
}
export function salesforceNativeActionId(scope: SalesforceNativeScope, keySha256: string) {
  return `salesforce-action:${canonicalJsonSha256({ contract: "customer-salesforce-action-id:1", scope, idempotencyKeySha256: keySha256 })}`;
}
const acceptanceBody = z.object({ contract: z.literal("customer-salesforce-action-acceptance:1"),
  id: z.string().regex(/^salesforce-action:[a-f0-9]{64}$/), scope: salesforceNativeScopeSchema,
  action: salesforceNativeActionKindSchema, idempotencyKeySha256: salesforceNativeShaSchema, requestSha256: salesforceNativeShaSchema,
  review: salesforceNativeConnectionSchema, acceptedAt: at, localRevoked: z.boolean() }).strict();
export const salesforceNativeAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: salesforceNativeShaSchema }).strict().superRefine((value, context) => {
  const { acceptanceSha256, ...body } = value;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || value.id !== salesforceNativeActionId(value.scope, value.idempotencyKeySha256) ||
    value.localRevoked !== (value.action === "disconnect") || Object.entries(value.scope).some(([key, expected]) => value.review[key as keyof SalesforceNativeScope] !== expected)) {
    context.addIssue({ code: "custom", message: "Salesforce acceptance identity or digest differs." });
  }
  const intent = salesforceNativeIntentSchema.safeParse({ contract: "customer-salesforce-action-intent:1", scope: value.scope,
    idempotencyKeySha256: value.idempotencyKeySha256, request: { contract: SALESFORCE_NATIVE_REQUEST_CONTRACT,
      workspaceId: value.scope.workspaceId, action: value.action, review: value.review } });
  if (!intent.success || canonicalJsonSha256(intent.data) !== value.requestSha256) context.addIssue({ code: "custom", message: "Salesforce acceptance request digest differs." });
});
export type SalesforceNativeAcceptance = z.infer<typeof salesforceNativeAcceptanceSchema>;
export function buildSalesforceNativeAcceptance(intent: SalesforceNativeIntent, acceptedAt: string) {
  const body = acceptanceBody.parse({ contract: "customer-salesforce-action-acceptance:1", id: salesforceNativeActionId(intent.scope, intent.idempotencyKeySha256),
    scope: intent.scope, action: intent.request.action, idempotencyKeySha256: intent.idempotencyKeySha256, requestSha256: canonicalJsonSha256(intent),
    review: intent.request.review, acceptedAt, localRevoked: intent.request.action === "disconnect" });
  return salesforceNativeAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) });
}
export const salesforceNativeSettlementSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("sync"), status: z.enum(["healthy", "partial"]), pages: count, records: count, advanced: count, conflicts: count,
    projection: z.object({ examined: count, projected: count, held: count, failed: count }).strict(), settledAt: at }).strict(),
  z.object({ action: z.literal("reconcile"), status: z.literal("complete"), checked: count, findings: count, settledAt: at }).strict(),
  z.object({ action: z.literal("disconnect"), status: z.literal("local_revoked"), providerRevocation: z.enum(["revoked", "not_supported", "unconfirmed"]), settledAt: at }).strict(),
]);
export type SalesforceNativeSettlement = z.infer<typeof salesforceNativeSettlementSchema>;
export const salesforceNativeActionSchema = z.object({ acceptance: salesforceNativeAcceptanceSchema, state: z.enum(["accepted", "settled"]),
  settlement: salesforceNativeSettlementSchema.nullable() }).strict().superRefine((value, context) => {
  if ((value.state === "settled") !== Boolean(value.settlement) || (value.settlement && (value.settlement.action !== value.acceptance.action ||
    value.settlement.settledAt < value.acceptance.acceptedAt))) context.addIssue({ code: "custom", message: "Salesforce action settlement differs from its admission." });
  if (value.settlement?.action === "sync" && value.settlement.projection.examined !== value.settlement.projection.projected + value.settlement.projection.held + value.settlement.projection.failed) {
    context.addIssue({ code: "custom", message: "Salesforce projection counters differ." });
  }
});
export type SalesforceNativeAction = z.infer<typeof salesforceNativeActionSchema>;
export const salesforceNativeCurrentSchema = z.object({ connection: salesforceNativeConnectionSchema.nullable(),
  availableActions: z.array(salesforceNativeActionKindSchema).max(3), blockedAction: salesforceNativeActionSchema.nullable(), busy: z.boolean() }).strict().superRefine((value, context) => {
  if (new Set(value.availableActions).size !== value.availableActions.length || (value.availableActions.length && (!value.connection || value.busy || value.blockedAction ||
    value.connection.connectionState !== "active" || value.connection.grantStatus !== "active" || value.connection.authorizationGeneration !== value.connection.grantAuthorizationGeneration)) ||
    (value.blockedAction && value.blockedAction.state !== "accepted")) context.addIssue({ code: "custom", message: "Salesforce action availability is inconsistent." });
});
export class SalesforceNativeError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); this.name = "SalesforceNativeError"; }
}
