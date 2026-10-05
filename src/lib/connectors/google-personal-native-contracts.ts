import { z } from "zod";
import { privateActionIdSchema as id,privateActionScopeSchema,privateActionShaSchema as sha,privateActionKeySha256,type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
export const GOOGLE_PERSONAL_NATIVE_READ_CONTRACT = "asael-google-personal-actions-read:1" as const;
export const googlePersonalNativeSourceSchema = z.enum(["mail","calendar","drive"]);
const sourceOrder = ["mail","calendar","drive"] as const;
export const googlePersonalNativeSourcesSchema = z.array(googlePersonalNativeSourceSchema).max(3).refine((v) =>
  v.every((source,index) => sourceOrder.indexOf(source) > (index ? sourceOrder.indexOf(v[index-1]) : -1)),"Sources must be unique and in their canonical order.");
export const googlePersonalNativeKindSchema = z.enum(["sync","disconnect"]);
export const googlePersonalNativeScopeSchema = privateActionScopeSchema;
const at = z.string().datetime({ offset: true }),count = z.number().int().min(0).max(2_147_483_647);
const reviewBody = z.object({ connectionId: id,accountEmail: z.string().email().max(320),authorizationGeneration: count.min(1),
  status: z.enum(["active","revoked"]),sourceScopeSha256: sha,permittedSources: googlePersonalNativeSourcesSchema }).strict();
export const googlePersonalNativeReviewSchema = reviewBody.extend({ reviewSha256: sha }).strict().superRefine((v,c) => {
  const { reviewSha256,...body } = v;
  if (reviewSha256 !== canonicalJsonSha256(body)) c.addIssue({ code: "custom",message: "Google review does not bind its exact authorization." });
});
export function sealGooglePersonalNativeReview(input: z.input<typeof reviewBody>) { const body = reviewBody.parse(input); return googlePersonalNativeReviewSchema.parse({ ...body,reviewSha256: canonicalJsonSha256(body) }); }
export const googlePersonalNativeRequestSchema = z.object({ contract: z.literal("asael-google-personal-action:1"),action: googlePersonalNativeKindSchema,review: googlePersonalNativeReviewSchema }).strict()
  .refine((v) => v.review.status === "active" && (v.action !== "sync" || v.review.permittedSources.length>0) &&
    (v.action !== "disconnect" || v.review.authorizationGeneration<2_147_483_647),"The reviewed authorization does not permit this action.");
export const googlePersonalNativeIntentSchema = z.object({ contract: z.literal("asael-google-personal-intent:1"),scope: privateActionScopeSchema,
  idempotencyKeySha256: sha,request: googlePersonalNativeRequestSchema }).strict();
export type GooglePersonalNativeScope = PrivateActionScope;
export type GooglePersonalNativeRequest = z.infer<typeof googlePersonalNativeRequestSchema>;
export type GooglePersonalNativeIntent = z.infer<typeof googlePersonalNativeIntentSchema>;
export function buildGooglePersonalNativeIntent(input: { scope: GooglePersonalNativeScope;request: GooglePersonalNativeRequest;idempotencyKey: string }) {
  return googlePersonalNativeIntentSchema.parse({ contract: "asael-google-personal-intent:1",scope: input.scope,
    idempotencyKeySha256: privateActionKeySha256(input.scope,input.idempotencyKey),request: input.request });
}
export function googlePersonalNativeActionId(scope: GooglePersonalNativeScope,keySha256: string) {
  return `google-personal-action:${canonicalJsonSha256({ scope,idempotencyKeySha256: keySha256 })}`;
}
const acceptanceBody = z.object({ contract: z.literal("asael-google-personal-acceptance:1"),id: z.string().regex(/^google-personal-action:[a-f0-9]{64}$/),
  scope: privateActionScopeSchema,action: googlePersonalNativeKindSchema,idempotencyKeySha256: sha,requestSha256: sha,review: googlePersonalNativeReviewSchema,
  acceptedAt: at,localRevoked: z.boolean() }).strict();
export const googlePersonalNativeAcceptanceSchema = acceptanceBody.extend({ acceptanceSha256: sha }).strict().superRefine((v,c) => {
  const { acceptanceSha256,...body } = v;
  const intent = googlePersonalNativeIntentSchema.safeParse({ contract: "asael-google-personal-intent:1",scope: v.scope,idempotencyKeySha256: v.idempotencyKeySha256,
    request: { contract: "asael-google-personal-action:1",action: v.action,review: v.review } });
  if (v.id !== googlePersonalNativeActionId(v.scope,v.idempotencyKeySha256) || v.localRevoked !== (v.action === "disconnect") ||
    acceptanceSha256 !== canonicalJsonSha256(body) || !intent.success || v.requestSha256 !== canonicalJsonSha256(intent.data))
    c.addIssue({ code: "custom",message: "Google acceptance differs from the exact accepted intent." });
});
export function buildGooglePersonalNativeAcceptance(intent: GooglePersonalNativeIntent,acceptedAt: string) {
  const body = acceptanceBody.parse({ contract: "asael-google-personal-acceptance:1",id: googlePersonalNativeActionId(intent.scope,intent.idempotencyKeySha256),
    scope: intent.scope,action: intent.request.action,idempotencyKeySha256: intent.idempotencyKeySha256,requestSha256: canonicalJsonSha256(intent),review: intent.request.review,
    acceptedAt,localRevoked: intent.request.action === "disconnect" });
  return googlePersonalNativeAcceptanceSchema.parse({ ...body,acceptanceSha256: canonicalJsonSha256(body) });
}
const sourceSettlement = z.object({ source: googlePersonalNativeSourceSchema,status: z.enum(["syncing","healthy"]),backfillState: z.enum(["unknown","in_progress","complete"]),
  imported: count,removed: count,lastAttemptedAt: at,lastSuccessfulAt: at }).strict();
export const googlePersonalNativeSettlementSchema = z.discriminatedUnion("action",[
  z.object({ action: z.literal("sync"),status: z.enum(["healthy","partial"]),imported: count,removed: count,cursorAdvanced: z.boolean(),
    sources: z.array(sourceSettlement).min(1).max(3),settledAt: at }).strict(),
  z.object({ action: z.literal("disconnect"),status: z.literal("local_revoked"),providerRevocation: z.enum(["revoked","unconfirmed"]),settledAt: at }).strict(),
]);
export const googlePersonalNativeActionSchema = z.object({ acceptance: googlePersonalNativeAcceptanceSchema,state: z.enum(["accepted","settled"]),
  settlement: googlePersonalNativeSettlementSchema.nullable() }).strict().superRefine((v,c) => {
  const s = v.settlement,a = v.acceptance;
  if ((v.state === "settled") !== Boolean(s) || s && (s.action !== a.action || Date.parse(s.settledAt)<Date.parse(a.acceptedAt)))
    c.addIssue({ code: "custom",message: "Google settlement does not match its immutable acceptance." });
  if (s?.action === "sync" && (canonicalJsonSha256(s.sources.map((row) => row.source)) !== canonicalJsonSha256(a.review.permittedSources) ||
    s.imported !== s.sources.reduce((n,row) => n+row.imported,0) || s.removed !== s.sources.reduce((n,row) => n+row.removed,0) ||
    (s.status === "healthy") !== s.sources.every((row) => row.status === "healthy")))
    c.addIssue({ code: "custom",message: "Google settlement does not cover the complete permitted source set." });
});
export const googlePersonalNativeCurrentSchema = z.object({ connection: googlePersonalNativeReviewSchema.nullable(),availableActions: z.array(googlePersonalNativeKindSchema).max(2),
  blockedAction: googlePersonalNativeActionSchema.nullable(),busy: z.boolean() }).strict().superRefine((v,c) => {
  if (new Set(v.availableActions).size !== v.availableActions.length || v.blockedAction?.state === "settled" || v.availableActions.length &&
    (!v.connection || v.connection.status !== "active" || v.blockedAction || v.busy || v.availableActions.includes("sync") && !v.connection.permittedSources.length ||
      v.availableActions.includes("disconnect") && v.connection.authorizationGeneration>=2_147_483_647))
    c.addIssue({ code: "custom",message: "Google action availability differs from current authority." });
});
export type GooglePersonalNativeAction = z.infer<typeof googlePersonalNativeActionSchema>;
export type GooglePersonalNativeSettlement = z.infer<typeof googlePersonalNativeSettlementSchema>;
export type GooglePersonalNativeReview = z.infer<typeof googlePersonalNativeReviewSchema>;
export class GooglePersonalNativeError extends Error { constructor(readonly code: string,readonly status: number,message: string) { super(message); this.name = "GooglePersonalNativeError"; } }
