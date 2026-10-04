import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { nativeMemoryDeterministicResourceId, type NativeMemoryDeterministicKind } from "@/lib/memory/deterministic-native-contracts";
import { readNativeMemoryGraphRebuild, readNativeMemoryMaintenanceRun, rebuildNativeMemoryGraph, reviewNativeMemoryGraphRebuild,
  reviewNativeMemoryMaintenance, runNativeMemoryMaintenance } from "@/lib/memory/deterministic-native-store";
import { NativePrivateActionError, privateActionScopeSchema } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation } from "@/lib/memory/private-action-store";
import { memoryDeterministicReadContract, memoryDeterministicResponseForScopeSchema, memoryDeterministicSchemas,
  memoryDeterministicServicePrefix, validateMemoryDeterministicAuthority } from "@/lib/mobile/memory-deterministic-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";

function authority(caller: AppServiceCaller, kind: NativeMemoryDeterministicKind, mutation = false) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical) throw new NativePrivateActionError("private_memory_action_owner", 403, "Current canonical private owner is required.");
  const scope = privateActionScopeSchema.parse({ tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId });
  if (mutation) {
    if (!caller.idempotencyKey) throw new NativePrivateActionError("private_memory_action_key", 400, "An explicit private Memory action key is required.");
    const executionScope = assertNativePrivateActionMutation({ scope, executionScope: caller.executionScope },
      kind === "maintenance" ? "api.memory.maintenance.run" : "api.memory.graph.rebuild", nativeMemoryDeterministicResourceId(scope, kind));
    return { scope, executionScope };
  }
  if (caller.idempotencyKey || caller.executionScope) throw new NativePrivateActionError("private_memory_action_read", 403, "Private Memory inspection requires read-only authority.");
  return { scope };
}
export async function reviewMemoryDeterministicNativeService(caller: AppServiceCaller, kind: NativeMemoryDeterministicKind) {
  const owner = authority(caller, kind), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(`${memoryDeterministicServicePrefix(kind)}.review`));
  const current = await (kind === "maintenance" ? reviewNativeMemoryMaintenance : reviewNativeMemoryGraphRebuild)(owner);
  const review = canPerform(caller.context.role, "write.memory") ? current : { ...current, eligible: false, reason: "write_permission_required" as const, pin: null };
  const result = completeAppServiceCall(authorized, { contract: memoryDeterministicReadContract(kind), scope: owner.scope, review }, { resourceCount: 1 });
  const wire = memoryDeterministicSchemas(kind).ReviewResponse.parse({ ...result.data, serviceReceipt: result.receipt });
  validateMemoryDeterministicAuthority(wire, { scope: owner.scope, kind, requestActorId: caller.context.actorId, role: caller.context.role });
  return result;
}
export async function readMemoryDeterministicNativeService(caller: AppServiceCaller, kind: NativeMemoryDeterministicKind, keySha256: string) {
  const owner = authority(caller, kind), authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(`${memoryDeterministicServicePrefix(kind)}.get`));
  const acceptance = await (kind === "maintenance" ? readNativeMemoryMaintenanceRun : readNativeMemoryGraphRebuild)(owner, keySha256);
  const result = completeAppServiceCall(authorized, { contract: memoryDeterministicReadContract(kind), scope: owner.scope, acceptance }, { resourceCount: acceptance ? 1 : 0 });
  const wire = memoryDeterministicSchemas(kind).ReadResponse.parse({ ...result.data, serviceReceipt: result.receipt });
  validateMemoryDeterministicAuthority(wire, { scope: owner.scope, kind, requestActorId: caller.context.actorId, role: caller.context.role });
  if (wire.acceptance && wire.acceptance.keySha256 !== keySha256) throw new Error("Private Memory exact read returned another key.");
  return result;
}
export async function submitMemoryDeterministicNativeService(caller: AppServiceCaller, kind: NativeMemoryDeterministicKind, body: unknown) {
  const owner = authority(caller, kind, true), request = memoryDeterministicSchemas(kind).Request.parse(body);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(`${memoryDeterministicServicePrefix(kind)}.run`));
  const committed = await (kind === "maintenance" ? runNativeMemoryMaintenance : rebuildNativeMemoryGraph)({ authority: owner, request, idempotencyKey: caller.idempotencyKey! });
  const result = completeAppServiceCall(authorized, { contract: memoryDeterministicReadContract(kind), scope: owner.scope, ...committed }, { resourceCount: 1 });
  memoryDeterministicResponseForScopeSchema({ scope: owner.scope, kind, requestActorId: caller.context.actorId, role: caller.context.role,
    executionScope: caller.executionScope, request, idempotencyKey: caller.idempotencyKey! }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
