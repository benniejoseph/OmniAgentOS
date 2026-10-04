import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import {
  PersonalContextConsentNativeError,
  personalContextConsentNativeRequestSchema,
} from "@/lib/memory/personal-context-consent-native-contracts";
import {
  readPersonalContextConsentNative,
  submitPersonalContextConsentNative,
} from "@/lib/memory/personal-context-consent-store";
import { nativePersonalContextConsentCurrentSchema } from "@/lib/mobile/personal-context-consent-contracts";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import { createExecutionScope } from "@/lib/security/execution-scope";

function authority(caller: AppServiceCaller, mutation = false) {
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (!binding) throw new PersonalContextConsentNativeError("personal_context_consent_authority_invalid", 403,
    "Current authenticated private Memory authority is required.");
  const requestScope = caller.executionScope;
  if (mutation && (!requestScope || requestScope.executingPrincipalType !== "user" ||
    requestScope.executingPrincipalId !== caller.context.actorId || requestScope.initiatingActorId !== caller.context.actorId ||
    requestScope.tenantId !== caller.context.tenantId || requestScope.workspaceId !== null || requestScope.projectId !== null ||
    requestScope.missionId !== null || requestScope.delegationId !== null || requestScope.contextGrantIds.length !== 0 ||
    requestScope.capabilityGrantIds.length !== 0 || requestScope.purpose !== "api.memory.personal-context-consent.native.decide" ||
    requestScope.causationId !== binding.canonicalActorId)) {
    throw new PersonalContextConsentNativeError("personal_context_consent_authority_invalid", 403,
      "A current direct user decision is required to manage personal recall.");
  }
  return {
    tenantId: caller.context.tenantId,
    ownerActorId: binding.canonicalActorId,
    executionScope: createExecutionScope({
      tenantId: caller.context.tenantId,
      initiatingActorId: binding.canonicalActorId,
      executingPrincipalType: "user",
      executingPrincipalId: binding.canonicalActorId,
      correlationId: caller.executionScope?.correlationId || crypto.randomUUID(),
      purpose: mutation ? "memory.personal_context_consent.manage" : "memory.personal_context_consent.read",
    }),
  };
}

function publicCurrent(caller: AppServiceCaller, current: Awaited<ReturnType<typeof readPersonalContextConsentNative>>["current"]) {
  return nativePersonalContextConsentCurrentSchema.parse({
    ...current,
    decisionToken: canPerform(caller.context.role, "write.memory") ? current.decisionToken : null,
  });
}

function scope(current: ReturnType<typeof authority>) {
  return { tenantId: current.tenantId, ownerActorId: current.ownerActorId, visibility: "user_private" as const };
}

export async function inspectPersonalContextConsentService(caller: AppServiceCaller, acceptanceKeySha256?: string) {
  if (acceptanceKeySha256 !== undefined && !/^[a-f0-9]{64}$/.test(acceptanceKeySha256)) {
    throw new PersonalContextConsentNativeError("personal_context_consent_request_invalid", 400,
      "Invalid personal recall decision identifier.");
  }
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(
    acceptanceKeySha256 ? "memory.personal-context-consent.decision.get" : "memory.personal-context-consent.get",
  ));
  const currentAuthority = authority(caller);
  const observed = await readPersonalContextConsentNative(currentAuthority, { acceptanceKeySha256 });
  return completeAppServiceCall(authorized, {
    contract: "asael-personal-context-consent-read:1" as const,
    scope: scope(currentAuthority),
    current: publicCurrent(caller, observed.current),
    acceptance: observed.acceptance,
  }, { resourceCount: 1 });
}

export async function decidePersonalContextConsentService(caller: AppServiceCaller, input: unknown) {
  const request = personalContextConsentNativeRequestSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("memory.personal-context-consent.decide"));
  const currentAuthority = authority(caller, true);
  if (!caller.idempotencyKey) throw new PersonalContextConsentNativeError("personal_context_consent_request_invalid", 400,
    "A valid Idempotency-Key is required.");
  const committed = await submitPersonalContextConsentNative({
    authority: currentAuthority, idempotencyKey: caller.idempotencyKey, request,
  });
  return completeAppServiceCall(authorized, {
    contract: "asael-personal-context-consent-read:1" as const,
    scope: scope(currentAuthority),
    current: publicCurrent(caller, committed.current),
    acceptance: committed.acceptance,
    replayed: !committed.newlyApplied,
  }, { resourceCount: 1 });
}
