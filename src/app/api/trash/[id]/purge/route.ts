import {
  previewTrashPurgeService,
  purgeTrashService,
} from "@/lib/app-services/trash";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: trashId } = await context.params;
  const authorized = await authorizeTrash(request, trashId, "purge_preview");
  if (authorized instanceof Response) return authorized;
  try {
    const result = await previewTrashPurgeService(
      createRequestMutationAppServiceCaller(request, authorized, {
        purpose: "trash.purge.preview",
        causationId: trashId,
      }),
      { trashId },
    );
    return result.data.item
      ? Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: { "cache-control": "private, no-store" } })
      : Response.json({ error: "Trash item not found." }, { status: 404 });
  } catch (error) {
    return forbiddenResponse(error);
  }
}

async function DELETEHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: trashId } = await context.params;
  const authorized = await authorizeTrash(request, trashId, "purge");
  if (authorized instanceof Response) return authorized;
  let body: unknown;
  try { body = await parseJsonBody(request, 16_000); } catch (error) { return jsonBodyErrorResponse(error); }
  try {
    const result = await purgeTrashService(
      createRequestMutationAppServiceCaller(request, authorized, {
        purpose: "trash.purge",
        causationId: trashId,
      }),
      body as never,
    );
    return result.data.trash.trashId === trashId
      ? Response.json({ ...result.data, serviceReceipt: result.receipt })
      : Response.json({ error: "Purge preview targets a different trash item." }, { status: 409 });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Trash item could not be purged." },
      { status: 409 },
    );
  }
}

async function authorizeTrash(
  request: Request,
  trashId: string,
  operation: string,
) {
  try {
    return await authorizeRequest({
      request,
      action: "manage.workflow",
      resourceType: "trash_item",
      resourceId: trashId,
      metadata: { operation },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
}
