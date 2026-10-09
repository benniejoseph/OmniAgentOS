import "server-only";
import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { personalProfilePatchSchema } from "@/lib/personal-context/contracts";
import { patchPersonalProfile, PersonalProfileError, readPersonalProfile } from "@/lib/personal-context/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

const showSchema = z.object({}).strict();

export async function showPersonalProfileService(caller: AppServiceCaller, input: unknown) {
  showSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.personal_profile.show"));
  return completeAppServiceCall(authorized, await readPersonalProfile(profileOwner(caller)));
}

export async function updatePersonalProfileService(caller: AppServiceCaller, input: unknown) {
  const value = personalProfilePatchSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.personal_profile.update"));
  const result = await patchPersonalProfile(profileOwner(caller), value, caller.idempotencyKey!);
  return completeAppServiceCall(authorized, result);
}

function profileOwner(caller: AppServiceCaller) {
  const context = caller.context;
  const scope = caller.executionScope;
  const requestActorBinding = canonicalRequestActorBindingFromSecurityContext(context);
  if ((context.source !== "session" && context.source !== "mobile") || !requestActorBinding ||
    !scope || scope.delegationId !== null || scope.purpose !== "agent.tool.execute") {
    throw new PersonalProfileError("About me is available only in your signed-in conversation.", 403, "personal_profile_owner_required");
  }
  return { tenantId: context.tenantId, actorId: context.actorId, requestActorBinding };
}
