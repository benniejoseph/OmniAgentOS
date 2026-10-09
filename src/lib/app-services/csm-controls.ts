import "server-only";
import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller, type AppServiceResult } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { csmProfilePatchSchema, csmSourceDeleteSchema, csmSourceWriteSchema } from "@/lib/csm/contracts";
import { csmRolePatchSchema } from "@/lib/csm/role-contracts";
import { linkCsmRoleSource, patchCsmRoleText, showCsmRoleContext, unlinkCsmRoleSource } from "@/lib/csm/role-service";
import { linkCsmSource, listCsmClients, patchCsmProfile, showCsmProject, unlinkCsmSource } from "@/lib/csm/service";

const emptySchema = z.object({}).strict();
const projectId = z.string().trim().min(1).max(200);
const clientShowSchema = z.object({ projectId }).strict();
const clientUpdateSchema = csmProfilePatchSchema.extend({ projectId });
const sourceLinkSchema = csmSourceWriteSchema.extend({
  versionId: z.string().trim().min(1).max(320),
  contentSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const clientSourceLinkSchema = sourceLinkSchema.extend({ projectId });
const clientSourceUnlinkSchema = csmSourceDeleteSchema.extend({ projectId });

export async function listCsmClientsService(caller: AppServiceCaller, input: unknown) {
  emptySchema.parse(input);
  return invoke(caller, "app.csm.clients.list", () => listCsmClients(caller));
}
export async function showCsmClientService(caller: AppServiceCaller, input: unknown) {
  const value = clientShowSchema.parse(input);
  return invoke(caller, "app.csm.clients.show", () => showCsmProject(caller, value.projectId));
}
export async function updateCsmClientService(caller: AppServiceCaller, input: unknown) {
  const { projectId, ...value } = clientUpdateSchema.parse(input);
  return invoke(caller, "app.csm.clients.update", () => patchCsmProfile(caller, projectId, value));
}
export async function showCsmRoleService(caller: AppServiceCaller, input: unknown) {
  emptySchema.parse(input);
  return invoke(caller, "app.csm.role.show", () => showCsmRoleContext(caller));
}
export async function updateCsmRoleService(caller: AppServiceCaller, input: unknown) {
  const value = csmRolePatchSchema.parse(input);
  return invoke(caller, "app.csm.role.update", () => patchCsmRoleText(caller, value));
}
export async function linkCsmClientSourceService(caller: AppServiceCaller, input: unknown) {
  const { projectId, ...value } = clientSourceLinkSchema.parse(input);
  return invoke(caller, "app.csm.clients.sources.link", () => linkCsmSource(caller, projectId, value));
}
export async function unlinkCsmClientSourceService(caller: AppServiceCaller, input: unknown) {
  const { projectId, ...value } = clientSourceUnlinkSchema.parse(input);
  return invoke(caller, "app.csm.clients.sources.unlink", () => unlinkCsmSource(caller, projectId, value));
}
export async function linkCsmRoleSourceService(caller: AppServiceCaller, input: unknown) {
  const value = sourceLinkSchema.parse(input);
  return invoke(caller, "app.csm.role.sources.link", () => linkCsmRoleSource(caller, value));
}
export async function unlinkCsmRoleSourceService(caller: AppServiceCaller, input: unknown) {
  const value = csmSourceDeleteSchema.parse(input);
  return invoke(caller, "app.csm.role.sources.unlink", () => unlinkCsmRoleSource(caller, value));
}

async function invoke<T>(caller: AppServiceCaller, operation: Parameters<typeof getAppServiceOperationContract>[0], service: () => Promise<AppServiceResult<T>>) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract(operation));
  const result = await service();
  return completeAppServiceCall(authorized, result.data, { resourceCount: result.receipt.resourceCount });
}
