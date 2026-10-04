import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestSharedMemoryAccessFromSecurityContext } from "@/lib/memory/shared-context";
import { revokeOAuthAccess } from "@/lib/connectors/oauth-providers";
import { reconcileSalesforceWorkspace, syncSalesforceWorkspace } from "@/lib/customer-success/salesforce-sync";
import { SALESFORCE_NATIVE_READ_CONTRACT, SalesforceNativeError, salesforceNativeRequestSchema, type SalesforceNativeScope } from "@/lib/customer-success/salesforce-native-contracts";
import { admitSalesforceNativeAction, mayRevokeSalesforceNativeProviderToken, readSalesforceNativeAction, reviewSalesforceNativeActions,
  salesforceNativeLegacyAuthority, salesforceNativeSyncExecution, settleSalesforceNativeAction, type SalesforceNativeAuthority } from "@/lib/customer-success/salesforce-native-store";
import { assertNativeSalesforceResponseScope, nativeSalesforceActionQuerySchema, nativeSalesforceActionReadInputSchema,
  nativeSalesforceActionReadResponseSchema, nativeSalesforceActionReviewResponseSchema, nativeSalesforceActionSubmitResponseSchema } from "@/lib/mobile/salesforce-native-contracts";

async function authorityFor(caller: AppServiceCaller, workspaceId: string, connectionId?: string) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context), source = caller.executionScope, mutation = connectionId !== undefined;
  if (!canonical || (mutation ? !source || !caller.idempotencyKey || source.tenantId !== caller.context.tenantId || source.workspaceId !== workspaceId ||
    source.initiatingActorId !== caller.context.actorId || source.executingPrincipalType !== "user" || source.executingPrincipalId !== caller.context.actorId ||
    source.projectId !== null || source.missionId !== null || source.delegationId !== null || source.contextGrantIds.length || source.capabilityGrantIds.length ||
    source.purpose !== "api.customer-salesforce.action" || source.causationId !== connectionId : source !== undefined || caller.idempotencyKey !== undefined)) {
    throw new SalesforceNativeError("salesforce_action_authority", 403, "Current authenticated Salesforce action authority is required.");
  }
  const access = await requestSharedMemoryAccessFromSecurityContext(caller.context, { scope: "workspace", workspaceId,
    correlationId: source?.correlationId ?? crypto.randomUUID(), purposeId: mutation ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: mutation ? "Apply an exact reviewed Salesforce connection action." : "Read an exact Salesforce action receipt." });
  if (access.actorBinding.canonicalActorId !== canonical.actorId || access.authority.workspaceId !== workspaceId ||
    access.authority.initiatingActorId !== canonical.actorId || (mutation && !access.authority.canWrite)) {
    throw new SalesforceNativeError("salesforce_action_authority", 403, "Current canonical Salesforce workspace authority is required.");
  }
  const scope: SalesforceNativeScope = { tenantId: caller.context.tenantId, workspaceId, ownerActorId: canonical.actorId };
  const authority: SalesforceNativeAuthority = { scope, ...(mutation ? { executionScope: createExecutionScope({ tenantId: scope.tenantId, workspaceId,
    initiatingActorId: canonical.actorId, executingPrincipalType: "user", executingPrincipalId: canonical.actorId,
    correlationId: source!.correlationId, causationId: connectionId, purpose: "customer.salesforce.native_action" }) } : {}) };
  return { authority, context: { scope: "workspace" as const, workspaceId, accessLevel: access.authority.accessLevel,
    canWrite: access.authority.canWrite, authoritySha256: access.authority.authoritySha256 } };
}
export async function reviewSalesforceNativeActionsService(caller: AppServiceCaller, input: z.input<typeof nativeSalesforceActionQuerySchema>) {
  const query = nativeSalesforceActionQuerySchema.parse(input), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.salesforce.actions.review"));
  const { authority, context } = await authorityFor(caller, query.workspaceId), result = await reviewSalesforceNativeActions(authority, context.canWrite);
  const completed = completeAppServiceCall(authorized, { contract: SALESFORCE_NATIVE_READ_CONTRACT, context, ...result }, { resourceCount: result.current.connection ? 1 : 0 });
  const response = nativeSalesforceActionReviewResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeSalesforceResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role });
  return completed;
}
export async function readSalesforceNativeActionService(caller: AppServiceCaller, input: z.input<typeof nativeSalesforceActionReadInputSchema>) {
  const query = nativeSalesforceActionReadInputSchema.parse(input), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.salesforce.actions.show"));
  const { authority, context } = await authorityFor(caller, query.workspaceId), result = await readSalesforceNativeAction(authority, query.keySha256, context.canWrite);
  const completed = completeAppServiceCall(authorized, { contract: SALESFORCE_NATIVE_READ_CONTRACT, context, ...result }, { resourceCount: result.action ? 1 : 0 });
  const response = nativeSalesforceActionReadResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeSalesforceResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role, keySha256: query.keySha256 });
  return completed;
}
export async function submitSalesforceNativeActionService(caller: AppServiceCaller, input: z.input<typeof salesforceNativeRequestSchema>, abortSignal?: AbortSignal) {
  const request = salesforceNativeRequestSchema.parse(input), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.salesforce.actions.submit"));
  const { authority, context } = await authorityFor(caller, request.workspaceId, request.review.connectionId);
  const admitted = await admitSalesforceNativeAction({ authority, request, idempotencyKey: caller.idempotencyKey! });
  if (admitted.newlyAccepted) {
    try {
      abortSignal?.throwIfAborted();
      if (request.action === "disconnect") {
        let providerRevocation: "revoked" | "not_supported" | "unconfirmed" = "unconfirmed";
        // Only the old exact token leaves this request. The current revoked
        // generation is checked immediately before dispatch; a provider call
        // and a concurrent OAuth reconnect cannot share a SQL transaction.
        if (admitted.providerToken && await mayRevokeSalesforceNativeProviderToken(authority, admitted.intent)) {
          try { providerRevocation = await revokeOAuthAccess("salesforce", admitted.providerToken) ? "revoked" : "not_supported"; }
          catch { /* Local revocation is durable; provider acknowledgement is unknown. */ }
        }
        await settleSalesforceNativeAction(authority, admitted.intent, { action: "disconnect", status: "local_revoked", providerRevocation, settledAt: new Date().toISOString() });
      } else {
        if (!admitted.claim) throw new Error("The admitted Salesforce action has no exact lease.");
        const native = salesforceNativeSyncExecution(authority, admitted.intent, admitted.claim), legacy = salesforceNativeLegacyAuthority(authority);
        if (request.action === "sync") {
          const observed = await syncSalesforceWorkspace({ authority: legacy, native, abortSignal, maxPages: 8 });
          if (observed.status === "busy" || !observed.projection) throw new Error("The admitted Salesforce sync did not produce an exact outcome.");
          await settleSalesforceNativeAction(authority, admitted.intent, { action: "sync", status: observed.status, pages: observed.pages, records: observed.records,
            advanced: observed.advanced, conflicts: observed.conflicts, projection: observed.projection, settledAt: new Date().toISOString() });
        } else {
          const observed = await reconcileSalesforceWorkspace({ authority: legacy, native, abortSignal, limit: 25 });
          if (observed.status !== "complete") throw new Error("The admitted Salesforce reconciliation did not produce an exact outcome.");
          await settleSalesforceNativeAction(authority, admitted.intent, { action: "reconcile", status: "complete", checked: observed.checked, findings: observed.findings, settledAt: new Date().toISOString() });
        }
      }
    } catch { /* Never repeat an admitted intent. Its exact GET retains uncertainty. */ }
  }
  const result = await readSalesforceNativeAction({ scope: authority.scope }, admitted.intent.idempotencyKeySha256, context.canWrite);
  if (!result.action) throw new SalesforceNativeError("salesforce_action_unconfirmed", 503, "The accepted Salesforce receipt is currently unavailable.");
  const completed = completeAppServiceCall(authorized, { contract: SALESFORCE_NATIVE_READ_CONTRACT, context, ...result, action: result.action,
    replayed: !admitted.newlyAccepted }, { resourceCount: 1 });
  const response = nativeSalesforceActionSubmitResponseSchema.parse({ ...completed.data, serviceReceipt: completed.receipt });
  assertNativeSalesforceResponseScope(response, { scope: authority.scope, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, idempotencyKey: caller.idempotencyKey, request });
  return completed;
}
