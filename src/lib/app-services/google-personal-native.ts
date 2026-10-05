import { authorizeAppServiceCall,completeAppServiceCall,type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { googleConnectorAccountPolicyForIdentity,revokeOAuthAccess } from "@/lib/connectors/oauth-providers";
import { syncPersonalProvider } from "@/lib/connectors/personal-sync";
import { GOOGLE_PERSONAL_NATIVE_READ_CONTRACT,GooglePersonalNativeError,googlePersonalNativeRequestSchema } from "@/lib/connectors/google-personal-native-contracts";
import { admitGooglePersonalNativeAction,googlePersonalNativeSyncExecution,mayRevokeGooglePersonalNativeToken,readGooglePersonalNativeAction,reviewGooglePersonalNativeActions,
  settleGooglePersonalNativeAction,type GooglePersonalNativeAuthority } from "@/lib/connectors/google-personal-native-store";
import { assertNativeGooglePersonalScope,nativeGooglePersonalSchemas as schemas } from "@/lib/mobile/google-personal-native-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
import { assertNativePrivateActionMutation } from "@/lib/memory/private-action-store";
function authority(caller: AppServiceCaller,connectionId?: string): GooglePersonalNativeAuthority {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical || !caller.context.auth?.email) throw new GooglePersonalNativeError("google_personal_authority",403,"A current authenticated account is required.");
  let account;
  try { account = googleConnectorAccountPolicyForIdentity({ tenantId: caller.context.tenantId,email: caller.context.auth.email }); }
  catch { throw new GooglePersonalNativeError("google_personal_account",403,"The current account's Google policy is unavailable."); }
  const scope = { tenantId: caller.context.tenantId,ownerActorId: caller.context.actorId,canonicalActorId: canonical.actorId };
  if (connectionId !== undefined) {
    if (!caller.idempotencyKey) throw new GooglePersonalNativeError("google_personal_key",400,"A stable request key is required.");
    const source = assertNativePrivateActionMutation({ scope,executionScope: caller.executionScope },"api.google.personal.action",connectionId);
    return { scope,accountEmail: account.email,executionScope: deriveExecutionScope(source,{ purpose: "connector.google.personal.native_action" }) };
  }
  if (caller.executionScope || caller.idempotencyKey) throw new GooglePersonalNativeError("google_personal_authority",403,"Google reads require read-only authority.");
  return { scope,accountEmail: account.email };
}
const expected = (caller: AppServiceCaller,owner: GooglePersonalNativeAuthority) => ({ scope: owner.scope,requestActorId: caller.context.actorId,role: caller.context.role,executionScope: caller.executionScope });
export async function reviewGooglePersonalNativeService(caller: AppServiceCaller) {
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.google.personal.actions.review")),owner = authority(caller);
  const current = await reviewGooglePersonalNativeActions(owner,canPerform(caller.context.role,"write.memory"));
  const result = completeAppServiceCall(authorized,{ contract: GOOGLE_PERSONAL_NATIVE_READ_CONTRACT,scope: owner.scope,...current },{ resourceCount: current.current.connection ? 1 : 0 });
  assertNativeGooglePersonalScope(schemas.NativeGooglePersonalReviewResponse.parse({ ...result.data,serviceReceipt: result.receipt }),expected(caller,owner)); return result;
}
export async function readGooglePersonalNativeService(caller: AppServiceCaller,keySha256: string) {
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.google.personal.actions.read")),owner = authority(caller);
  const current = await readGooglePersonalNativeAction(owner,keySha256,canPerform(caller.context.role,"write.memory"));
  const result = completeAppServiceCall(authorized,{ contract: GOOGLE_PERSONAL_NATIVE_READ_CONTRACT,scope: owner.scope,...current },{ resourceCount: current.action ? 1 : 0 });
  assertNativeGooglePersonalScope(schemas.NativeGooglePersonalReadResponse.parse({ ...result.data,serviceReceipt: result.receipt }),{ ...expected(caller,owner),keySha256 }); return result;
}
export async function submitGooglePersonalNativeService(caller: AppServiceCaller,body: unknown,abortSignal?: AbortSignal) {
  const request = googlePersonalNativeRequestSchema.parse(body),authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.google.personal.actions.submit"));
  const owner = authority(caller,request.review.connectionId),admitted = await admitGooglePersonalNativeAction({ authority: owner,request,idempotencyKey: caller.idempotencyKey! });
  if (admitted.newlyAccepted) {
    try {
      if (request.action === "disconnect") {
        let providerRevocation: "revoked"|"unconfirmed" = "unconfirmed";
        if (!abortSignal?.aborted && admitted.providerToken && await mayRevokeGooglePersonalNativeToken(owner,admitted.intent)) {
          try { if (await revokeOAuthAccess("google",admitted.providerToken)) providerRevocation = "revoked"; }
          catch { /* Only local revocation is proven when the old provider token is unconfirmed. */ }
        }
        await settleGooglePersonalNativeAction(owner,admitted.intent,{ action: "disconnect",status: "local_revoked",providerRevocation,settledAt: new Date().toISOString() });
      } else {
        abortSignal?.throwIfAborted(); if (!admitted.lease) throw new Error("The accepted Google lease is unavailable.");
        const observed = await syncPersonalProvider({ tenantId: owner.scope.tenantId,actorId: owner.scope.ownerActorId,provider: "google",connectionId: request.review.connectionId,
          sources: request.review.permittedSources,expectedAuthorizationGeneration: request.review.authorizationGeneration,expectedAccountEmail: owner.accountEmail,abortSignal,
          native: googlePersonalNativeSyncExecution(owner,admitted.intent,admitted.lease) });
        if (observed.status === "error" || observed.grant.id !== request.review.connectionId || observed.grant.actorId !== owner.scope.ownerActorId ||
          observed.grant.tenantId !== owner.scope.tenantId || observed.grant.accountEmail !== owner.accountEmail || observed.grant.authorizationGeneration !== request.review.authorizationGeneration)
          throw new Error("The complete exact Google source settlement is unavailable.");
        await settleGooglePersonalNativeAction(owner,admitted.intent,{ action: "sync",status: observed.status,imported: observed.imported,removed: observed.removed,
          cursorAdvanced: observed.cursorAdvanced,sources: observed.sources.map((source) => { if (source.status === "error" || !source.lastSuccessfulAt) throw new Error("A Google source remains unconfirmed.");
            return { source: source.source,status: source.status,backfillState: source.backfillState,imported: source.imported,removed: source.removed,
              lastAttemptedAt: source.lastAttemptedAt,lastSuccessfulAt: source.lastSuccessfulAt }; }),settledAt: new Date().toISOString() });
      }
    } catch { /* Unknown work remains accepted. GET and same-key replay never repeat it. */ }
  }
  const current = await readGooglePersonalNativeAction({ scope: owner.scope,accountEmail: owner.accountEmail },admitted.intent.idempotencyKeySha256,canPerform(caller.context.role,"write.memory"));
  if (!current.action) throw new GooglePersonalNativeError("google_personal_unconfirmed",503,"The accepted Google receipt is temporarily unavailable. Recover the exact request.");
  const result = completeAppServiceCall(authorized,{ contract: GOOGLE_PERSONAL_NATIVE_READ_CONTRACT,scope: owner.scope,...current,action: current.action,replayed: !admitted.newlyAccepted },{ resourceCount: 1 });
  assertNativeGooglePersonalScope(schemas.NativeGooglePersonalSubmitResponse.parse({ ...result.data,serviceReceipt: result.receipt }),
    { ...expected(caller,owner),request,idempotencyKey: caller.idempotencyKey }); return result;
}
