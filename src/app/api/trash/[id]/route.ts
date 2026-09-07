import {
  listTrashReceiptsService,
  showTrashService,
} from "@/lib/app-services/trash";
import { createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id: trashId } = await context.params;
  let auth;
  try {
    auth = await authorizeRequest({
      request,
      action: "read",
      resourceType: "trash_item",
      resourceId: trashId,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const caller = createRequestMutationAppServiceCaller(request, auth, {
    purpose: "trash.show",
    causationId: trashId,
  });
  try {
    const [itemResult, receiptResult] = await Promise.all([
      showTrashService(caller, { trashId }),
      listTrashReceiptsService(caller, { trashId, limit: 100 }),
    ]);
    return itemResult.data.item
      ? Response.json({
          item: itemResult.data.item,
          receipts: receiptResult.data.receipts,
          serviceReceipt: itemResult.receipt,
        }, { headers: { "cache-control": "private, no-store" } })
      : Response.json(
          { error: "Trash item not found." },
          { status: 404, headers: { "cache-control": "private, no-store" } },
        );
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Trash item could not be read." },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
}
