import "server-only";
import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { resolveDelegatedWatchReadOwner } from "@/lib/delegation/app-read-authority";
import { createAvailabilityWatch, getAvailabilityWatch, listAvailabilityWatches, stopAvailabilityWatch } from "@/lib/availability-watches/service";

const listSchema = z.object({ limit: z.number().int().min(1).max(100).optional() }).strict();
const identitySchema = z.object({ id: z.string().min(1).max(240) }).strict();
const stopSchema = identitySchema.extend({ expectedRevision: z.number().int().min(1) }).strict();

function owner(caller: AppServiceCaller, mutation = false) {
  const binding = canonicalRequestActorBindingFromSecurityContext(caller.context);
  if (!binding || (mutation && (!caller.executionScope || caller.executionScope.delegationId !== null ||
    caller.executionScope.purpose !== "agent.tool.execute"))) {
    throw new Error("Manage availability watches from your signed-in Asael conversation.");
  }
  return { tenantId: caller.context.tenantId, actorId: binding.canonicalActorId };
}

export async function listAvailabilityWatchesService(caller: AppServiceCaller, input: unknown) {
  const value = listSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.watches.list"));
  const readOwner = caller.executionScope?.delegationId
    ? await resolveDelegatedWatchReadOwner(caller, "app.watches.list") : owner(caller);
  return completeAppServiceCall(authorized, await listAvailabilityWatches({ ...readOwner, ...value }));
}

export async function showAvailabilityWatchService(caller: AppServiceCaller, input: unknown) {
  const value = identitySchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.watches.show"));
  const readOwner = caller.executionScope?.delegationId
    ? await resolveDelegatedWatchReadOwner(caller, "app.watches.show") : owner(caller);
  return completeAppServiceCall(authorized, await getAvailabilityWatch(value.id, readOwner));
}

export async function createAvailabilityWatchService(caller: AppServiceCaller, input: unknown) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.watches.create"));
  return completeAppServiceCall(authorized, await createAvailabilityWatch(input, {
    ...owner(caller, true), requestId: caller.idempotencyKey!,
  }));
}

export async function stopAvailabilityWatchService(caller: AppServiceCaller, input: unknown) {
  const { id, expectedRevision } = stopSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.watches.stop"));
  return completeAppServiceCall(authorized, await stopAvailabilityWatch(id, {
    ...owner(caller, true), expectedRevision, requestId: caller.idempotencyKey!,
  }));
}
