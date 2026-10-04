import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { CustomerAccountWriteDeniedError } from "@/lib/app-services/customer-accounts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { CustomerAccountNotFoundError } from "@/lib/customer-success/store";
import { CUSTOMER_FACT_NATIVE_READ_CONTRACT, customerFactNativeAccountIdSchema, customerFactNativeRequestSchema } from "@/lib/customer-success/fact-mutation-contracts";
import { readCustomerFactNativeAcceptance, submitCustomerFactNativeMutation } from "@/lib/customer-success/fact-native-store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { requestSharedMemoryAccessFromSecurityContext } from "@/lib/memory/shared-context";
import { nativeCustomerFactAcceptanceReadQuerySchema, nativeCustomerFactAcceptanceReadResponseForScopeSchema,
  nativeCustomerFactMutationResponseForScopeSchema } from "@/lib/mobile/customer-fact-mutation-contracts";
import { createExecutionScope } from "@/lib/security/execution-scope";

export const customerFactNativeServiceInputSchema = customerFactNativeRequestSchema.safeExtend({ accountId: customerFactNativeAccountIdSchema });
export const customerFactNativeAcceptanceReadServiceInputSchema = nativeCustomerFactAcceptanceReadQuerySchema.extend({
  accountId: customerFactNativeAccountIdSchema, keySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
async function accessFor(caller: AppServiceCaller, workspaceId: string, accountId: string, mutation: boolean) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context), scope = caller.executionScope;
  if (!canonical || (mutation ? !scope || !caller.idempotencyKey || scope.tenantId !== caller.context.tenantId ||
    scope.initiatingActorId !== caller.context.actorId || scope.executingPrincipalType !== "user" || scope.executingPrincipalId !== caller.context.actorId ||
    scope.workspaceId !== workspaceId || scope.projectId !== null || scope.missionId !== null || scope.delegationId !== null ||
    scope.contextGrantIds.length || scope.capabilityGrantIds.length || scope.causationId !== accountId || scope.purpose !== "api.customer-account.fact.record"
    : scope !== undefined || caller.idempotencyKey !== undefined)) throw new CustomerAccountWriteDeniedError();
  const access = await requestSharedMemoryAccessFromSecurityContext(caller.context, { scope: "workspace", workspaceId,
    correlationId: scope?.correlationId ?? crypto.randomUUID(), purposeId: mutation ? MEMORY_PURPOSE_IDS.write : MEMORY_PURPOSE_IDS.read,
    auditPurpose: mutation ? "Record an exact manual Account fact." : "Read an exact manual Account fact acceptance." });
  if (access.actorBinding.canonicalActorId !== canonical.actorId || access.authority.workspaceId !== workspaceId ||
    access.authority.initiatingActorId !== canonical.actorId || (mutation && !access.authority.canWrite)) throw new CustomerAccountWriteDeniedError();
  return { access, canonicalActorId: canonical.actorId,
    context: { scope: "workspace" as const, workspaceId, accessLevel: access.authority.accessLevel, canWrite: access.authority.canWrite,
      authoritySha256: access.authority.authoritySha256 } };
}
export async function recordCustomerFactNativeService(caller: AppServiceCaller, input: z.input<typeof customerFactNativeServiceInputSchema>) {
  const { accountId, ...request } = customerFactNativeServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.facts.record"));
  const { canonicalActorId, context } = await accessFor(caller, request.workspaceId, accountId, true), source = caller.executionScope!;
  const result = await submitCustomerFactNativeMutation({ accountId, request, authority: {
    tenantId: caller.context.tenantId, workspaceId: request.workspaceId, canonicalActorId, readableActorIds: [canonicalActorId],
    purposeId: "customer_success.account.manage", idempotencyKey: caller.idempotencyKey!, executionScope: createExecutionScope({
      tenantId: caller.context.tenantId, workspaceId: request.workspaceId, initiatingActorId: canonicalActorId,
      executingPrincipalType: "user", executingPrincipalId: canonicalActorId, correlationId: source.correlationId,
      causationId: accountId, purpose: "customer.account.fact.record",
    }),
  } });
  const completed = completeAppServiceCall(authorized, { contract: CUSTOMER_FACT_NATIVE_READ_CONTRACT, context, ...result }, { resourceCount: 1 });
  nativeCustomerFactMutationResponseForScopeSchema({ tenantId: caller.context.tenantId, workspaceId: request.workspaceId, canonicalActorId,
    requestActorId: caller.context.actorId, role: caller.context.role, accountId, request, executionScope: source, idempotencyKey: caller.idempotencyKey!,
  }).parse({ ...completed.data, serviceReceipt: completed.receipt });
  return completed;
}
export async function readCustomerFactNativeAcceptanceService(caller: AppServiceCaller, input: z.input<typeof customerFactNativeAcceptanceReadServiceInputSchema>) {
  const value = customerFactNativeAcceptanceReadServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.customer_accounts.facts.mutations.show"));
  const { canonicalActorId, context } = await accessFor(caller, value.workspaceId, value.accountId, false);
  const result = await readCustomerFactNativeAcceptance({ tenantId: caller.context.tenantId, workspaceId: value.workspaceId,
    canonicalActorId, readableActorIds: [canonicalActorId], purposeId: "customer_success.account.read" }, value);
  if (!result) throw new CustomerAccountNotFoundError();
  const completed = completeAppServiceCall(authorized, { contract: CUSTOMER_FACT_NATIVE_READ_CONTRACT, context, ...result }, { resourceCount: result.acceptance ? 1 : 0 });
  nativeCustomerFactAcceptanceReadResponseForScopeSchema({ ...value, tenantId: caller.context.tenantId, canonicalActorId,
    requestActorId: caller.context.actorId, role: caller.context.role }).parse({ ...completed.data, serviceReceipt: completed.receipt });
  return completed;
}
