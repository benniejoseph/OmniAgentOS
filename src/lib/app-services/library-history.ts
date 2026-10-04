import { z } from "zod";
import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "./contracts";
import { getAppServiceOperationContract } from "./registry";
import { libraryHistoryItemIdSchema, libraryHistoryListQuerySchema, libraryHistoryReadQuerySchema, libraryHistoryVersionIdSchema } from "@/lib/library/history-contracts";
import { getWorkspaceLibraryVersion, listWorkspaceLibraryVersions } from "@/lib/library/history-store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";

export const libraryHistoryListInputSchema = z.object({ libraryItemId: libraryHistoryItemIdSchema, query: libraryHistoryListQuerySchema.default({ limit: 40 }) }).strict();
export const libraryHistoryReadInputSchema = z.object({ libraryItemId: libraryHistoryItemIdSchema, versionId: libraryHistoryVersionIdSchema, query: libraryHistoryReadQuerySchema.default({}) }).strict();
function owner(caller: AppServiceCaller, libraryItemId: string) {
  return { tenantId: caller.context.tenantId, actorId: caller.context.actorId, libraryItemId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(caller.context) };
}
export async function listWorkspaceLibraryVersionsService(caller: AppServiceCaller, input: z.input<typeof libraryHistoryListInputSchema>) {
  const value = libraryHistoryListInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.library.versions.list"));
  const data = await listWorkspaceLibraryVersions(owner(caller, value.libraryItemId), value.query);
  return completeAppServiceCall(authorized, data, { resourceCount: data.versions.length });
}
export async function showWorkspaceLibraryVersionService(caller: AppServiceCaller, input: z.input<typeof libraryHistoryReadInputSchema>) {
  const value = libraryHistoryReadInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.library.versions.show"));
  const data = await getWorkspaceLibraryVersion({ ...owner(caller, value.libraryItemId), versionId: value.versionId }, value.query);
  return completeAppServiceCall(authorized, data, { resourceCount: 1 });
}
