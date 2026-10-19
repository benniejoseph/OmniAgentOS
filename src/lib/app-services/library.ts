import { appServiceActorBinding, appServiceReadActorId } from "@/lib/app-services/contracts";
import { z } from "zod";
import {
  authorizeAppServiceCall,
  completeAppServiceCall,
  type AppServiceCaller,
} from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { workspaceLibraryKindSchema } from "@/lib/library/contracts";
import { libraryContentPageRequestSchema, LibraryContentPageError, readLibraryContentPage } from "@/lib/library/content-page";
import {
  getWorkspaceLibraryItem,
  listWorkspaceLibrary,
} from "@/lib/library/store";

export const workspaceLibraryListServiceInputSchema = z.object({
  query: z.string().trim().max(240).default(""),
  kinds: z.array(workspaceLibraryKindSchema).max(20).default([]),
  projectId: z.string().trim().min(1).max(320).optional(),
  limit: z.number().int().min(1).max(100).default(60),
  offset: z.number().int().min(0).max(10_000).default(0),
}).strict();

export const workspaceLibraryShowServiceInputSchema = z.object({
  libraryItemId: z.string().trim().min(1).max(320),
  contentPage: libraryContentPageRequestSchema.optional(),
}).strict();

export async function listWorkspaceLibraryService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceLibraryListServiceInputSchema>,
) {
  const value = workspaceLibraryListServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.library.list"),
  );
  const result = await listWorkspaceLibrary({
    tenantId: caller.context.tenantId,
    actorId: appServiceReadActorId(caller),
    requestActorBinding:
      appServiceActorBinding(caller),
    query: value.query,
    kinds: value.kinds,
    projectId: value.projectId,
    limit: value.limit,
    offset: value.offset,
  });
  return completeAppServiceCall(authorized, result, {
    resourceCount: result.items.length,
  });
}

export async function showWorkspaceLibraryItemService(
  caller: AppServiceCaller,
  input: z.input<typeof workspaceLibraryShowServiceInputSchema>,
) {
  const value = workspaceLibraryShowServiceInputSchema.parse(input);
  const authorized = authorizeAppServiceCall(
    caller,
    getAppServiceOperationContract("app.library.show"),
  );
  const item = await getWorkspaceLibraryItem({
    tenantId: caller.context.tenantId,
    actorId: appServiceReadActorId(caller),
    requestActorBinding:
      appServiceActorBinding(caller),
    libraryItemId: value.libraryItemId,
  });
  if (value.contentPage && !item) {
    throw new LibraryContentPageError("library_content_unavailable", "The requested file is not currently readable by this account.");
  }
  const contentPage = value.contentPage && item
    ? await readLibraryContentPage({ context: caller.context, item, request: value.contentPage })
    : undefined;
  return completeAppServiceCall(authorized, { item, ...(contentPage ? { contentPage } : {}) }, {
    resourceCount: item ? 1 : 0,
  });
}
