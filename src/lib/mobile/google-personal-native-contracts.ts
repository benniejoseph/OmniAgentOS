import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION,appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { GOOGLE_PERSONAL_NATIVE_READ_CONTRACT,buildGooglePersonalNativeIntent,googlePersonalNativeActionSchema,googlePersonalNativeCurrentSchema,
  googlePersonalNativeRequestSchema,googlePersonalNativeScopeSchema,type GooglePersonalNativeRequest,type GooglePersonalNativeScope } from "@/lib/connectors/google-personal-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { ExecutionScope } from "@/lib/security/execution-scope";
const base = { contract: z.literal(GOOGLE_PERSONAL_NATIVE_READ_CONTRACT),scope: googlePersonalNativeScopeSchema,current: googlePersonalNativeCurrentSchema };
type Kind = "review"|"submit"|"read";
type Body = { contract: string;scope: GooglePersonalNativeScope;current: z.infer<typeof googlePersonalNativeCurrentSchema>;
  action: z.infer<typeof googlePersonalNativeActionSchema>|null;serviceReceipt: z.infer<typeof appServiceReceiptSchema>;replayed?: boolean };
const issue = (c: z.RefinementCtx,message: string) => c.addIssue({ code: "custom",message });
function bind(kind: Kind) { return (v: Body,c: z.RefinementCtx) => {
  const { serviceReceipt: r,...body } = v,mutation = kind === "submit",count = kind === "review" ? Number(Boolean(v.current.connection)) : Number(Boolean(v.action));
  if (r.operation !== `app.google.personal.actions.${kind}` || r.resourceType !== "oauth_grant" || r.action !== (mutation ? "write.memory" : "read") ||
    r.accessMode !== (mutation ? "mutation" : "read") || r.eventContract !== (mutation ? "google-personal-native-events.v1" : "read_only:no_domain_mutation") ||
    r.resourceCount !== count || r.outcomeSha256 !== canonicalJsonSha256(body) || (r.idempotencyKeySha256 !== null) !== mutation)
    issue(c,"Google service receipt does not bind this exact response.");
  for (const a of [v.action,v.current.blockedAction]) if (a && canonicalJsonSha256(a.acceptance.scope) !== canonicalJsonSha256(v.scope)) issue(c,"Google response mixes owners.");
  if (mutation && (!v.action || r.idempotencyKeySha256 !== v.action.acceptance.idempotencyKeySha256)) issue(c,"Google mutation receipt names another accepted key.");
}; }
export const nativeGooglePersonalReviewResponseSchema = z.object({ ...base,action: z.null(),serviceReceipt: appServiceReceiptSchema }).strict().superRefine(bind("review"));
export const nativeGooglePersonalReadResponseSchema = z.object({ ...base,action: googlePersonalNativeActionSchema.nullable(),serviceReceipt: appServiceReceiptSchema }).strict().superRefine(bind("read"));
export const nativeGooglePersonalSubmitResponseSchema = z.object({ ...base,action: googlePersonalNativeActionSchema,replayed: z.boolean(),serviceReceipt: appServiceReceiptSchema }).strict().superRefine(bind("submit"));
export function assertNativeGooglePersonalScope(v: Body,e: { scope: GooglePersonalNativeScope;requestActorId: string;role: string;executionScope?: ExecutionScope;
  keySha256?: string;request?: GooglePersonalNativeRequest;idempotencyKey?: string }) {
  if (canonicalJsonSha256(v.scope) !== canonicalJsonSha256(e.scope) || v.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: e.scope.tenantId,actorId: e.requestActorId,role: e.role,executionScope: e.executionScope ?? null })) throw new Error("Google response belongs to another current authority.");
  if (e.keySha256 && v.action && v.action.acceptance.idempotencyKeySha256 !== e.keySha256) throw new Error("Google recovery returned another key.");
  if (e.request && e.idempotencyKey) { const intent = buildGooglePersonalNativeIntent({ scope: e.scope,request: e.request,idempotencyKey: e.idempotencyKey });
    if (!v.action || v.action.acceptance.requestSha256 !== canonicalJsonSha256(intent) || v.action.acceptance.idempotencyKeySha256 !== intent.idempotencyKeySha256)
      throw new Error("Google response differs from the frozen request."); }
}
export const nativeGooglePersonalSchemas = Object.freeze({ NativeGooglePersonalRequest: googlePersonalNativeRequestSchema,NativeGooglePersonalCurrent: googlePersonalNativeCurrentSchema,
  NativeGooglePersonalAction: googlePersonalNativeActionSchema,NativeGooglePersonalReviewResponse: nativeGooglePersonalReviewResponseSchema,NativeGooglePersonalReadResponse: nativeGooglePersonalReadResponseSchema,
  NativeGooglePersonalSubmitResponse: nativeGooglePersonalSubmitResponseSchema,NativeGooglePersonalError: z.object({ error: z.string().min(1).max(4000),code: z.string().min(1).max(200).optional(),message: z.string().max(4000).optional() }).strict() });
